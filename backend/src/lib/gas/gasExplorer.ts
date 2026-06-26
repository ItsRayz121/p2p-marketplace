// Canonical block-explorer transaction URL builder for gas chains.
//
// Derives the correct per-chain tx link from the chain's stored config (explorerBase
// + addressType/category/slug) rather than a hardcoded per-chain map, so EVERY chain
// we provide gas for — and any chain added later — gets a working link automatically
// as long as its explorerBase is set. Path conventions differ by chain family:
//   • TRON (Tronscan):       <base>/#/transaction/<hash>
//   • Aptos (Aptos Explorer):<base>/txn/<hash>   (also handles synthetic aptos:ver:idx)
//   • SUI (Sui Explorer):    <base>/txblock/<hash>
//   • EVM / Solana / TON / default: <base>/tx/<hash>
// Returns null when we can't build a usable link (no explorerBase or no hash).

export interface ExplorerChainInfo {
  explorerBase: string | null
  addressType?: string | null
  category?: string | null
  slug?: string | null
}

export function buildGasExplorerTxUrl(chain: ExplorerChainInfo, txHash: string | null | undefined): string | null {
  if (!chain.explorerBase || !txHash) return null
  const base = chain.explorerBase.replace(/\/+$/, '')
  const addr = (chain.addressType ?? '').toUpperCase()
  const cat = (chain.category ?? '').toLowerCase()
  const slug = (chain.slug ?? '').toUpperCase()

  const isTron = addr === 'TRC20' || addr === 'TRON' || cat === 'tron' || slug === 'TRON'
  const isAptos = addr === 'APTOS' || addr === 'APT' || cat === 'aptos' || slug === 'APT' || slug === 'APTOS'
  const isSui = addr === 'SUI' || cat === 'sui' || slug === 'SUI'

  if (isTron) return `${base}/#/transaction/${txHash}`
  if (isAptos) {
    // Aptos delivery/payment hashes may be synthetic "aptos:<version>:<idx>" — link by version.
    const m = /^aptos:(\d+):/.exec(txHash)
    return `${base}/txn/${m ? m[1] : txHash}`
  }
  if (isSui) return `${base}/txblock/${txHash}`
  // EVM (etherscan-likes), Solana (solscan), TON (tonscan) and anything new default to /tx/.
  return `${base}/tx/${txHash}`
}
