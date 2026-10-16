export type WalletTab = 'methods' | 'portfolio'

/**
 * Maps a URL hash / ?tab= value to a wallet tab.
 *
 * Existing inbound links use `/wallet#payment-methods` (listings, ads, CTM requests), so every
 * unknown value falls back to the Payment methods tab. `#balance` is the legacy name of the tab
 * that is now Portfolio, kept so old bookmarks keep landing on the balance/wallet area.
 */
export function parseWalletTab(hash: string, search = ''): WalletTab {
  const h = hash.replace(/^#/, '').toLowerCase()
  if (h === 'portfolio' || h === 'balance') return 'portfolio'
  if (h) return 'methods'
  const q = new URLSearchParams(search).get('tab')?.toLowerCase()
  if (q === 'portfolio' || q === 'balance') return 'portfolio'
  return 'methods'
}

/** Hash to write when a tab is chosen. Payment methods keeps the URL clean (it is the default). */
export function hashForWalletTab(tab: WalletTab): string {
  return tab === 'portfolio' ? '#portfolio' : ''
}
