/**
 * Single source of truth for coin → networks mapping used by both the
 * deposit and withdraw modals. Keeps the two flows in sync so users can
 * always withdraw on the same network they deposited on.
 *
 * The backend's withdrawal flow is network-agnostic — it looks up a
 * `network_fee_<COIN>_<NETWORK>` config row, and the UI surfaces a
 * "fee unavailable" state if the network isn't configured. So adding a
 * network here only enables it; it doesn't break anything if not yet
 * configured server-side.
 */
// Order matters — the first entry is the default selected network for that
// coin in both the deposit and withdraw modals. We deliberately put the
// cheapest/most-popular-in-Pakistan network first (TRC20 for USDT, ARBITRUM
// for ETH/USDC) so users don't accidentally pick a $20 ERC20 transfer by
// default.
export const COIN_NETWORKS: Record<string, string[]> = {
  USDT: ['BEP20', 'Aptos'],
  USDC: ['POLYGON', 'ARBITRUM', 'OPTIMISM', 'BASE', 'ERC20'],
  ETH:  ['ARBITRUM', 'OPTIMISM', 'BASE', 'ERC20'],
  BNB:  ['BEP20'],
  POL:  ['POLYGON'],
  BTC:  ['Bitcoin'],
  TRX:  ['TRC20'],
}

export function networksFor(coin: string): string[] {
  return COIN_NETWORKS[coin.toUpperCase()] ?? ['BEP20']
}

export function defaultNetworkFor(coin: string): string {
  return networksFor(coin)[0] ?? 'BEP20'
}
