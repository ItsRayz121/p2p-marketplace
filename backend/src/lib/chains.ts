/**
 * Single source of truth for chain & token configuration.
 *
 * Each EVM chain shares the same per-user deposit address (BIP44 m/44'/60'/0'/0/{index}),
 * so the `family: 'EVM'` group routes through the HD-derived address service.
 * Non-EVM families (TRON, TON, SUI, BTC) plug into their own custody paths later.
 */
import { env } from './env'

export type ChainFamily = 'EVM' | 'TRON'

export interface TokenConfig {
  symbol: string
  /** null = native asset (no contract address) */
  address: string | null
  decimals: number
}

export interface ChainConfig {
  /** Internal id used in API responses and DB rows */
  id: string
  /** Numeric chain id (EVM) — undefined for non-EVM families */
  chainId?: number
  /** Human-readable name */
  name: string
  family: ChainFamily
  /** Symbol of the native gas asset (ETH, BNB, POL, …) */
  nativeSymbol: string
  /** Network label as shown in the UI ("ERC20", "BEP20", "TRC20", …) */
  networkLabel: string
  /** Confirmations required before a deposit is credited */
  minConfirmations: number
  /** Tokens we credit deposits for on this chain */
  tokens: TokenConfig[]
}

export const EVM_CHAINS: ChainConfig[] = [
  {
    id: 'ethereum',
    chainId: 1,
    name: 'Ethereum',
    family: 'EVM',
    nativeSymbol: 'ETH',
    networkLabel: 'ERC20',
    minConfirmations: 12,
    tokens: [
      { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
      { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
    ],
  },
  {
    id: 'bsc',
    chainId: 56,
    name: 'BNB Smart Chain',
    family: 'EVM',
    nativeSymbol: 'BNB',
    networkLabel: 'BEP20',
    minConfirmations: 15,
    tokens: [
      { symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
      { symbol: 'USDC', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
    ],
  },
  {
    id: 'polygon',
    chainId: 137,
    name: 'Polygon',
    family: 'EVM',
    nativeSymbol: 'POL',
    networkLabel: 'POLYGON',
    minConfirmations: 30,
    tokens: [
      { symbol: 'USDT', address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6 },
      { symbol: 'USDC', address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
    ],
  },
  {
    id: 'arbitrum',
    chainId: 42161,
    name: 'Arbitrum One',
    family: 'EVM',
    nativeSymbol: 'ETH',
    networkLabel: 'ARBITRUM',
    minConfirmations: 20,
    tokens: [
      { symbol: 'USDT', address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
      { symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
    ],
  },
  {
    id: 'optimism',
    chainId: 10,
    name: 'Optimism',
    family: 'EVM',
    nativeSymbol: 'ETH',
    networkLabel: 'OPTIMISM',
    minConfirmations: 20,
    tokens: [
      { symbol: 'USDT', address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', decimals: 6 },
      { symbol: 'USDC', address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6 },
    ],
  },
  {
    id: 'base',
    chainId: 8453,
    name: 'Base',
    family: 'EVM',
    nativeSymbol: 'ETH',
    networkLabel: 'BASE',
    minConfirmations: 20,
    tokens: [
      { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
    ],
  },
]

export const ALL_CHAINS: ChainConfig[] = [...EVM_CHAINS]

/** Map a UI network label (e.g. "ERC20") to its chain config. */
export function getChainByNetworkLabel(network: string): ChainConfig | undefined {
  const upper = network.toUpperCase()
  return ALL_CHAINS.find((c) => c.networkLabel === upper)
}

export function getChainById(id: string): ChainConfig | undefined {
  return ALL_CHAINS.find((c) => c.id === id.toLowerCase())
}

export function isEvmNetwork(network: string): boolean {
  const c = getChainByNetworkLabel(network)
  return c?.family === 'EVM'
}

/**
 * Look up the configured Moralis Stream id for a given chain id. Returns
 * undefined if the operator hasn't set the corresponding env var yet —
 * callers should treat that as "skip this chain", not an error.
 */
export function getMoralisStreamId(chainId: string): string | undefined {
  switch (chainId) {
    case 'ethereum': return env.MORALIS_STREAM_ID_ETHEREUM || undefined
    case 'bsc': return env.MORALIS_STREAM_ID_BSC || undefined
    case 'polygon': return env.MORALIS_STREAM_ID_POLYGON || undefined
    case 'arbitrum': return env.MORALIS_STREAM_ID_ARBITRUM || undefined
    case 'optimism': return env.MORALIS_STREAM_ID_OPTIMISM || undefined
    case 'base': return env.MORALIS_STREAM_ID_BASE || undefined
    default: return undefined
  }
}
