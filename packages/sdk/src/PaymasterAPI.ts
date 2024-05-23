import { callDataCost, encodeUserOp, fillUserOp, fillUserOpDefaults, UserOperation } from '@account-abstraction/utils'
import { ethers, BigNumberish, BytesLike } from 'ethers'
import { calcPreVerificationGas } from './calcPreVerificationGas'
import { defaultAbiCoder, hexConcat } from 'ethers/lib/utils'

/**
 * returned paymaster parameters.
 * note that if a paymaster is specified, then the gasLimits must be specified
 * (even if postOp is not called, the paymasterPostOpGasLimit must be set to zero)
 */
export interface PaymasterParams {
  paymaster: string
  paymasterData?: BytesLike
  paymasterVerificationGasLimit: BigNumberish
  paymasterPostOpGasLimit: BigNumberish
}

const MOCK_VALID_UNTIL = '0x00000000deadbeef'
const MOCK_VALID_AFTER = '0x0000000000001234'

async function OptoJSON (op: Partial<UserOperation>): Promise<any> {
  const userOp = await ethers.utils.resolveProperties(op)
  return Object.keys(userOp)
    .map((key) => {
      let val = (userOp as any)[key]
      if (typeof val !== 'string' || !val.startsWith('0x')) {
        val = ethers.utils.hexValue(val)
      }
      return [key, val]
    })
    .reduce(
      (set, [k, v]) => ({
        ...set,
        [k]: v
      }),
      {}
    )
}

/**
 * an API to external a UserOperation with paymaster info
 */
export class PaymasterAPI {
  private readonly entryPoint: string
  private readonly paymasterUrl: string

  constructor (entryPoint: string, paymasterUrl: string) {
    this.entryPoint = entryPoint
    this.paymasterUrl = paymasterUrl
  }

  /**
   * return temporary values to put into the paymaster fields.
   * @param userOp the partially-filled UserOperation. Should be filled with tepmorary values for all
   *    fields except paymaster fields.
   * @return temporary paymaster parameters, that can be used for gas estimations
   */
  async getTemporaryPaymasterData (userOp: Partial<UserOperation>): Promise<PaymasterParams | null> {
    return null
  }

  /**
   * after gas estimation, return final paymaster parameters to replace the above tepmorary value.
   * @param userOp a partially-filled UserOperation (without signature and paymasterAndData
   *  note that the "preVerificationGas" is incomplete: it can't account for the
   *  paymasterAndData value, which will only be returned by this method..
   * @returns the values to put into paymaster fields, null to leave them empty
   */
  async getPaymasterData (userOp: Partial<UserOperation>): Promise<PaymasterParams | null> {
    const pmOp: Partial<UserOperation> = {
      ...userOp,
      // Dummy signatures are required in order to calculate a correct preVerificationGas value.
      paymasterData: hexConcat(
        [defaultAbiCoder.encode(['uint48', 'uint48'], [MOCK_VALID_UNTIL, MOCK_VALID_AFTER]), '0x' + '00'.repeat(65)]),
      signature: '0xa15569dd8f8324dbeabf8073fdec36d4b754f53ce5901e283c6de79af177dc94557fa3c9922cd7af2a96ca94402d35c39f266925ee6407aeb32b31d76978d4ba1c',
      paymasterVerificationGasLimit: 3e5,
      paymasterPostOpGasLimit: 0
    }

    const op = fillUserOpDefaults(pmOp)
    op.preVerificationGas = callDataCost(encodeUserOp(op, false))

    // const op = await ethers.utils.resolveProperties(pmOp)
    // op.preVerificationGas = calcPreVerificationGas(op)
    // op.verificationGasLimit = ethers.BigNumber.from(op.verificationGasLimit).mul(3)

    const params = [op, this.entryPoint]
    const provider = new ethers.providers.JsonRpcProvider(this.paymasterUrl)
    const response = await provider.send('pm_sponsorUserOperation', params)

    return response
  }

  async deployPaymaster (): Promise<string> {
    return '1'
  }
}
