/**
 * Listing-interest helpers (pure). Interest is a user's explicit, withdrawable "please list this
 * token" signal. It identifies a token by network + contract ONLY: a bare name is not an identity and
 * would let anyone inflate or split a count by typing names.
 */

export const MIN_GROUP_FLOOR = 10          // the configured threshold can never go below this
export const DEFAULT_MIN_GROUP = 20
export const BUCKET = 5                    // admin-visible counts are rounded DOWN to a multiple of this
export const MAX_ACTIVE_INTERESTS_PER_USER = 20
export const SNAPSHOT_TTL_MS = 60 * 60 * 1000

const HEX_ADDRESS = /^0x[0-9a-fA-F]+$/

/** `network:contract` with the network lower-cased and EVM-style hex addresses lower-cased too. */
export function identityKey(network: string | null | undefined, contract: string | null | undefined): string | null {
  const n = (network ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
  const c = (contract ?? '').trim()
  if (!n || !c) return null
  return `${n}:${HEX_ADDRESS.test(c) ? c.toLowerCase() : c}`
}

export function splitIdentityKey(key: string): { network: string; contract: string } {
  const i = key.indexOf(':')
  return { network: key.slice(0, i), contract: key.slice(i + 1) }
}

export function effectiveThreshold(configured: number): number {
  return Number.isFinite(configured) ? Math.max(MIN_GROUP_FLOOR, Math.floor(configured)) : DEFAULT_MIN_GROUP
}

/** Round DOWN to a multiple of BUCKET, so one person joining or leaving rarely changes what is shown. */
export const bucketDown = (n: number) => Math.floor(n / BUCKET) * BUCKET

export type Trend = 'rising' | 'steady' | 'falling'

export interface GroupCounts {
  identityKey: string
  /** Distinct consenting accounts now. */
  total: number
  /** Consents given in the last 30 days (still active). */
  recent: number
  /** Consents given 30 to 60 days ago (still active). */
  previous: number
  /** How many accounts use each token name (for a "common name" suggestion). */
  names: Array<{ name: string; count: number }>
}

export interface InterestGroup {
  network: string
  contract: string
  /** "At least" this many accounts (rounded down to a multiple of 5). */
  approxAccounts: number
  /** A name only when at least `threshold` accounts use it; otherwise null. */
  commonName: string | null
  trend: Trend
}

export interface InterestReport {
  threshold: number
  groups: InterestGroup[]
  /** Tokens with interest that is below the threshold. Their identity and size are not shown. */
  suppressedGroups: number
}

/**
 * Turn raw group counts into what an admin may see. Groups smaller than `threshold` are dropped
 * completely (not even a rounded number), counts are bucketed, and the trend compares BUCKETED
 * values so a single join cannot flip it.
 */
export function buildInterestReport(groups: GroupCounts[], threshold: number): InterestReport {
  const shown: InterestGroup[] = []
  let suppressed = 0
  for (const g of groups) {
    if (g.total < threshold) { suppressed += 1; continue }
    const best = [...g.names].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))[0]
    const r = bucketDown(g.recent), p = bucketDown(g.previous)
    shown.push({
      ...splitIdentityKey(g.identityKey),
      approxAccounts: bucketDown(g.total),
      commonName: best && best.count >= threshold ? best.name : null,
      trend: r > p ? 'rising' : r < p ? 'falling' : 'steady',
    })
  }
  shown.sort((a, b) => b.approxAccounts - a.approxAccounts || `${a.network}:${a.contract}`.localeCompare(`${b.network}:${b.contract}`))
  return { threshold, groups: shown, suppressedGroups: suppressed }
}
