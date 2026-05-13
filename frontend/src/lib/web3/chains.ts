import type { Chain } from 'viem'
import { mainnet, bsc, polygon, arbitrum, optimism, base } from 'viem/chains'

/**
 * Supported EVM chains for the wallet connect flow. Must stay in lockstep with
 * backend/src/lib/chains.ts (same chain ids, same networkLabel mapping).
 */
export const SUPPORTED_CHAINS = [mainnet, bsc, polygon, arbitrum, optimism, base] as const satisfies readonly [Chain, ...Chain[]]

export interface UiToken {
  symbol: string
  address: `0x${string}` | null // null = native
  decimals: number
}

export interface UiChain {
  id: string
  chainId: number
  name: string
  nativeSymbol: string
  networkLabel: string
  tokens: UiToken[]
}

/**
 * Token catalogue for display in <ConnectedBalances>. Mirrors the backend table.
 * Keeping this static (rather than fetching from /wallet/chains) keeps the first
 * render fast; the backend list is used to validate deposit selection.
 */
export const UI_CHAINS: UiChain[] = [
  {
    id: 'ethereum', chainId: 1, name: 'Ethereum', nativeSymbol: 'ETH', networkLabel: 'ERC20',
    tokens: [
      { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
      { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
    ],
  },
  {
    id: 'bsc', chainId: 56, name: 'BNB Smart Chain', nativeSymbol: 'BNB', networkLabel: 'BEP20',
    tokens: [
      { symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
      { symbol: 'USDC', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
    ],
  },
  {
    id: 'polygon', chainId: 137, name: 'Polygon', nativeSymbol: 'POL', networkLabel: 'POLYGON',
    tokens: [
      { symbol: 'USDT', address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6 },
      { symbol: 'USDC', address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
    ],
  },
  {
    id: 'arbitrum', chainId: 42161, name: 'Arbitrum One', nativeSymbol: 'ETH', networkLabel: 'ARBITRUM',
    tokens: [
      { symbol: 'USDT', address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
      { symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
    ],
  },
  {
    id: 'optimism', chainId: 10, name: 'Optimism', nativeSymbol: 'ETH', networkLabel: 'OPTIMISM',
    tokens: [
      { symbol: 'USDT', address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', decimals: 6 },
      { symbol: 'USDC', address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6 },
    ],
  },
  {
    id: 'base', chainId: 8453, name: 'Base', nativeSymbol: 'ETH', networkLabel: 'BASE',
    tokens: [
      { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
    ],
  },
]

export function getUiChainByChainId(chainId: number | undefined): UiChain | undefined {
  if (chainId == null) return undefined
  return UI_CHAINS.find((c) => c.chainId === chainId)
}
