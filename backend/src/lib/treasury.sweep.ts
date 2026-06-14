/**
 * Platform payout — sends platform-owned funds from the shared hot wallet to an
 * EXTERNAL operator-controlled wallet (real withdrawal, not an internal move).
 *
 * Safety contract:
 *   - Caller MUST verify `amount <= safe-withdrawable` (see gas.revenue.ts)
 *     BEFORE calling this function.
 *   - Sends are serialized through the per-chain hot-wallet lock so a payout can
 *     never collide on a nonce with an in-flight gas delivery from the same wallet.
 *   - EVM payouts wait for the receipt and assert success before returning.
 *   - Private key bytes are zeroed immediately after signing.
 *   - TRON payout is not automated — throws a clear error (sweep TRC20 manually).
 */

import { createWalletClient, createPublicClient, http, parseUnits, type Chain } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrum, avalanche, base, bsc, mainnet, optimism, polygon } from 'viem/chains'
import { env } from './env'
import {
  decryptGasSeed,
  deriveEvmPrivateKeyHex,
  getEvmHotWalletAddress,
  HOT_WALLET_INDEX,
} from './gas/gasWalletService'
import { getAptosHotWalletAddress } from './gas/aptosWalletService'
import { getHotWalletTokenBalance } from './gas/gas.tokenBalance'
import { resolveTokenContract, chainFamily } from './gas/gas.revenue'
import { withHotWalletLock } from './hotWalletLock'
import { getTransactionCount } from './evmRpc'
import { logger as log } from './logger'

// GasChain enum value → viem chain + RPC (mirrors the proven delivery config).
const EVM_PAYOUT: Record<string, { chain: Chain; rpc: string }> = {
  BSC:  { chain: bsc,       rpc: env.BSC_RPC_URL },
  ETH:  { chain: mainnet,   rpc: env.ETHEREUM_RPC_URL },
  BASE: { chain: base,      rpc: env.BASE_RPC_URL },
  ARB:  { chain: arbitrum,  rpc: env.ARBITRUM_RPC_URL },
  OP:   { chain: optimism,  rpc: env.OPTIMISM_RPC_URL },
  MATIC:{ chain: polygon,   rpc: env.POLYGON_RPC_URL },
  AVAX: { chain: avalanche, rpc: env.AVALANCHE_RPC_URL },
}

const ERC20_ABI = [
  { name: 'balanceOf', type: 'function' as const, inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { name: 'transfer',  type: 'function' as const, inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'nonpayable' },
] as const

export interface PayoutResult {
  txHash: string
  destination: string
  hotWalletAddress: string
  tokenSymbol: string
  chain: string
  amount: number
  hotWalletBalanceBefore: number
}

async function withdrawEvm(
  chain: string,
  tokenSymbol: string,
  amount: number,
  destination: `0x${string}`,
  contract: `0x${string}`,
  decimals: number,
): Promise<PayoutResult> {
  const m = EVM_PAYOUT[chain.toUpperCase()]
  if (!m) throw new Error(`Withdrawal not supported for EVM chain "${chain}".`)
  if (!m.rpc) throw new Error(`No RPC URL configured for ${chain}. Set the corresponding *_RPC_URL env var.`)

  const seed = decryptGasSeed()
  try {
    const privateKey = deriveEvmPrivateKeyHex(seed, HOT_WALLET_INDEX)
    const account    = privateKeyToAccount(privateKey)
    const hotWalletAddress = account.address

    const publicClient = createPublicClient({ chain: m.chain, transport: http(m.rpc) })
    const rawBalance = await publicClient.readContract({
      address: contract, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address],
    })
    const hotWalletBalanceBefore = Number(rawBalance) / Math.pow(10, decimals)
    if (hotWalletBalanceBefore < amount) {
      throw new Error(`Hot wallet on-chain ${tokenSymbol} balance (${hotWalletBalanceBefore.toFixed(6)}) is below the withdrawal amount (${amount.toFixed(6)}).`)
    }

    const walletClient = createWalletClient({ chain: m.chain, transport: http(m.rpc), account })

    // Serialize against deliveries from the same hot wallet (nonce safety).
    const txHash = await withHotWalletLock(chain.toUpperCase(), async () => {
      const nonce = await getTransactionCount(m.rpc, chain.toUpperCase(), account.address, 'pending')
      const hash = await walletClient.writeContract({
        address: contract, abi: ERC20_ABI, functionName: 'transfer',
        args: [destination, parseUnits(String(amount), decimals)], nonce,
      })
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 })
      if (receipt.status !== 'success') throw new Error(`Withdrawal transaction reverted on-chain (tx ${hash}).`)
      return hash
    })

    log.info({ txHash, tokenSymbol, chain, amount, destination, hotWalletAddress }, 'treasury.sweep: external withdrawal confirmed')
    return { txHash, destination, hotWalletAddress, tokenSymbol, chain: chain.toUpperCase(), amount, hotWalletBalanceBefore }
  } finally {
    seed.fill(0)
  }
}

async function withdrawAptos(
  tokenSymbol: string,
  amount: number,
  destination: string,
  contract: string,
  decimals: number,
): Promise<PayoutResult> {
  const { Aptos, AptosConfig, Account, Ed25519PrivateKey } = await import('@aptos-labs/ts-sdk')
  const { deriveAptosPrivateKeyForDelivery } = await import('./gas/aptosWalletService')

  const owner = getAptosHotWalletAddress()
  if (!owner) throw new Error('Aptos hot wallet not configured.')

  const { balance: hotWalletBalanceBefore } = await getHotWalletTokenBalance('APT', contract, owner, decimals)
  if (hotWalletBalanceBefore < amount) {
    throw new Error(`Aptos hot wallet ${tokenSymbol} balance (${hotWalletBalanceBefore.toFixed(6)}) is below the withdrawal amount (${amount.toFixed(6)}).`)
  }

  const scaled = BigInt(Math.round(Number(amount.toFixed(decimals)) * 10 ** decimals))
  if (scaled <= 0n) throw new Error('Aptos withdrawal amount resolves to zero base units.')

  const config = new AptosConfig({
    fullnode: env.APTOS_FULLNODE_URL,
    indexer:  env.APTOS_INDEXER_URL,
    ...(env.APTOS_API_KEY ? { clientConfig: { API_KEY: env.APTOS_API_KEY } } : {}),
  })
  const aptos = new Aptos(config)

  const seed = decryptGasSeed()
  let privKey: Buffer | null = null
  try {
    privKey = deriveAptosPrivateKeyForDelivery(seed)
    const account = Account.fromPrivateKey({ privateKey: new Ed25519PrivateKey(new Uint8Array(privKey)) })
    const txn = await aptos.transaction.build.simple({
      sender: account.accountAddress,
      data: {
        function: '0x1::primary_fungible_store::transfer',
        typeArguments: ['0x1::fungible_asset::Metadata'],
        functionArguments: [contract, destination, scaled],
      },
    })
    const pending = await aptos.signAndSubmitTransaction({ signer: account, transaction: txn })
    await aptos.waitForTransaction({ transactionHash: pending.hash })
    log.info({ txHash: pending.hash, tokenSymbol, amount, destination }, 'treasury.sweep: Aptos external withdrawal confirmed')
    return { txHash: pending.hash, destination, hotWalletAddress: owner, tokenSymbol, chain: 'APT', amount, hotWalletBalanceBefore }
  } finally {
    seed.fill(0)
    if (privKey) privKey.fill(0)
  }
}

/**
 * Withdraw `amount` of `tokenSymbol` from the hot wallet to `destination`
 * (external wallet) on `chain` (GasChain enum value). Caller must have already
 * verified `amount` is within the safe-withdrawable headroom.
 */
export async function withdrawHotWalletToken(
  tokenSymbol: string,
  chain: string,
  amount: number,
  destination: string,
): Promise<PayoutResult> {
  const family = chainFamily(chain)
  if (family === 'tron') {
    throw new Error('TRON withdrawal is not automated. Sweep TRC20 manually from the hot wallet using your wallet app.')
  }
  if (!family) {
    throw new Error(`Withdrawal not supported for chain "${chain}".`)
  }

  const contract = await resolveTokenContract(chain, tokenSymbol)
  if (!contract) throw new Error(`No on-chain contract found for ${tokenSymbol} on ${chain}.`)

  const owner = family === 'aptos' ? getAptosHotWalletAddress() : getEvmHotWalletAddress()
  if (!owner) throw new Error(`Hot wallet address unavailable for ${chain}.`)

  // Authoritative decimals from the live token read (same source delivery uses).
  const { decimals } = await getHotWalletTokenBalance(chain.toUpperCase(), contract, owner)

  if (family === 'aptos') {
    return withdrawAptos(tokenSymbol.toUpperCase(), amount, destination, contract, decimals)
  }
  return withdrawEvm(chain, tokenSymbol.toUpperCase(), amount, destination as `0x${string}`, contract as `0x${string}`, decimals)
}
