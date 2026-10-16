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

export const WALLET_TABS: ReadonlyArray<{ id: WalletTab; label: string }> = [
  { id: 'methods', label: 'Payment methods' },
  { id: 'portfolio', label: 'Portfolio' },
]

/**
 * Which tabs the Wallet & Payment Methods page shows.
 *
 * Feature ON: Payment methods + Portfolio, for everyone. The custody wallet (balance, deposits,
 * withdrawals) lives inside Portfolio and keeps its own "has funds / is a maker" gate.
 *
 * Feature OFF: the page is exactly what it was before Portfolio existed. The second tab goes back to
 * "Balance & deposits" and appears only for people with funds or makers; everyone else sees no tabs.
 * Either way nobody loses access to their wallet.
 */
export function walletTabsFor(opts: { portfolioOn: boolean; showBalanceTab: boolean }): {
  secondTabVisible: boolean
  tabs: ReadonlyArray<{ id: WalletTab; label: string }>
} {
  const secondTabVisible = opts.portfolioOn || opts.showBalanceTab
  const first = WALLET_TABS[0]!
  return {
    secondTabVisible,
    tabs: secondTabVisible ? [first, { id: 'portfolio', label: opts.portfolioOn ? 'Portfolio' : 'Balance & deposits' }] : [first],
  }
}