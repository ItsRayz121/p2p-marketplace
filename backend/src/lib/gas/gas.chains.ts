import { env } from '../env'
import { getEvmHotWalletAddress } from './gasWalletService'

// Extended GasChainId now includes non-EVM chains.
// Note: DB GasChain enum uses 'ETH' (not 'ETHEREUM') and 'SUI'.
export type GasChainId =
  | 'TRON' | 'BSC' | 'ETHEREUM' | 'BASE' | 'ARB' | 'OP' | 'MATIC' | 'AVAX'
  | 'SOL' | 'TON' | 'SUI'

export interface GasChainConfig {
  id: GasChainId
  name: string
  nativeSymbol: string
  networkLabel: string
  explorerBase: string
  /** tier name → native amount to deliver */
  nativeTierAmounts: Record<string, number>
  validateAddress: (addr: string) => boolean
  getDepositAddress: () => string | undefined
  getMarkupMultiplier: () => number
  getRpcUrl: () => string
  /** Whether this chain has automated delivery implemented. */
  deliveryImplemented: boolean
}

const TRC20_RE = /^T[A-Za-z1-9]{33}$/
const EVM_RE   = /^0x[0-9a-fA-F]{40}$/
const SOL_RE   = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const TON_RE   = /^0:[0-9a-f]{64}$|^[A-Za-z0-9+/_-]{48}$/
const SUI_RE   = /^0x[0-9a-fA-F]{64}$/

export const GAS_CHAINS: Record<GasChainId, GasChainConfig> = {
  TRON: {
    id: 'TRON',
    name: 'TRON',
    nativeSymbol: 'TRX',
    networkLabel: 'TRC20',
    explorerBase: 'https://tronscan.org/#',
    nativeTierAmounts: { SMALL: 10, MEDIUM: 50, LARGE: 100, XLARGE: 200, JUMBO: 500 },
    validateAddress:     (addr) => TRC20_RE.test(addr),
    getDepositAddress:   () => env.GAS_FEE_DEPOSIT_ADDRESS_TRC20,
    getMarkupMultiplier: () => env.GAS_MARKUP_MULTIPLIER_TRON,
    getRpcUrl:           () => env.TRON_FULLNODE_URL,
    deliveryImplemented: true,
  },
  BSC: {
    id: 'BSC',
    name: 'BNB Smart Chain',
    nativeSymbol: 'BNB',
    networkLabel: 'BEP20',
    explorerBase: 'https://bscscan.com',
    nativeTierAmounts: { SMALL: 0.005, MEDIUM: 0.02, LARGE: 0.05, XLARGE: 0.1, JUMBO: 0.3 },
    validateAddress:     (addr) => EVM_RE.test(addr),
    getDepositAddress:   () => env.GAS_FEE_DEPOSIT_ADDRESS_BEP20 ?? getEvmHotWalletAddress() ?? undefined,
    getMarkupMultiplier: () => env.GAS_MARKUP_MULTIPLIER_BSC,
    getRpcUrl:           () => env.BSC_RPC_URL,
    deliveryImplemented: true,
  },
  ETHEREUM: {
    id: 'ETHEREUM',
    name: 'Ethereum',
    nativeSymbol: 'ETH',
    networkLabel: 'ERC20',
    explorerBase: 'https://etherscan.io',
    nativeTierAmounts: { SMALL: 0.002, MEDIUM: 0.005, LARGE: 0.01, XLARGE: 0.02, JUMBO: 0.05 },
    validateAddress:     (addr) => EVM_RE.test(addr),
    getDepositAddress:   () => env.GAS_FEE_DEPOSIT_ADDRESS_ERC20 ?? getEvmHotWalletAddress() ?? undefined,
    getMarkupMultiplier: () => env.GAS_MARKUP_MULTIPLIER_ETH,
    getRpcUrl:           () => env.ETHEREUM_RPC_URL,
    deliveryImplemented: true,
  },
  BASE: {
    id: 'BASE',
    name: 'Base',
    nativeSymbol: 'ETH',
    networkLabel: 'Base',
    explorerBase: 'https://basescan.org',
    nativeTierAmounts: { SMALL: 0.0005, MEDIUM: 0.001, LARGE: 0.003, XLARGE: 0.005, JUMBO: 0.01 },
    validateAddress:     (addr) => EVM_RE.test(addr),
    getDepositAddress:   () => env.GAS_FEE_DEPOSIT_ADDRESS_BASE,
    getMarkupMultiplier: () => env.GAS_MARKUP_MULTIPLIER_BASE,
    getRpcUrl:           () => env.BASE_RPC_URL,
    deliveryImplemented: true,
  },
  ARB: {
    id: 'ARB',
    name: 'Arbitrum',
    nativeSymbol: 'ETH',
    networkLabel: 'Arbitrum',
    explorerBase: 'https://arbiscan.io',
    nativeTierAmounts: { SMALL: 0.0005, MEDIUM: 0.001, LARGE: 0.003, XLARGE: 0.005, JUMBO: 0.01 },
    validateAddress:     (addr) => EVM_RE.test(addr),
    getDepositAddress:   () => env.GAS_FEE_DEPOSIT_ADDRESS_ARB,
    getMarkupMultiplier: () => env.GAS_MARKUP_MULTIPLIER_ARB,
    getRpcUrl:           () => env.ARBITRUM_RPC_URL,
    deliveryImplemented: true,
  },
  OP: {
    id: 'OP',
    name: 'Optimism',
    nativeSymbol: 'ETH',
    networkLabel: 'Optimism',
    explorerBase: 'https://optimistic.etherscan.io',
    nativeTierAmounts: { SMALL: 0.0005, MEDIUM: 0.001, LARGE: 0.003, XLARGE: 0.005, JUMBO: 0.01 },
    validateAddress:     (addr) => EVM_RE.test(addr),
    getDepositAddress:   () => env.GAS_FEE_DEPOSIT_ADDRESS_OP,
    getMarkupMultiplier: () => env.GAS_MARKUP_MULTIPLIER_OP,
    getRpcUrl:           () => env.OPTIMISM_RPC_URL,
    deliveryImplemented: true,
  },
  MATIC: {
    id: 'MATIC',
    name: 'Polygon',
    nativeSymbol: 'POL',
    networkLabel: 'Polygon',
    explorerBase: 'https://polygonscan.com',
    nativeTierAmounts: { SMALL: 0.5, MEDIUM: 2, LARGE: 5, XLARGE: 10, JUMBO: 25 },
    validateAddress:     (addr) => EVM_RE.test(addr),
    getDepositAddress:   () => env.GAS_FEE_DEPOSIT_ADDRESS_MATIC,
    getMarkupMultiplier: () => env.GAS_MARKUP_MULTIPLIER_MATIC,
    getRpcUrl:           () => env.POLYGON_RPC_URL,
    deliveryImplemented: true,
  },
  AVAX: {
    id: 'AVAX',
    name: 'Avalanche',
    nativeSymbol: 'AVAX',
    networkLabel: 'Avalanche C-Chain',
    explorerBase: 'https://snowtrace.io',
    nativeTierAmounts: { SMALL: 0.05, MEDIUM: 0.1, LARGE: 0.25, XLARGE: 0.5, JUMBO: 1 },
    validateAddress:     (addr) => EVM_RE.test(addr),
    getDepositAddress:   () => env.GAS_FEE_DEPOSIT_ADDRESS_AVAX,
    getMarkupMultiplier: () => env.GAS_MARKUP_MULTIPLIER_AVAX,
    getRpcUrl:           () => env.AVALANCHE_RPC_URL,
    deliveryImplemented: true,
  },

  // ── Non-EVM chains (inactive by default) ──────────────────────────────────

  SOL: {
    id: 'SOL',
    name: 'Solana',
    nativeSymbol: 'SOL',
    networkLabel: 'Solana',
    explorerBase: 'https://solscan.io',
    nativeTierAmounts: { SMALL: 0.05, MEDIUM: 0.1, LARGE: 0.25, XLARGE: 0.5, JUMBO: 1 },
    validateAddress:     (addr) => SOL_RE.test(addr),
    getDepositAddress:   () => env.GAS_FEE_DEPOSIT_ADDRESS_SOL,
    getMarkupMultiplier: () => env.GAS_MARKUP_MULTIPLIER_SOL,
    getRpcUrl:           () => env.SOL_RPC_URL,
    deliveryImplemented: false,
  },
  TON: {
    id: 'TON',
    name: 'TON',
    nativeSymbol: 'TON',
    networkLabel: 'TON',
    explorerBase: 'https://tonscan.org',
    nativeTierAmounts: { SMALL: 0.5, MEDIUM: 1, LARGE: 2, XLARGE: 5, JUMBO: 10 },
    validateAddress:     (addr) => TON_RE.test(addr),
    getDepositAddress:   () => env.GAS_FEE_DEPOSIT_ADDRESS_TON,
    getMarkupMultiplier: () => env.GAS_MARKUP_MULTIPLIER_TON,
    getRpcUrl:           () => env.TON_ENDPOINT_URL,
    deliveryImplemented: false,
  },
  SUI: {
    id: 'SUI',
    name: 'SUI',
    nativeSymbol: 'SUI',
    networkLabel: 'SUI',
    explorerBase: 'https://suivision.xyz',
    nativeTierAmounts: { SMALL: 0.5, MEDIUM: 1, LARGE: 2, XLARGE: 5, JUMBO: 10 },
    validateAddress:     (addr) => SUI_RE.test(addr),
    getDepositAddress:   () => env.GAS_FEE_DEPOSIT_ADDRESS_SUI,
    getMarkupMultiplier: () => env.GAS_MARKUP_MULTIPLIER_SUI,
    getRpcUrl:           () => env.SUI_RPC_URL,
    deliveryImplemented: false,
  },
}

export function getGasChain(chainId: string): GasChainConfig {
  const config = GAS_CHAINS[chainId as GasChainId]
  if (!config) throw new Error(`Unsupported gas chain: ${chainId}`)
  return config
}

export function explorerTxUrl(chainId: GasChainId, txHash: string): string {
  const c = GAS_CHAINS[chainId]
  if (chainId === 'TRON') return `${c.explorerBase}/transaction/${txHash}`
  if (chainId === 'SOL')  return `${c.explorerBase}/tx/${txHash}`
  if (chainId === 'TON')  return `${c.explorerBase}/transaction/${txHash}`
  if (chainId === 'SUI')  return `${c.explorerBase}/txblock/${txHash}`
  return `${c.explorerBase}/tx/${txHash}`
}

export const SUPPORTED_GAS_CHAINS = Object.keys(GAS_CHAINS) as GasChainId[]

// EVM chains (secp256k1, shared hot wallet address)
export const EVM_GAS_CHAINS: GasChainId[] = ['BSC', 'ETHEREUM', 'BASE', 'ARB', 'OP', 'MATIC', 'AVAX']

// Non-EVM chains (ed25519, separate derivation paths)
export const NON_EVM_GAS_CHAINS: GasChainId[] = ['SOL', 'TON', 'SUI']

// ── DB boundary mappers ────────────────────────────────────────────────────────
// GasChain enum: TRON | BSC | ETH | SOL | MATIC | ARB | BASE | OP | AVAX | TON | SUI
// GasChainId:    same but 'ETHEREUM' instead of 'ETH'

export type DbGasChain = 'TRON' | 'BSC' | 'ETH' | 'SOL' | 'MATIC' | 'ARB' | 'BASE' | 'OP' | 'AVAX' | 'TON' | 'SUI'

export function toDbChain(chain: GasChainId): DbGasChain {
  if (chain === 'ETHEREUM') return 'ETH'
  return chain as DbGasChain
}

export function fromDbChain(chain: string): GasChainId {
  if (chain === 'ETH') return 'ETHEREUM'
  return chain as GasChainId
}
