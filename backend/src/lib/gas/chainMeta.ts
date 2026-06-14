/**
 * Chain capability metadata and feature readiness states.
 *
 * Readiness states (stored in GasChainConfig.readinessState):
 *   inactive   — not accepting orders; hidden from public UI
 *   testing    — admin-only testing; not visible to public
 *   beta       — live with disclaimer; limited to internal users
 *   stable     — fully operational; shown without caveats
 *
 * Chain capability flags describe which features a chain supports.
 * These are static per chain and do not change with readiness state.
 */

// ── Readiness state ────────────────────────────────────────────────────────────

export type ChainReadinessState = 'inactive' | 'testing' | 'beta' | 'stable'

export const READINESS_BADGE: Record<ChainReadinessState, { label: string; color: string }> = {
  inactive: { label: 'Coming Soon', color: 'gray'   },
  testing:  { label: 'Coming Soon', color: 'gray'   },
  beta:     { label: 'Beta',        color: 'yellow' },
  stable:   { label: 'Stable',      color: 'green'  },
}

/** Returns true when a chain should appear on the public gas fee page. */
export function isPubliclyVisible(state: ChainReadinessState): boolean {
  return state === 'beta' || state === 'stable'
}

/** Returns true when a chain can accept new orders. */
export function isOrderable(state: ChainReadinessState): boolean {
  return state === 'beta' || state === 'stable'
}

// ── Chain capability flags ─────────────────────────────────────────────────────

export interface ChainCapabilities {
  /** Key derivation supported from the shared BIP39 mnemonic. */
  supportsMnemonic: boolean
  /** Fully automated gas delivery (no manual step). */
  supportsAutoDelivery: boolean
  /** Platform accepts USDT/stablecoin as the payment token. */
  supportsStablecoins: boolean
  /** Platform can issue USDT refund if delivery fails. */
  supportsRefunds: boolean
  /** Tx confirmation check is implemented (post-delivery). */
  supportsConfirmation: boolean
  /** Deposit address is derivable from mnemonic or set via env var. */
  supportsDepositAddress: boolean
  /** Hot wallet balance is monitored and alerts/auto-pauses are active. */
  supportsMonitoring: boolean
  /** Admin RPC health check is implemented. */
  supportsRpcHealthCheck: boolean
  /** Admin delivery dry-run is implemented. */
  supportsDryRun: boolean
}

// ── Per-chain capability table ─────────────────────────────────────────────────
// This is the authoritative source. All columns are intentionally exhaustive
// so adding a new chain requires filling in every capability explicitly.

export const CHAIN_CAPABILITIES: Record<string, ChainCapabilities> = {
  TRON: {
    supportsMnemonic:         true,
    supportsAutoDelivery:     true,
    supportsStablecoins:      true,
    supportsRefunds:          true,
    supportsConfirmation:     true,
    supportsDepositAddress:   true,
    supportsMonitoring:       true,
    supportsRpcHealthCheck:   true,
    supportsDryRun:           false,
  },
  BSC: {
    supportsMnemonic:         true,
    supportsAutoDelivery:     true,
    supportsStablecoins:      true,
    supportsRefunds:          true,
    supportsConfirmation:     true,
    supportsDepositAddress:   true,
    supportsMonitoring:       true,
    supportsRpcHealthCheck:   true,
    supportsDryRun:           false,
  },
  ETH: {
    supportsMnemonic:         true,
    supportsAutoDelivery:     true,
    supportsStablecoins:      true,
    supportsRefunds:          true,
    supportsConfirmation:     true,
    supportsDepositAddress:   true,
    supportsMonitoring:       true,
    supportsRpcHealthCheck:   true,
    supportsDryRun:           false,
  },
  BASE: {
    supportsMnemonic:         true,
    supportsAutoDelivery:     true,
    supportsStablecoins:      true,
    supportsRefunds:          true,
    supportsConfirmation:     true,
    supportsDepositAddress:   true,
    supportsMonitoring:       true,
    supportsRpcHealthCheck:   true,
    supportsDryRun:           false,
  },
  ARB: {
    supportsMnemonic:         true,
    supportsAutoDelivery:     true,
    supportsStablecoins:      true,
    supportsRefunds:          true,
    supportsConfirmation:     true,
    supportsDepositAddress:   true,
    supportsMonitoring:       true,
    supportsRpcHealthCheck:   true,
    supportsDryRun:           false,
  },
  OP: {
    supportsMnemonic:         true,
    supportsAutoDelivery:     true,
    supportsStablecoins:      true,
    supportsRefunds:          true,
    supportsConfirmation:     true,
    supportsDepositAddress:   true,
    supportsMonitoring:       true,
    supportsRpcHealthCheck:   true,
    supportsDryRun:           false,
  },
  MATIC: {
    supportsMnemonic:         true,
    supportsAutoDelivery:     true,
    supportsStablecoins:      true,
    supportsRefunds:          true,
    supportsConfirmation:     true,
    supportsDepositAddress:   true,
    supportsMonitoring:       true,
    supportsRpcHealthCheck:   true,
    supportsDryRun:           false,
  },
  AVAX: {
    supportsMnemonic:         true,
    supportsAutoDelivery:     true,
    supportsStablecoins:      true,
    supportsRefunds:          true,
    supportsConfirmation:     true,
    supportsDepositAddress:   true,
    supportsMonitoring:       true,
    supportsRpcHealthCheck:   true,
    supportsDryRun:           false,
  },
  SOL: {
    supportsMnemonic:         true,
    supportsAutoDelivery:     true,  // @solana/web3.js delivery implemented
    supportsStablecoins:      false, // USDT-on-SOL not yet wired
    supportsRefunds:          false,
    supportsConfirmation:     true,  // getSignatureStatuses — checks finalized + err=null
    supportsDepositAddress:   true,
    supportsMonitoring:       true,
    supportsRpcHealthCheck:   true,
    supportsDryRun:           true,
  },
  TON: {
    supportsMnemonic:         true,
    supportsAutoDelivery:     true,  // @ton/ton WalletContractV4 delivery implemented
    supportsStablecoins:      false,
    supportsRefunds:          false,
    supportsConfirmation:     true,  // instant finality — confirmed immediately after 60s delay
    supportsDepositAddress:   true,  // real V4R2 address via WalletContractV4
    supportsMonitoring:       true,
    supportsRpcHealthCheck:   true,
    supportsDryRun:           true,
  },
  SUI: {
    supportsMnemonic:         true,
    supportsAutoDelivery:     true,  // @mysten/sui delivery implemented (requires blake2b-256)
    supportsStablecoins:      false,
    supportsRefunds:          false,
    supportsConfirmation:     true,  // sui_getTransactionBlock effects.status check
    supportsDepositAddress:   true,  // address correct when blake2b-256 available
    supportsMonitoring:       true,
    supportsRpcHealthCheck:   true,
    supportsDryRun:           true,
  },
}

export function getChainCapabilities(chainSlug: string): ChainCapabilities {
  return CHAIN_CAPABILITIES[chainSlug.toUpperCase()] ?? {
    supportsMnemonic:         false,
    supportsAutoDelivery:     false,
    supportsStablecoins:      false,
    supportsRefunds:          false,
    supportsConfirmation:     false,
    supportsDepositAddress:   false,
    supportsMonitoring:       false,
    supportsRpcHealthCheck:   false,
    supportsDryRun:           false,
  }
}

// ── Chain readiness matrix (static production audit) ──────────────────────────

export interface ChainReadinessEntry {
  chain: string
  recommendedState: ChainReadinessState
  deliveryReady: boolean
  blockers: string[]
  notes: string
}

export const CHAIN_READINESS_MATRIX: ChainReadinessEntry[] = [
  {
    chain: 'TRON',
    recommendedState: 'stable',
    deliveryReady: true,
    blockers: [],
    notes: 'Fully operational. TRC20 USDT payments + TRX delivery proven in production.',
  },
  {
    chain: 'BSC',
    recommendedState: 'stable',
    deliveryReady: true,
    blockers: [],
    notes: 'EVM mnemonic derivation active. BEP20 payments + BNB delivery operational.',
  },
  {
    chain: 'ETH',
    recommendedState: 'stable',
    deliveryReady: true,
    blockers: [],
    notes: 'EVM mnemonic derivation active. ERC20 payments + ETH delivery operational.',
  },
  {
    chain: 'BASE',
    recommendedState: 'beta',
    deliveryReady: true,
    blockers: [],
    notes: 'Shares EVM hot wallet with ETH/BSC. Low gas fees make it cost-efficient.',
  },
  {
    chain: 'ARB',
    recommendedState: 'beta',
    deliveryReady: true,
    blockers: [],
    notes: 'Shares EVM hot wallet. Arbitrum L2 — fast + cheap delivery.',
  },
  {
    chain: 'OP',
    recommendedState: 'beta',
    deliveryReady: true,
    blockers: [],
    notes: 'Shares EVM hot wallet. Optimism L2 — fast + cheap delivery.',
  },
  {
    chain: 'MATIC',
    recommendedState: 'beta',
    deliveryReady: true,
    blockers: [],
    notes: 'Shares EVM hot wallet. Polygon native token is POL (was MATIC).',
  },
  {
    chain: 'AVAX',
    recommendedState: 'beta',
    deliveryReady: true,
    blockers: [],
    notes: 'Shares EVM hot wallet. Avalanche C-Chain EVM-compatible.',
  },
  {
    chain: 'SOL',
    recommendedState: 'beta',
    deliveryReady: true,
    blockers: [],
    notes: 'Delivery + confirmation fully implemented. Admin must: (1) POST /admin/gas/hot-wallets chain=SOL, (2) fund the derived address with SOL, (3) activate hot wallet row, (4) set GasChainConfig backendChainId=SOL + isActive=true + readinessState=beta.',
  },
  {
    chain: 'TON',
    recommendedState: 'beta',
    deliveryReady: true,
    blockers: [],
    notes: 'Delivery + instant-confirm implemented. Real V4R2 address derived via WalletContractV4. Admin must: (1) POST /admin/gas/hot-wallets chain=TON, (2) fund with TON, (3) activate hot wallet row, (4) set GasChainConfig backendChainId=TON + isActive=true + readinessState=beta.',
  },
  {
    chain: 'SUI',
    recommendedState: 'beta',
    deliveryReady: true,
    blockers: [],
    notes: 'Delivery + sui_getTransactionBlock confirmation implemented. REQUIRES blake2b-256 (Node 20 + OpenSSL 3) — run deploy:verify before activating. Admin must: (1) POST /admin/gas/hot-wallets chain=SUI, (2) fund with SUI, (3) activate hot wallet row, (4) set GasChainConfig backendChainId=SUI + isActive=true + readinessState=beta.',
  },
]

// ── Unsupported features matrix ────────────────────────────────────────────────

export interface UnsupportedFeatureEntry {
  feature: string
  affectedChains: string[]
  reason: string
  resolution: string
}

export const UNSUPPORTED_FEATURES: UnsupportedFeatureEntry[] = [
  {
    feature: 'Stablecoin payment acceptance',
    affectedChains: ['SOL', 'TON', 'SUI'],
    reason: 'SPL/Jetton/SUI token payment detection not implemented in deposit watcher',
    resolution: 'Extend depositWatcher to detect non-EVM token transfers',
  },
  {
    feature: 'Refund flow',
    affectedChains: ['SOL', 'TON', 'SUI'],
    reason: 'Non-EVM refund path not implemented; requires stablecoin acceptance first',
    resolution: 'Implement after stablecoin payment acceptance is live and proven',
  },
  {
    feature: 'Tx confirmation check',
    affectedChains: [],
    reason: 'Implemented for all chains: SOL uses getSignatureStatuses, SUI uses sui_getTransactionBlock, TON uses instant-finality confirmation.',
    resolution: 'N/A — complete.',
  },
  {
    feature: 'SUI address on non-blake2b hosts',
    affectedChains: [],
    reason: 'Previously: if the host OpenSSL lacked blake2b-256, the address silently fell back to sha3-256 — a wrong, unspendable address (balance showed funded, delivery failed "No valid gas coins found").',
    resolution: 'RESOLVED — address now derived via the Mysten SDK Ed25519PublicKey (pure-JS blake2b, host-independent), so it always matches the spendable delivery keypair address.',
  },
]

// ── Per-chain operational readiness ───────────────────────────────────────────
// Used by system-health to show activation blockers per chain.

export interface ChainReadinessReport {
  chain: string
  deliveryReady: boolean
  refundReady: boolean
  confirmationReady: boolean
  depositReady: boolean
  depositAddress: string | null
  depositSource: 'env_var' | 'mnemonic_derived' | 'unconfigured'
  usdtContract: string | null
  blockers: string[]
  warnings: string[]
}

export function buildChainReadinessReport(
  chain: string,
  opts: {
    depositAddress: string | null
    depositSource: 'env_var' | 'mnemonic_derived' | 'unconfigured'
    usdtContract: string | null
    mnemonicConfigured: boolean
    rpcReachable: boolean
  },
): ChainReadinessReport {
  const caps = getChainCapabilities(chain)
  const blockers: string[] = []
  const warnings: string[] = []

  if (!opts.mnemonicConfigured) {
    blockers.push('GAS_MASTER_KEY + GAS_SEED_CIPHERTEXT not configured — mnemonic required')
  }
  if (!opts.rpcReachable) {
    blockers.push('RPC unreachable — check primary and fallback endpoints')
  }
  if (caps.supportsDepositAddress && !opts.depositAddress) {
    blockers.push('No deposit address — set GAS_FEE_DEPOSIT_ADDRESS_* env var or configure mnemonic')
  }
  if (opts.depositSource === 'mnemonic_derived') {
    warnings.push('Deposit address derived from mnemonic hot wallet (no dedicated env var set)')
  }
  if (!caps.supportsAutoDelivery) {
    blockers.push('Delivery not implemented for this chain')
  }
  if (!caps.supportsRefunds) {
    blockers.push('USDT refund not implemented for this chain')
  }
  if (!caps.supportsConfirmation) {
    blockers.push('Tx confirmation check not implemented for this chain')
  }

  return {
    chain,
    deliveryReady:     caps.supportsAutoDelivery && opts.mnemonicConfigured && opts.rpcReachable,
    refundReady:       caps.supportsRefunds && opts.mnemonicConfigured && opts.rpcReachable && !!opts.usdtContract,
    confirmationReady: caps.supportsConfirmation && opts.rpcReachable,
    depositReady:      !!opts.depositAddress,
    depositAddress:    opts.depositAddress,
    depositSource:     opts.depositSource,
    usdtContract:      opts.usdtContract,
    blockers,
    warnings,
  }
}
