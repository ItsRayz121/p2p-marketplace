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
  /** Platform can refund payment if delivery fails. */
  supportsRefunds: boolean
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
    supportsMnemonic:       true,
    supportsAutoDelivery:   true,
    supportsStablecoins:    true,
    supportsRefunds:        true,
    supportsMonitoring:     true,
    supportsRpcHealthCheck: true,
    supportsDryRun:         false,
  },
  BSC: {
    supportsMnemonic:       true,
    supportsAutoDelivery:   true,
    supportsStablecoins:    true,
    supportsRefunds:        true,
    supportsMonitoring:     true,
    supportsRpcHealthCheck: true,
    supportsDryRun:         false,
  },
  ETH: {
    supportsMnemonic:       true,
    supportsAutoDelivery:   true,
    supportsStablecoins:    true,
    supportsRefunds:        true,
    supportsMonitoring:     true,
    supportsRpcHealthCheck: true,
    supportsDryRun:         false,
  },
  BASE: {
    supportsMnemonic:       true,
    supportsAutoDelivery:   true,
    supportsStablecoins:    true,
    supportsRefunds:        true,
    supportsMonitoring:     true,
    supportsRpcHealthCheck: true,
    supportsDryRun:         false,
  },
  ARB: {
    supportsMnemonic:       true,
    supportsAutoDelivery:   true,
    supportsStablecoins:    true,
    supportsRefunds:        true,
    supportsMonitoring:     true,
    supportsRpcHealthCheck: true,
    supportsDryRun:         false,
  },
  OP: {
    supportsMnemonic:       true,
    supportsAutoDelivery:   true,
    supportsStablecoins:    true,
    supportsRefunds:        true,
    supportsMonitoring:     true,
    supportsRpcHealthCheck: true,
    supportsDryRun:         false,
  },
  MATIC: {
    supportsMnemonic:       true,
    supportsAutoDelivery:   true,
    supportsStablecoins:    true,
    supportsRefunds:        true,
    supportsMonitoring:     true,
    supportsRpcHealthCheck: true,
    supportsDryRun:         false,
  },
  AVAX: {
    supportsMnemonic:       true,
    supportsAutoDelivery:   true,
    supportsStablecoins:    true,
    supportsRefunds:        true,
    supportsMonitoring:     true,
    supportsRpcHealthCheck: true,
    supportsDryRun:         false,
  },
  SOL: {
    supportsMnemonic:       true,
    supportsAutoDelivery:   false,  // delivery not yet implemented
    supportsStablecoins:    false,  // USDT-on-SOL not yet wired
    supportsRefunds:        false,
    supportsMonitoring:     true,
    supportsRpcHealthCheck: true,
    supportsDryRun:         true,
  },
  TON: {
    supportsMnemonic:       true,
    supportsAutoDelivery:   false,  // requires @ton/core + V4R2 wallet
    supportsStablecoins:    false,
    supportsRefunds:        false,
    supportsMonitoring:     true,
    supportsRpcHealthCheck: true,
    supportsDryRun:         true,
  },
  SUI: {
    supportsMnemonic:       true,
    supportsAutoDelivery:   false,  // requires @mysten/sui SDK for tx signing
    supportsStablecoins:    false,
    supportsRefunds:        false,
    supportsMonitoring:     true,
    supportsRpcHealthCheck: true,
    supportsDryRun:         true,
  },
}

export function getChainCapabilities(chainSlug: string): ChainCapabilities {
  return CHAIN_CAPABILITIES[chainSlug.toUpperCase()] ?? {
    supportsMnemonic:       false,
    supportsAutoDelivery:   false,
    supportsStablecoins:    false,
    supportsRefunds:        false,
    supportsMonitoring:     false,
    supportsRpcHealthCheck: false,
    supportsDryRun:         false,
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
    recommendedState: 'inactive',
    deliveryReady: false,
    blockers: [
      'Delivery not implemented — requires @solana/web3.js or equivalent for signing',
      'No USDT-SPL payment token wired',
      'GasHotWallet DB row not yet seeded for SOL',
    ],
    notes: 'Key derivation + address generation complete. RPC health check implemented. Activate once delivery module is added.',
  },
  {
    chain: 'TON',
    recommendedState: 'inactive',
    deliveryReady: false,
    blockers: [
      'TON V4R2 wallet address derivation requires @ton/core (TL-B cell serialization)',
      'Delivery not implemented — requires @ton/ton for transaction signing',
      'Current address is a sha256 placeholder — NOT a real TON address',
      'GasHotWallet DB row not yet seeded for TON',
    ],
    notes: 'SLIP-0010 key derivation complete. Full activation requires @ton/core + @ton/ton packages.',
  },
  {
    chain: 'SUI',
    recommendedState: 'inactive',
    deliveryReady: false,
    blockers: [
      'Delivery not implemented — requires @mysten/sui for transaction building',
      'blake2b-256 availability must be verified on production host (Node 20 + OpenSSL 3)',
      'No USDT-on-SUI payment token wired',
      'GasHotWallet DB row not yet seeded for SUI',
    ],
    notes: 'SLIP-0010 key derivation complete. Address correct only if blake2b-256 available. Verify before activation.',
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
    feature: 'Auto delivery',
    affectedChains: ['SOL', 'TON', 'SUI'],
    reason: 'Chain-specific SDK not installed (no npm packages for non-EVM signing)',
    resolution: 'Add @solana/web3.js, @ton/ton, @mysten/sui to dependencies',
  },
  {
    feature: 'Stablecoin payment acceptance',
    affectedChains: ['SOL', 'TON', 'SUI'],
    reason: 'SPL/Jetton/SUI token payment detection not implemented in deposit watcher',
    resolution: 'Extend depositWatcher to detect non-EVM token transfers',
  },
  {
    feature: 'Refund flow',
    affectedChains: ['SOL', 'TON', 'SUI'],
    reason: 'Refunds require delivery to work first',
    resolution: 'Implement after delivery is live and proven',
  },
  {
    feature: 'Exact TON V4R2 address',
    affectedChains: ['TON'],
    reason: 'StateInit hash requires TL-B cell serialization (@ton/core)',
    resolution: 'Install @ton/core and replace placeholder in tonWalletService.ts',
  },
  {
    feature: 'SUI address on non-blake2b hosts',
    affectedChains: ['SUI'],
    reason: 'sha3-256 fallback produces wrong address if OpenSSL lacks blake2b-256',
    resolution: 'Verify Node 20 + OpenSSL 3 on production host; check startup log',
  },
]
