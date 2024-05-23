import { ethers, BigNumberish, BigNumber, Contract } from 'ethers'
import { JsonRpcProvider, TransactionRequest } from '@ethersproject/providers'
import { SimpleAccountAPI, PaymasterAPI, HttpRpcClient } from '@account-abstraction/sdk'
import {
  DeterministicDeployer,
  IEntryPoint, IEntryPointSimulations, PackedUserOperation,
  SimpleAccountFactory__factory,
  fillSignAndPack
} from '@account-abstraction/utils'
import { parseEther, hexZeroPad, hexDataSlice } from 'ethers/lib/utils'
import { EntryPoint__factory, EntryPointSimulations__factory } from '@account-abstraction/utils/dist/src/types'
import EntryPointSimulationsJson from '@account-abstraction/contracts/artifacts/EntryPointSimulations.json'
import { IEntryPoint__factory, SimpleAccount__factory } from '../types'
import erc20ABI from "./erc20abi.json"

const MNEMONIC = 'test test test test test test test test test test test junk'
const entryPointAddress = '0x0000000071727De22E5E9d8BAf0edAc6f37da032'
const rpcUrl = 'http://localhost:8545'
const bundlerUrl = 'http://localhost:3000/rpc'
const provider = new JsonRpcProvider(rpcUrl)
const token = '0x5aA74b97C775539256e0C08875c4F6B2109af19E' // Address of the ERC-20 token
const beneficiary = "0xd21934eD8eAf27a67f0A70042Af50A1D6d195E81"
const paymaster = "0x01711D53eC9f165f3242627019c41CcA7028e7A5"

export interface ValidationData {
  aggregator: string
  validAfter: number
  validUntil: number
}

async function main () {
  const paymasterAPI = new PaymasterAPI(entryPointAddress, bundlerUrl)

  const entryPoint = IEntryPoint__factory.connect(entryPointAddress, provider.getSigner())
  const owner = ethers.Wallet.fromMnemonic(MNEMONIC).connect(provider)
  console.log('before', await provider.getBalance(entryPoint.address))
  const signer = await provider.getSigner()
  await signer.sendTransaction({ to: beneficiary, value: parseEther('2') })

  await entryPoint.depositTo(paymaster, { value: parseEther('2') })
  await entryPoint.depositTo(beneficiary, { value: parseEther('2') })
  console.log("paymaster balance before", await entryPoint.balanceOf(paymaster))
  console.log("beneficiary balance before", await provider.getBalance(beneficiary))
  const detDeployer = new DeterministicDeployer(provider)
  const factoryAddress = await detDeployer.deterministicDeploy(new SimpleAccountFactory__factory(), 0, [entryPointAddress])

  await sendErc20(owner, factoryAddress, paymasterAPI)
  await sendNative(owner, factoryAddress, paymasterAPI)

  console.log("paymaster balance after", await entryPoint.balanceOf(paymaster))
  console.log("beneficiary balance after", await provider.getBalance(beneficiary))
}

async function sendNative( owner: ethers.Wallet, factoryAddress: string, paymasterAPI: PaymasterAPI) {
  console.log('--- START SENDING NATIVE TOKEN ---')
  const dest = ethers.Wallet.createRandom()


  const accountAPI = new SimpleAccountAPI({
    provider: provider,
    entryPointAddress: entryPointAddress,
    owner: owner,
    factoryAddress: factoryAddress,
    paymasterAPI: paymasterAPI
  })

  const accountContract = await accountAPI._getAccountContract()
  const signer = await provider.getSigner()

  await signer.sendTransaction({ to: accountContract.address, value: parseEther('1') })

  console.log('account contract balance before', await provider.getBalance(accountContract.address))
  console.log('owner contract balance before', await provider.getBalance(owner.address))
  console.log('dest balance before', await provider.getBalance(dest.address))
  
  const op = await accountAPI.createSignedUserOp({
    target: dest.address,
    data: "0x",
    value: parseEther('0.12')
  })
  
  const chainId = await provider.getNetwork().then(net => net.chainId)
  const client = new HttpRpcClient(bundlerUrl, entryPointAddress, chainId)

  const userOpHash = await client.sendUserOpToBundler(op)

  console.log('Waiting for transaction...')
  const transactionHash = await accountAPI.getUserOpReceipt(userOpHash)
  console.log(`Transaction hash: ${transactionHash}`)

  console.log('account contract balance after', await provider.getBalance(accountContract.address))
  console.log('owner contract balance after', await provider.getBalance(owner.address))
  console.log('dest contract balance after', await provider.getBalance(dest.address))

  console.log('--- COMPLETE SENDING NATIVE TOKEN ---')
}

async function sendErc20(owner: ethers.Wallet, factoryAddress: string, paymasterAPI: PaymasterAPI) {
  const value = '1230' // Amount of the ERC-20 token to transfer

  const erc20 = new ethers.Contract(token, erc20ABI, provider)
  const amount = ethers.utils.parseUnits(value)
  const dest = ethers.Wallet.createRandom()

  const approve = erc20.interface.encodeFunctionData('approve', [dest.address, amount])
  const transfer = erc20.interface.encodeFunctionData('transfer', [dest.address, amount])

  const accountAPI = new SimpleAccountAPI({
    provider,
    entryPointAddress,
    owner,
    factoryAddress,
    paymasterAPI
  })

  const signer = await provider.getSigner()

  const accountContract = await accountAPI._getAccountContract()
  console.log('--- START SENDING ERC20 TOKEN ---')
  await signer.sendTransaction({ to: accountContract.address, value: parseEther('0.1') })

  console.log('onwer balance before', await owner.getBalance())
  console.log('account contract balance before', await provider.getBalance(accountContract.address))
  console.log('owner erc20 balance before', await erc20.balanceOf(owner.address))
  console.log('dest erc20 balance before', await erc20.balanceOf(dest.address))
  
  const op = await accountAPI.createSignedUserOp({
    target: token,
    data: transfer,
    value: 0
  })

  const chainId = await provider.getNetwork().then(net => net.chainId)
  const client = new HttpRpcClient(bundlerUrl, entryPointAddress, chainId)
  const userOpHash = await client.sendUserOpToBundler(op)

  console.log('Waiting for transaction...')
  const transactionHash = await accountAPI.getUserOpReceipt(userOpHash)
  console.log(`Transaction hash: ${transactionHash}`)

  console.log('onwer balance after', await owner.getBalance())
  console.log('account contract balance after', await provider.getBalance(accountContract.address))
  console.log('onwer erc20 balance after', await erc20.balanceOf(owner.address))
  console.log('dest erc20 balance after', await erc20.balanceOf(dest.address))

  console.log('--- COMPLETE SENDING ERC20 TOKEN ---')
}

void main()
  .catch(e => { console.log(e); process.exit(1) })
  .then(() => process.exit(0))

export async function simulateValidation (
  userOp: PackedUserOperation,
  entryPointAddress: string,
  txOverrides?: any): Promise<IEntryPointSimulations.ValidationResultStructOutput> {
  const entryPointSimulations = EntryPointSimulations__factory.createInterface()
  const data = entryPointSimulations.encodeFunctionData('simulateValidation', [userOp])
  const tx: TransactionRequest = {
    to: entryPointAddress,
    data,
    ...txOverrides
  }
  const stateOverride = {
    [entryPointAddress]: {
      code: EntryPointSimulationsJson.deployedBytecode
    }
  }
  try {
    const simulationResult = await provider.send('eth_call', [tx, 'latest', stateOverride])
    const res = entryPointSimulations.decodeFunctionResult('simulateValidation', simulationResult)
    // note: here collapsing the returned "tuple of one" into a single value - will break for returning actual tuples
    return res[0]
  } catch (error: any) {
    const revertData = error?.data
    if (revertData != null) {
      // note: this line throws the revert reason instead of returning it
      entryPointSimulations.decodeFunctionResult('simulateValidation', revertData)
    }
    throw error
  }
}

export const maxUint48 = (2 ** 48) - 1

export function parseValidationData (validationData: BigNumberish): ValidationData {
  const data = hexZeroPad(BigNumber.from(validationData).toHexString(), 32)

  // string offsets start from left (msb)
  const aggregator = hexDataSlice(data, 32 - 20)
  let validUntil = parseInt(hexDataSlice(data, 32 - 26, 32 - 20))
  if (validUntil === 0) {
    validUntil = maxUint48
  }
  const validAfter = parseInt(hexDataSlice(data, 0, 6))

  return {
    aggregator,
    validAfter,
    validUntil
  }
}
