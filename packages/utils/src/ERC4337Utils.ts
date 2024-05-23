import {
  defaultAbiCoder,
  hexConcat, hexDataLength,
  hexDataSlice,
  hexlify,
  hexZeroPad,
  keccak256,
  resolveProperties,
  arrayify
} from 'ethers/lib/utils'
import { abi as entryPointAbi } from '@account-abstraction/contracts/artifacts/IEntryPoint.json'

import { BigNumber, BigNumberish, BytesLike, ethers, Wallet, Signer, Contract } from 'ethers'
import Debug from 'debug'
import { PackedUserOperation } from './Utils'
import { EntryPoint } from './types'

const debug = Debug('aa.utils')

// UserOperation is the first parameter of getUserOpHash
const getUserOpHashMethod = 'getUserOpHash'
const PackedUserOpType = entryPointAbi.find(entry => entry.name === getUserOpHashMethod)?.inputs[0]
if (PackedUserOpType == null) {
  throw new Error(`unable to find method ${getUserOpHashMethod} in EP ${entryPointAbi.filter(x => x.type === 'function').map(x => x.name).join(',')}`)
}

export const AddressZero = ethers.constants.AddressZero

// reverse "Deferrable" or "PromiseOrValue" fields
export type NotPromise<T> = {
  [P in keyof T]: Exclude<T[P], Promise<any>>
}

export interface UserOperation {

  sender: string
  nonce: BigNumberish
  factory?: string
  factoryData?: BytesLike
  initCode?: BytesLike
  callData: BytesLike
  callGasLimit: BigNumberish
  verificationGasLimit: BigNumberish
  preVerificationGas: BigNumberish
  maxFeePerGas: BigNumberish
  maxPriorityFeePerGas: BigNumberish
  paymaster?: string
  paymasterVerificationGasLimit?: BigNumberish
  paymasterPostOpGasLimit?: BigNumberish
  paymasterData?: BytesLike
  signature: BytesLike
}

export const DefaultsForUserOp: UserOperation = {
  sender: AddressZero,
  nonce: 0,
  initCode: '0x',
  callData: '0x',
  callGasLimit: 0,
  verificationGasLimit: 150000, // default verification gas. will add create2 cost (3200+200*length) if initCode exists
  preVerificationGas: 21000, // should also cover calldata cost.
  maxFeePerGas: 0,
  maxPriorityFeePerGas: 1e9,
  paymaster: AddressZero,
  paymasterData: '0x',
  paymasterVerificationGasLimit: 3e5,
  paymasterPostOpGasLimit: 0,
  signature: '0x'
}

// todo: remove this wrapper method?
export function packAccountGasLimits (validationGasLimit: BigNumberish, callGasLimit: BigNumberish): string {
  return packUint(validationGasLimit, callGasLimit)
}

export function unpackAccountGasLimits (accountGasLimits: BytesLike): {
  verificationGasLimit: BigNumber
  callGasLimit: BigNumber
} {
  const [verificationGasLimit, callGasLimit] = unpackUint(accountGasLimits)
  return { verificationGasLimit, callGasLimit }
}

export function packUint (high128: BigNumberish, low128: BigNumberish): string {
  return hexZeroPad(BigNumber.from(high128).shl(128).add(low128).toHexString(), 32)
}

export function unpackUint (packed: BytesLike): [high128: BigNumber, low128: BigNumber] {
  const packedNumber: BigNumber = BigNumber.from(packed)
  return [packedNumber.shr(128), packedNumber.and(BigNumber.from(1).shl(128).sub(1))]
}

export function packPaymasterData (paymaster: string, paymasterVerificationGasLimit: BigNumberish, postOpGasLimit: BigNumberish, paymasterData?: BytesLike): BytesLike {
  return ethers.utils.hexConcat([
    paymaster,
    packUint(paymasterVerificationGasLimit, postOpGasLimit),
    paymasterData ?? '0x'
  ])
}

export interface ValidationData {
  aggregator: string
  validAfter: number
  validUntil: number
}

export const maxUint48 = (2 ** 48) - 1
export const SIG_VALIDATION_FAILED = hexZeroPad('0x01', 20)

/**
 * parse validationData as returned from validateUserOp or validatePaymasterUserOp into ValidationData struct
 * @param validationData
 */
export function parseValidationData (validationData: BigNumberish): ValidationData {
  const data = hexZeroPad(BigNumber.from(validationData).toHexString(), 32)

  // string offsets start from left (msb)
  const aggregator = hexDataSlice(data, 32 - 20)
  let validUntil = parseInt(hexDataSlice(data, 32 - 26, 32 - 20))
  if (validUntil === 0) validUntil = maxUint48
  const validAfter = parseInt(hexDataSlice(data, 0, 6))

  return {
    aggregator,
    validAfter,
    validUntil
  }
}

export function mergeValidationDataValues (accountValidationData: BigNumberish, paymasterValidationData: BigNumberish): ValidationData {
  return mergeValidationData(
    parseValidationData(accountValidationData),
    parseValidationData(paymasterValidationData)
  )
}

/**
 * merge validationData structure returned by paymaster and account
 * @param accountValidationData returned from validateUserOp
 * @param paymasterValidationData returned from validatePaymasterUserOp
 */
export function mergeValidationData (accountValidationData: ValidationData, paymasterValidationData: ValidationData): ValidationData {
  return {
    aggregator: paymasterValidationData.aggregator !== AddressZero ? SIG_VALIDATION_FAILED : accountValidationData.aggregator,
    validAfter: Math.max(accountValidationData.validAfter, paymasterValidationData.validAfter),
    validUntil: Math.min(accountValidationData.validUntil, paymasterValidationData.validUntil)
  }
}

export function packValidationData (validationData: ValidationData): BigNumber {
  return BigNumber.from(validationData.validAfter ?? 0).shl(48)
    .add(validationData.validUntil ?? 0).shl(160)
    .add(validationData.aggregator)
}

export function unpackPaymasterAndData (paymasterAndData: BytesLike): {
  paymaster: string
  paymasterVerificationGas: BigNumber
  postOpGasLimit: BigNumber
  paymasterData: BytesLike
} | null {
  if (paymasterAndData.length <= 2) return null
  if (hexDataLength(paymasterAndData) < 52) {
    // if length is non-zero, then must at least host paymaster address and gas-limits
    throw new Error(`invalid PaymasterAndData: ${paymasterAndData as string}`)
  }
  const [paymasterVerificationGas, postOpGasLimit] = unpackUint(hexDataSlice(paymasterAndData, 20, 52))
  return {
    paymaster: hexDataSlice(paymasterAndData, 0, 20),
    paymasterVerificationGas,
    postOpGasLimit,
    paymasterData: hexDataSlice(paymasterAndData, 52)
  }
}

export function packUserOp (op: UserOperation): PackedUserOperation {
  let paymasterAndData: BytesLike
  if (op.paymaster == null) {
    paymasterAndData = '0x'
  } else {
    if (op.paymasterVerificationGasLimit == null || op.paymasterPostOpGasLimit == null) {
      throw new Error('paymaster with no gas limits')
    }
    paymasterAndData = packPaymasterData(op.paymaster, op.paymasterVerificationGasLimit, op.paymasterPostOpGasLimit, op.paymasterData)
  }
  return {
    sender: op.sender,
    nonce: BigNumber.from(op.nonce).toHexString(),
    initCode: op.factory == null ? '0x' : hexConcat([op.factory, op.factoryData ?? '']),
    callData: op.callData,
    accountGasLimits: packUint(op.verificationGasLimit, op.callGasLimit),
    preVerificationGas: BigNumber.from(op.preVerificationGas).toHexString(),
    gasFees: packUint(op.maxPriorityFeePerGas, op.maxFeePerGas),
    paymasterAndData,
    signature: op.signature
  }
}

export function unpackUserOp (packed: PackedUserOperation): UserOperation {
  const [verificationGasLimit, callGasLimit] = unpackUint(packed.accountGasLimits)
  const [maxPriorityFeePerGas, maxFeePerGas] = unpackUint(packed.gasFees)

  let ret: UserOperation = {
    sender: packed.sender,
    nonce: packed.nonce,
    callData: packed.callData,
    preVerificationGas: packed.preVerificationGas,
    verificationGasLimit,
    callGasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
    signature: packed.signature
  }
  if (packed.initCode != null && packed.initCode.length > 2) {
    const factory = hexDataSlice(packed.initCode, 0, 20)
    const factoryData = hexDataSlice(packed.initCode, 20)
    ret = {
      ...ret,
      factory,
      factoryData
    }
  }
  const pmData = unpackPaymasterAndData(packed.paymasterAndData)
  if (pmData != null) {
    ret = {
      ...ret,
      paymaster: pmData.paymaster,
      paymasterVerificationGasLimit: pmData.paymasterVerificationGas,
      paymasterPostOpGasLimit: pmData.postOpGasLimit,
      paymasterData: pmData.paymasterData
    }
  }
  return ret
}

/**
 * abi-encode the userOperation
 * @param op a PackedUserOp
 * @param forSignature "true" if the hash is needed to calculate the getUserOpHash()
 *  "false" to pack entire UserOp, for calculating the calldata cost of putting it on-chain.
 */
export function encodeUserOp (op1: PackedUserOperation | UserOperation, forSignature = true): string {
  // if "op" is unpacked UserOperation, then pack it first, before we ABI-encode it.
  let op: PackedUserOperation
  if ('callGasLimit' in op1) {
    op = packUserOp(op1)
  } else {
    op = op1
  }
  if (forSignature) {
    return defaultAbiCoder.encode(
      ['address', 'uint256', 'bytes32', 'bytes32',
        'bytes32', 'uint256', 'bytes32',
        'bytes32'],
      [op.sender, op.nonce, keccak256(op.initCode), keccak256(op.callData),
        op.accountGasLimits, op.preVerificationGas, op.gasFees,
        keccak256(op.paymasterAndData)])
  } else {
    // for the purpose of calculating gas cost encode also signature (and no keccak of bytes)
    return defaultAbiCoder.encode(
      ['address', 'uint256', 'bytes', 'bytes',
        'bytes32', 'uint256', 'bytes32',
        'bytes', 'bytes'],
      [op.sender, op.nonce, op.initCode, op.callData,
        op.accountGasLimits, op.preVerificationGas, op.gasFees,
        op.paymasterAndData, op.signature])
  }
}

/**
 * calculate the userOpHash of a given userOperation.
 * The userOpHash is a hash of all UserOperation fields, except the "signature" field.
 * The entryPoint uses this value in the emitted UserOperationEvent.
 * A wallet may use this value as the hash to sign (the SampleWallet uses this method)
 * @param op
 * @param entryPoint
 * @param chainId
 */
export function getUserOpHash (op: UserOperation, entryPoint: string, chainId: number): string {
  const userOpHash = keccak256(encodeUserOp(op, true))
  const enc = defaultAbiCoder.encode(
    ['bytes32', 'address', 'uint256'],
    [userOpHash, entryPoint, chainId])
  return keccak256(enc)
}

const ErrorSig = keccak256(Buffer.from('Error(string)')).slice(0, 10) // 0x08c379a0
const FailedOpSig = keccak256(Buffer.from('FailedOp(uint256,string)')).slice(0, 10) // 0x220266b6

interface DecodedError {
  message: string
  opIndex?: number
}

/**
 * decode bytes thrown by revert as Error(message) or FailedOp(opIndex,paymaster,message)
 */
export function decodeErrorReason (error: string | Error): DecodedError | undefined {
  if (typeof error !== 'string') {
    const err = error as any
    error = (err.data ?? err.error.data) as string
  }

  debug('decoding', error)
  if (error.startsWith(ErrorSig)) {
    const [message] = defaultAbiCoder.decode(['string'], '0x' + error.substring(10))
    return { message }
  } else if (error.startsWith(FailedOpSig)) {
    let [opIndex, message] = defaultAbiCoder.decode(['uint256', 'string'], '0x' + error.substring(10))
    message = `FailedOp: ${message as string}`
    return {
      message,
      opIndex
    }
  }
}

/**
 * update thrown Error object with our custom FailedOp message, and re-throw it.
 * updated both "message" and inner encoded "data"
 * tested on geth, hardhat-node
 * usage: entryPoint.handleOps().catch(decodeError)
 */
export function rethrowError (e: any): any {
  let error = e
  let parent = e
  if (error?.error != null) {
    error = error.error
  }
  while (error?.data != null) {
    parent = error
    error = error.data
  }
  const decoded = typeof error === 'string' && error.length > 2 ? decodeErrorReason(error) : undefined
  if (decoded != null) {
    e.message = decoded.message

    if (decoded.opIndex != null) {
      // helper for chai: convert our FailedOp error into "Error(msg)"
      const errorWithMsg = hexConcat([ErrorSig, defaultAbiCoder.encode(['string'], [decoded.message])])
      // modify in-place the error object:
      parent.data = errorWithMsg
    }
  }
  throw e
}

/**
 * hexlify all members of object, recursively
 * @param obj
 */
export function deepHexlify (obj: any): any {
  if (typeof obj === 'function') {
    return undefined
  }
  if (obj == null || typeof obj === 'string' || typeof obj === 'boolean') {
    return obj
  } else if (obj._isBigNumber != null || typeof obj !== 'object') {
    return hexlify(obj).replace(/^0x0/, '0x')
  }
  if (Array.isArray(obj)) {
    return obj.map(member => deepHexlify(member))
  }
  return Object.keys(obj)
    .reduce((set, key) => ({
      ...set,
      [key]: deepHexlify(obj[key])
    }), {})
}

// resolve all property and hexlify.
// (UserOpMethodHandler receives data from the network, so we need to pack our generated values)
export async function resolveHexlify (a: any): Promise<any> {
  return deepHexlify(await resolveProperties(a))
}

export function fillUserOpDefaults (op: Partial<UserOperation>, defaults = DefaultsForUserOp): UserOperation {
  const partial: any = { ...op }
  // we want "item:undefined" to be used from defaults, and not override defaults, so we must explicitly
  // remove those so "merge" will succeed.
  for (const key in partial) {
    if (partial[key] == null) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete partial[key]
    }
  }
  const filled = { ...defaults, ...partial }
  return filled
}

// helper to fill structure:
// - default callGasLimit to estimate call from entryPoint to account (TODO: add overhead)
// if there is initCode:
//  - calculate sender by eth_call the deployment code
//  - default verificationGasLimit estimateGas of deployment code plus default 100000
// no initCode:
//  - update nonce from account.getNonce()
// entryPoint param is only required to fill in "sender address when specifying "initCode"
// nonce: assume contract as "getNonce()" function, and fill in.
// sender - only in case of construction: fill sender from initCode.
// callGasLimit: VERY crude estimation (by estimating call to account, and add rough entryPoint overhead
// verificationGasLimit: hard-code default at 100k. should add "create2" cost
export async function fillUserOp (op: Partial<UserOperation>, entryPoint?: EntryPoint, getNonceFunction = 'getNonce'): Promise<UserOperation> {
  const op1 = { ...op }
  const provider = entryPoint?.provider
  if (op.initCode != null) {
    const initAddr = hexDataSlice(op1.initCode!, 0, 20)
    const initCallData = hexDataSlice(op1.initCode!, 20)
    if (op1.nonce == null) op1.nonce = 0
    if (op1.sender == null) {
      // hack: if the init contract is our known deployer, then we know what the address would be, without a view call
      if (provider == null) throw new Error('no entrypoint/provider')
      op1.sender = await entryPoint!.callStatic.getSenderAddress(op1.initCode!).catch(e => e.errorArgs.sender)
    }
    if (op1.verificationGasLimit == null) {
      if (provider == null) throw new Error('no entrypoint/provider')
      const initEstimate = await provider.estimateGas({
        from: entryPoint?.address,
        to: initAddr,
        data: initCallData,
        gasLimit: 10e6
      })
      op1.verificationGasLimit = BigNumber.from(DefaultsForUserOp.verificationGasLimit).add(initEstimate)
    }
  }
  if (op1.nonce == null) {
    if (provider == null) throw new Error('must have entryPoint to autofill nonce')
    const c = new Contract(op.sender!, [`function ${getNonceFunction}() view returns(uint256)`], provider)
    op1.nonce = await c[getNonceFunction]().catch((e: any) => rethrowError(e))
  }
  if (op1.callGasLimit == null && op.callData != null) {
    if (provider == null) throw new Error('must have entryPoint for callGasLimit estimate')
    const gasEtimated = await provider.estimateGas({
      from: entryPoint?.address,
      to: op1.sender,
      data: op1.callData
    })

    // console.log('estim', op1.sender,'len=', op1.callData!.length, 'res=', gasEtimated)
    // estimateGas assumes direct call from entryPoint. add wrapper cost.
    op1.callGasLimit = gasEtimated // .add(55000)
  }
  if (op1.paymaster != null) {
    if (op1.paymasterVerificationGasLimit == null) {
      op1.paymasterVerificationGasLimit = DefaultsForUserOp.paymasterVerificationGasLimit
    }
    if (op1.paymasterPostOpGasLimit == null) {
      op1.paymasterPostOpGasLimit = DefaultsForUserOp.paymasterPostOpGasLimit
    }
  }
  if (op1.maxFeePerGas == null) {
    if (provider == null) throw new Error('must have entryPoint to autofill maxFeePerGas')
    const block = await provider.getBlock('latest')
    op1.maxFeePerGas = block.baseFeePerGas!.add(op1.maxPriorityFeePerGas ?? DefaultsForUserOp.maxPriorityFeePerGas)
  }
  // TODO: this is exactly what fillUserOp below should do - but it doesn't.
  // adding this manually
  if (op1.maxPriorityFeePerGas == null) {
    op1.maxPriorityFeePerGas = DefaultsForUserOp.maxPriorityFeePerGas
  }
  const op2 = fillUserOpDefaults(op1)
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  if (op2.preVerificationGas.toString() === '0') {
    // TODO: we don't add overhead, which is ~21000 for a single TX, but much lower in a batch.
    op2.preVerificationGas = callDataCost(encodeUserOp(op2, false))
  }
  return op2
}

export async function fillAndPack (op: Partial<UserOperation>, entryPoint?: EntryPoint, getNonceFunction = 'getNonce'): Promise<PackedUserOperation> {
  return packUserOp(await fillUserOp(op, entryPoint, getNonceFunction))
}

export async function fillAndSign (op: Partial<UserOperation>, signer: Wallet | Signer, entryPoint?: EntryPoint, getNonceFunction = 'getNonce'): Promise<UserOperation> {
  // eslint-disable-next-line no-useless-catch
  try {
    const provider = entryPoint!.provider
    const op2 = await fillUserOp(op, entryPoint, getNonceFunction)

    const chainId = await provider.getNetwork().then(net => net.chainId)
    const message = arrayify(getUserOpHash(op2, entryPoint!.address, chainId))

    let signature
    try {
      signature = await signer.signMessage(message)
    } catch (err: any) {
      // attempt to use 'eth_sign' instead of 'personal_sign' which is not supported by Foundry Anvil
      signature = await (signer as any)._legacySignMessage(message)
    }
    return {
      ...op2,
      signature
    }
  } catch (err) {
    throw err
  }
}

export async function fillSignAndPack (op: Partial<UserOperation>, signer: Wallet | Signer, entryPoint?: EntryPoint, getNonceFunction = 'getNonce'): Promise<PackedUserOperation> {
  const filledAndSignedOp = await fillAndSign(op, signer, entryPoint, getNonceFunction)
  return packUserOp(filledAndSignedOp)
}

export function callDataCost (data: string): number {
  return ethers.utils.arrayify(data)
    .map(x => x === 0 ? 4 : 16)
    .reduce((sum, x) => sum + x)
}
