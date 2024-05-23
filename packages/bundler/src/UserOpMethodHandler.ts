import {BigNumber, BigNumberish, Signer} from 'ethers'
import {JsonRpcProvider, Log, Provider} from '@ethersproject/providers'

import {BundlerConfig} from './BundlerConfig'
import {
  AddressZero,
  decodeRevertReason,
  decodeSimulateHandleOpResult,
  deepHexlify,
  erc4337RuntimeVersion,
  getUserOpHash,
  IEntryPoint,
  mergeValidationDataValues,
  PackedUserOperation,
  packUserOp,
  requireAddressAndFields,
  requireCond,
  RpcError,
  simulationRpcParams,
  tostr,
  unpackUserOp,
  UserOperation,
  UserOperationEventEvent,
  ValidationErrors,
  VerifyingPaymaster
} from 'account-abstraction-phuoc-test/utils'
import {ExecutionManager} from './modules/ExecutionManager'
import {UserOperationByHashResponse, UserOperationReceipt} from './RpcTypes'
import {calcPreVerificationGas} from 'account-abstraction-phuoc-test/sdk'
import {EventFragment} from '@ethersproject/abi'
import {arrayify, defaultAbiCoder, hexConcat} from 'ethers/lib/utils'

const HEX_REGEX = /^0x[a-fA-F\d]*$/i

/**
 * return value from estimateUserOpGas
 */
export interface EstimateUserOpGasResult {
  /**
   * the preVerification gas used by this UserOperation.
   */
  preVerificationGas: BigNumberish
  /**
   * gas used for validation of this UserOperation, including account creation
   */
  verificationGasLimit: BigNumberish

  /**
   * (possibly future timestamp) after which this UserOperation is valid
   */
  validAfter?: BigNumberish

  /**
   * the deadline after which this UserOperation is invalid (not a gas estimation parameter, but returned by validation
   */
  validUntil?: BigNumberish
  /**
   * estimated cost of calling the account with the given callData
   */
  callGasLimit: BigNumberish
}

export class UserOpMethodHandler {
  constructor (
    readonly execManager: ExecutionManager,
    readonly provider: Provider,
    readonly signer: Signer,
    readonly config: BundlerConfig,
    readonly entryPoint: IEntryPoint,
    readonly paymaster?: VerifyingPaymaster
  ) {
  }

  async getSupportedEntryPoints (): Promise<string[]> {
    return [this.config.entryPoint]
  }

  async selectBeneficiary (): Promise<string> {
    const currentBalance = await this.provider.getBalance(this.signer.getAddress())
    let beneficiary = this.config.beneficiary
    // below min-balance redeem to the signer, to keep it active.
    if (currentBalance.lte(this.config.minBalance)) {
      beneficiary = await this.signer.getAddress()
      console.log('low balance. using ', beneficiary, 'as beneficiary instead of ', this.config.beneficiary)
    }
    return beneficiary
  }

  async _validateParameters (userOp1: UserOperation, entryPointInput: string, requireSignature = true, requireGasParams = true): Promise<void> {
    requireCond(entryPointInput != null, 'No entryPoint param', -32602)

    if (entryPointInput?.toString().toLowerCase() !== this.config.entryPoint.toLowerCase()) {
      throw new Error(`The EntryPoint at "${entryPointInput}" is not supported. This bundler uses ${this.config.entryPoint}`)
    }
    // minimal sanity check: userOp exists, and all members are hex
    requireCond(userOp1 != null, 'No UserOperation param')
    const userOp = userOp1 as any

    const fields = ['sender', 'nonce', 'callData']
    if (requireSignature) {
      fields.push('signature')
    }
    if (requireGasParams) {
      fields.push('preVerificationGas', 'verificationGasLimit', 'callGasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas')
    }
    fields.forEach(key => {
      requireCond(userOp[key] != null, 'Missing userOp field: ' + key, -32602)
      const value: string = userOp[key].toString()
      requireCond(value.match(HEX_REGEX) != null, `Invalid hex value for property ${key}:${value} in UserOp`, -32602)
    })
    requireAddressAndFields(userOp, 'paymaster', ['paymasterPostOpGasLimit', 'paymasterVerificationGasLimit'], ['paymasterData'])
    requireAddressAndFields(userOp, 'factory', ['factoryData'])
  }

  /**
   * eth_estimateUserOperationGas RPC api.
   * @param userOp1 input userOp (may have gas fields missing, so they can be estimated)
   * @param entryPointInput
   */
  async estimateUserOperationGas (userOp1: Partial<UserOperation>, entryPointInput: string): Promise<EstimateUserOpGasResult> {
    const userOp: UserOperation = {
      // default values for missing fields.
      maxFeePerGas: 0,
      maxPriorityFeePerGas: 0,
      preVerificationGas: 0,
      verificationGasLimit: 10e6,
      ...userOp1
    } as any
    // todo: checks the existence of parameters, but since we hexlify the inputs, it fails to validate
    await this._validateParameters(deepHexlify(userOp), entryPointInput)
    // todo: validation manager duplicate?
    const provider = this.provider as JsonRpcProvider
    const rpcParams = simulationRpcParams('simulateHandleOp', this.entryPoint.address, userOp, [AddressZero, '0x'],
      {
        // allow estimation when account's balance is zero.
        // todo: need a way to flag this, and not enable always.
        // [userOp.sender]: {
        //   balance: hexStripZeros(parseEther('1').toHexString())
        // }
      })
    const ret = await provider.send('eth_call', rpcParams)
      .catch((e: any) => { throw new RpcError(decodeRevertReason(e) as string, ValidationErrors.SimulateValidation) })

    const returnInfo = decodeSimulateHandleOpResult(ret)

    const { validAfter, validUntil } = mergeValidationDataValues(returnInfo.accountValidationData, returnInfo.paymasterValidationData)
    const {
      preOpGas
    } = returnInfo

    // todo: use simulateHandleOp for this too...
    const callGasLimit = await this.provider.estimateGas({
      from: this.entryPoint.address,
      to: userOp.sender,
      data: userOp.callData
    }).then(b => b.toNumber()).catch(err => {
      const message = err.message.match(/reason="(.*?)"/)?.at(1) ?? 'execution reverted'
      throw new RpcError(message, ValidationErrors.UserOperationReverted)
    })

    const preVerificationGas = calcPreVerificationGas(userOp)
    const verificationGasLimit = BigNumber.from(preOpGas).toNumber()
    return {
      preVerificationGas,
      verificationGasLimit,
      validAfter,
      validUntil,
      callGasLimit
    }
  }

  async sendUserOperation (userOp: UserOperation, entryPointInput: string): Promise<string> {
    await this._validateParameters(userOp, entryPointInput)

    console.log(`UserOperation: Sender=${userOp.sender}  Nonce=${tostr(userOp.nonce)} EntryPoint=${entryPointInput} Paymaster=${userOp.paymaster ?? ''}`)
    await this.execManager.sendUserOperation(userOp, entryPointInput)
    return await this.entryPoint.getUserOpHash(packUserOp(userOp))
  }

  async _getUserOperationEvent (userOpHash: string): Promise<UserOperationEventEvent> {
    // TODO: eth_getLogs is throttled. must be acceptable for finding a UserOperation by hash
    const event = await this.entryPoint.queryFilter(this.entryPoint.filters.UserOperationEvent(userOpHash))
    return event[0]
  }

  // filter full bundle logs, and leave only logs for the given userOpHash
  // @param userOpEvent - the event of our UserOp (known to exist in the logs)
  // @param logs - full bundle logs. after each group of logs there is a single UserOperationEvent with unique hash.
  _filterLogs (userOpEvent: UserOperationEventEvent, logs: Log[]): Log[] {
    let startIndex = -1
    let endIndex = -1
    const events = Object.values(this.entryPoint.interface.events)
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const beforeExecutionTopic = this.entryPoint.interface.getEventTopic(events.find((e: EventFragment) => e.name === 'BeforeExecution')!)
    logs.forEach((log, index) => {
      if (log?.topics[0] === beforeExecutionTopic) {
        // all UserOp execution events start after the "BeforeExecution" event.
        startIndex = endIndex = index
      } else if (log?.topics[0] === userOpEvent.topics[0]) {
        // process UserOperationEvent
        if (log.topics[1] === userOpEvent.topics[1]) {
          // it's our userOpHash. save as end of logs array
          endIndex = index
        } else {
          // it's a different hash. remember it as beginning index, but only if we didn't find our end index yet.
          if (endIndex === -1) {
            startIndex = index
          }
        }
      }
    })
    if (endIndex === -1) {
      throw new Error('fatal: no UserOperationEvent in logs')
    }
    return logs.slice(startIndex + 1, endIndex)
  }

  async getUserOperationByHash (userOpHash: string): Promise<UserOperationByHashResponse | null> {
    requireCond(userOpHash?.toString()?.match(HEX_REGEX) != null, 'Missing/invalid userOpHash', -32602)
    const event = await this._getUserOperationEvent(userOpHash)
    if (event == null) {
      return null
    }
    const tx = await event.getTransaction()
    if (tx.to !== this.entryPoint.address) {
      throw new Error('unable to parse transaction')
    }
    const parsed = this.entryPoint.interface.parseTransaction(tx)
    const ops: PackedUserOperation[] = parsed?.args.ops
    if (ops == null) {
      throw new Error('failed to parse transaction')
    }
    const op = ops.find(op =>
      op.sender === event.args.sender &&
      BigNumber.from(op.nonce).eq(event.args.nonce)
    )
    if (op == null) {
      throw new Error('unable to find userOp in transaction')
    }

    return deepHexlify({
      userOperation: unpackUserOp(op),
      entryPoint: this.entryPoint.address,
      transactionHash: tx.hash,
      blockHash: tx.blockHash ?? '',
      blockNumber: tx.blockNumber ?? 0
    })
  }

  async getUserOperationReceipt (userOpHash: string): Promise<UserOperationReceipt | null> {
    requireCond(userOpHash?.toString()?.match(HEX_REGEX) != null, 'Missing/invalid userOpHash', -32602)
    const event = await this._getUserOperationEvent(userOpHash)
    if (event == null) {
      return null
    }
    const receipt = await event.getTransactionReceipt()
    const logs = this._filterLogs(event, receipt.logs)
    return deepHexlify({
      userOpHash,
      sender: event.args.sender,
      nonce: event.args.nonce,
      actualGasCost: event.args.actualGasCost,
      actualGasUsed: event.args.actualGasUsed,
      success: event.args.success,
      logs,
      receipt
    })
  }

  clientVersion (): string {
    // eslint-disable-next-line
    return 'aa-bundler/' + erc4337RuntimeVersion + (this.config.unsafe ? '/unsafe' : '')
  }

  async pmSponsorUserOperation (userOp: UserOperation): Promise<any> {
    if (this.paymaster == null) throw new Error('Paymaster not deploy')
    const MOCK_VALID_UNTIL = '0x00000000deadbeef'
    const MOCK_VALID_AFTER = '0x0000000000001234'

    userOp.paymaster = this.paymaster.address
    const chainId = await this.provider.getNetwork().then(net => net.chainId)

    const message = arrayify(getUserOpHash(userOp, this.entryPoint.address, chainId))
    userOp.signature = await this.signer.signMessage(message)
    console.log('packed user op ne', packUserOp(userOp))

    const hash = await this.paymaster.getHash(
      packUserOp(userOp), MOCK_VALID_UNTIL, MOCK_VALID_AFTER
    )
    const sig = await this.signer.signMessage(arrayify(hash as any))

    return {
      paymaster: this.paymaster.address,
      paymasterVerificationGasLimit: 3e5,
      paymasterPostOpGasLimit: 0,
      paymasterData: hexConcat([defaultAbiCoder.encode(['uint48', 'uint48'], [MOCK_VALID_UNTIL, MOCK_VALID_AFTER]), sig])
    }
  }
}
