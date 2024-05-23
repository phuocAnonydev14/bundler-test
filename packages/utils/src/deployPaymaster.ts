import { JsonRpcProvider } from '@ethersproject/providers'
import { VerifyingPaymaster, VerifyingPaymaster__factory } from './soltypes'
import { DeterministicDeployer } from './DeterministicDeployer'
import { Signer } from 'ethers'

const entryPoint = '0x1581bcE5FC34d62fB8BF240886B9eBdCd20020fd'

export async function deployPaymaster (provider: JsonRpcProvider, signer: Signer): Promise<VerifyingPaymaster> {
  const addr = await new DeterministicDeployer(provider, provider.getSigner()).deterministicDeploy(new VerifyingPaymaster__factory(), 0, [entryPoint, await signer.getAddress()])

  return VerifyingPaymaster__factory.connect(addr, signer)
}
