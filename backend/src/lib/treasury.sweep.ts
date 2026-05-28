/**
 * Treasury sweep — sends accumulated platform fees from the hot wallet
 * to the platform treasury wallet on EVM chains.
 *
 * Safety contract:
 *   - Caller MUST verify `amount <= available` (collected - already swept)
 *     BEFORE calling this function, inside a DB transaction if possible.
 *   - This function only throws if the on-chain send fails; DB recording is
 *     the caller's responsibility.
 *   - Private key bytes are zeroed immediately after signing.
 *   - TRON is not yet supported — throws a clear error.
 */

import { createWalletClient, createPublicClient, http, parseUnits, type Chain } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrum, base, bsc, mainnet, optimism, polygon } from 'viem/chains'
import {
  decryptGasSeed,
  deriveEvmPrivateKeyHex,
  getEvmTreasuryAddress,
  HOT_WALLET_INDEX,
} from './gas/gasWalletService'
import { getChainBySlug, getRpcUrl } from '../services/chainRegistry.service'
import { logger as log } from './logger'

// DB GasChain enum value → deposit chain registry slug
const GAS_CHAIN_TO_SLUG: Partial<Record<string, string>> = {
  BSC:  'bsc',
  ETH:  'ethereum',
  BASE: 'base',
  ARB:  'arbitrum',
  OP:   'optimism',
  MATIC:'polygon',
}

const VIEM_CHAINS: Partial<Record<string, Chain>> = {
  bsc,
  ethereum: mainnet,
  base,
  arbitrum,
  optimism,
  polygon,
}

const ERC20_ABI = [
  {
    name: 'balanceOf',
    type: 'function' as const,
    inputs:  [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    name: 'transfer',
    type: 'function' as const,
    inputs:  [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
] as const

export interface SweepResult {
  txHash: `0x${string}`
  treasuryAddress: string
  hotWalletAddress: string
  tokenSymbol: string
  chain: string   // DB GasChain value passed in
  amount: number
  hotWalletBalanceBefore: number
}

/**
 * Sweep `amount` of `tokenSymbol` from the hot wallet to the EVM treasury wallet
 * on `chain` (DB GasChain value, e.g. 'BSC', 'ETH', 'BASE').
 *
 * Throws if:
 *   - Chain is TRON (not yet supported)
 *   - Hot wallet seed is not configured
 *   - ERC20 contract not found for token/chain
 *   - Hot wallet on-chain balance < amount
 *   - On-chain transaction fails
 */
export async function sweepTokenToTreasury(
  tokenSymbol: string,
  chain: string,
  amount: number,
): Promise<SweepResult> {
  if (chain.toUpperCase() === 'TRON') {
    throw new Error('TRON treasury sweep is not yet implemented. Use the manual sweep guide for TRC20 fees.')
  }

  const chainSlug = GAS_CHAIN_TO_SLUG[chain.toUpperCase()]
  if (!chainSlug) {
    throw new Error(`Treasury sweep not supported for chain "${chain}". Supported: BSC, ETH, BASE, ARB, OP, MATIC.`)
  }

  const viemChain = VIEM_CHAINS[chainSlug]
  const rpcUrl    = getRpcUrl(chainSlug)
  if (!viemChain || !rpcUrl) {
    throw new Error(`No RPC URL configured for chain ${chainSlug}. Set the corresponding *_RPC_URL environment variable.`)
  }

  const chainCfg = await getChainBySlug(chainSlug)
  if (!chainCfg) throw new Error(`Chain registry config not found for slug "${chainSlug}"`)

  const tokenCfg = chainCfg.tokens.find(
    (t: { symbol: string; address: string | null }) =>
      t.symbol.toUpperCase() === tokenSymbol.toUpperCase() && t.address,
  )
  if (!tokenCfg?.address) {
    throw new Error(`No ERC20 contract address for ${tokenSymbol} on ${chainSlug}. Configure it in Admin → Deposit Chains.`)
  }

  const treasuryAddress = getEvmTreasuryAddress()
  if (!treasuryAddress) {
    throw new Error('EVM treasury address could not be derived — GAS_SEED_CIPHERTEXT is not configured.')
  }

  const seed = decryptGasSeed()
  let txHash: `0x${string}`
  let hotWalletAddress: string
  let hotWalletBalanceBefore: number

  try {
    const privateKey = deriveEvmPrivateKeyHex(seed, HOT_WALLET_INDEX)
    const account    = privateKeyToAccount(privateKey)
    hotWalletAddress = account.address

    const publicClient = createPublicClient({ chain: viemChain, transport: http(rpcUrl) })

    // Verify on-chain token balance before sending
    const rawBalance = await publicClient.readContract({
      address:      tokenCfg.address as `0x${string}`,
      abi:          ERC20_ABI,
      functionName: 'balanceOf',
      args:         [account.address],
    })
    hotWalletBalanceBefore = Number(rawBalance) / Math.pow(10, tokenCfg.decimals)

    if (hotWalletBalanceBefore < amount) {
      throw new Error(
        `Hot wallet on-chain ${tokenSymbol} balance (${hotWalletBalanceBefore.toFixed(6)}) is less than ` +
        `sweep amount (${amount.toFixed(6)}). Hot wallet contains user deposits too — ` +
        `sweeping more than the available platform fee balance is not allowed.`,
      )
    }

    const walletClient = createWalletClient({ chain: viemChain, transport: http(rpcUrl), account })
    txHash = await walletClient.writeContract({
      address:      tokenCfg.address as `0x${string}`,
      abi:          ERC20_ABI,
      functionName: 'transfer',
      args:         [treasuryAddress as `0x${string}`, parseUnits(String(amount), tokenCfg.decimals)],
    })
  } finally {
    seed.fill(0)
  }

  log.info(
    { txHash, tokenSymbol, chain, amount, treasuryAddress, hotWalletAddress },
    'treasury.sweep: on-chain transfer completed',
  )

  return { txHash, treasuryAddress, hotWalletAddress, tokenSymbol, chain, amount, hotWalletBalanceBefore }
}
