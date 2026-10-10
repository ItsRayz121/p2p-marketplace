// Which referral-network views are available. Both are on for now; flip a flag to hide
// one without deleting any code or touching referral data. Override per deployment with
// NEXT_PUBLIC_REFERRAL_VIEWS, e.g. "bubble" or "branch" or "bubble,branch".
//
// If only one view is enabled the tab switcher is not shown.

export type NetworkView = 'bubble' | 'branch'

const DEFAULTS: Record<NetworkView, boolean> = {
  bubble: true,
  branch: true,
}

export function enabledViews(): NetworkView[] {
  const raw = process.env.NEXT_PUBLIC_REFERRAL_VIEWS
  const on = raw
    ? (raw.split(',').map((s) => s.trim().toLowerCase()).filter((s): s is NetworkView => s === 'bubble' || s === 'branch'))
    : (Object.keys(DEFAULTS) as NetworkView[]).filter((v) => DEFAULTS[v])
  // Never end up with nothing to show: fall back to the Bubble Map.
  return on.length ? on : ['bubble']
}

/** How often the network is re-fetched while the tab is visible (not a live push). */
export const NETWORK_REFRESH_MS = 5 * 60_000
