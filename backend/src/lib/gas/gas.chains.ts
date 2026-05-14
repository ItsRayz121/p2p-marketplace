import { env } from '../env'

export type GasChainId = 'TRON' | 'BSC' | 'ETHEREUM'

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
  getAlertThreshold: () => number
  getPauseThreshold: () => number
  getPrivateKey: () => string | undefined
  getRpcUrl: () => string
}

const TRC20_RE = /^T[A-Za-z1-9]{33}$/
const EVM_RE   = /^0x[0-9a-fA-F]{40}$/

export const GAS_CHAINS: Record<GasChainId, GasChainConfig> = {
  TRON: {
    id: 'TRON',
    name: 'TRON',
    nativeSymbol: 'TRX',
    networkLabel: 'TRC20',
    explorerBase: 'https://tronscan.org/#',
    nativeTierAmounts: { SMALL: 10, MEDIUM: 50, LARGE: 100, XLARGE: 200, JUMBO: 500 },
    validateAddress: (addr) => TRC20_RE.test(addr),
    getDepositAddress:  () => env.GAS_FEE_DEPOSIT_ADDRESS_TRC20,
    getMarkupMultiplier: () => env.GAS_MARKUP_MULTIPLIER_TRON,
    getAlertThreshold:  () => env.GAS_WALLET_ALERT_THRESHOLD_TRON,
    getPauseThreshold:  () => env.GAS_WALLET_PAUSE_THRESHOLD_TRON,
    getPrivateKey:      () => env.GAS_WALLET_PRIVATE_KEY_TRON,
    getRpcUrl:          () => env.TRON_FULLNODE_URL,
  },
  BSC: {
    id: 'BSC',
    name: 'BNB Smart Chain',
    nativeSymbol: 'BNB',
    networkLabel: 'BEP20',
    explorerBase: 'https://bscscan.com',
    nativeTierAmounts: { SMALL: 0.005, MEDIUM: 0.02, LARGE: 0.05, XLARGE: 0.1, JUMBO: 0.3 },
    validateAddress: (addr) => EVM_RE.test(addr),
    getDepositAddress:  () => env.GAS_FEE_DEPOSIT_ADDRESS_BEP20,
    getMarkupMultiplier: () => env.GAS_MARKUP_MULTIPLIER_BSC,
    getAlertThreshold:  () => env.GAS_WALLET_ALERT_THRESHOLD_BSC,
    getPauseThreshold:  () => env.GAS_WALLET_PAUSE_THRESHOLD_BSC,
    getPrivateKey:      () => env.GAS_WALLET_PRIVATE_KEY_BSC,
    getRpcUrl:          () => env.BSC_RPC_URL,
  },
  ETHEREUM: {
    id: 'ETHEREUM',
    name: 'Ethereum',
    nativeSymbol: 'ETH',
    networkLabel: 'ERC20',
    explorerBase: 'https://etherscan.io',
    nativeTierAmounts: { SMALL: 0.002, MEDIUM: 0.005, LARGE: 0.01, XLARGE: 0.02, JUMBO: 0.05 },
    validateAddress: (addr) => EVM_RE.test(addr),
    getDepositAddress:  () => env.GAS_FEE_DEPOSIT_ADDRESS_ERC20,
    getMarkupMultiplier: () => env.GAS_MARKUP_MULTIPLIER_ETH,
    getAlertThreshold:  () => env.GAS_WALLET_ALERT_THRESHOLD_ETH,
    getPauseThreshold:  () => env.GAS_WALLET_PAUSE_THRESHOLD_ETH,
    getPrivateKey:      () => env.GAS_WALLET_PRIVATE_KEY_ETH,
    getRpcUrl:          () => env.ETHEREUM_RPC_URL,
  },
}

export function getGasChain(chainId: string): GasChainConfig {
  const config = GAS_CHAINS[chainId as GasChainId]
  if (!config) throw new Error(`Unsupported gas chain: ${chainId}`)
  return config
}

export function explorerTxUrl(chainId: GasChainId, txHash: string): string {
  const c = GAS_CHAINS[chainId]
  return chainId === 'TRON'
    ? `${c.explorerBase}/transaction/${txHash}`
    : `${c.explorerBase}/tx/${txHash}`
}

export const SUPPORTED_GAS_CHAINS = Object.keys(GAS_CHAINS) as GasChainId[]

// DB boundary mappers — GasChain enum uses 'ETH', GasChainId uses 'ETHEREUM'
export function toDbChain(chain: GasChainId): 'TRON' | 'BSC' | 'ETH' {
  if (chain === 'ETHEREUM') return 'ETH'
  return chain
}

export function fromDbChain(chain: string): GasChainId {
  if (chain === 'ETH') return 'ETHEREUM'
  return chain as GasChainId
}
