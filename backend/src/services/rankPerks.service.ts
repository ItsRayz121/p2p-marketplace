/**
 * Trader-rank perks. A user's rank is their TradeStats badge (Bronze → Silver → Gold → Diamond → Elite).
 *  - Gas discount: Gold and above get a small % off the gas-order margin. It competes with the
 *    other loyalty offers (highest single offer wins; see gas.loyalty.ts), so it never stacks.
 *  - Points bonus: Gold and above earn a few % more points on trades and gas orders.
 *  - Listing priority: Elite sellers' ads list ahead of ordinary ads (after Points-boosted ads).
 * All values are admin-tunable PlatformConfig keys; `rank_perks_enabled=false` switches every perk off.
 */
import { db } from '../lib/prisma'
import { getBoolConfig, getNumberConfig } from './platformFlags.service'

export type RankBadge = 'new' | 'active' | 'trusted' | 'top' | 'elite'

export const RANK_PERKS_ENABLED_KEY = 'rank_perks_enabled'
export const RANK_LISTING_PRIORITY_KEY = 'rank_listing_priority_elite'

const RANK_LABEL: Record<RankBadge, string> = { new: 'Bronze', active: 'Silver', trusted: 'Gold', top: 'Diamond', elite: 'Elite' }

// Defaults are deliberately small; the gas discount is also bounded by gas_max_discount_pct.
const DEFAULT_GAS_DISCOUNT_PCT: Record<RankBadge, number> = { new: 0, active: 0, trusted: 3, top: 4, elite: 5 }
const DEFAULT_POINTS_BONUS_PCT: Record<RankBadge, number> = { new: 0, active: 0, trusted: 5, top: 10, elite: 15 }

const gasKey = (b: RankBadge) => `rank_gas_discount_pct_${b}`
const pointsKey = (b: RankBadge) => `rank_points_bonus_pct_${b}`

export interface RankPerks {
  badge: RankBadge
  rankLabel: string
  gasDiscountPct: number
  pointsBonusPct: number
  listingPriority: boolean
}

const ZERO = (badge: RankBadge): RankPerks => ({ badge, rankLabel: RANK_LABEL[badge], gasDiscountPct: 0, pointsBonusPct: 0, listingPriority: false })

const clampPct = (n: number, max: number) => (Number.isFinite(n) ? Math.min(max, Math.max(0, n)) : 0)

export function isRankBadge(v: unknown): v is RankBadge {
  return v === 'new' || v === 'active' || v === 'trusted' || v === 'top' || v === 'elite'
}

export async function getRankPerksForBadge(badge: RankBadge): Promise<RankPerks> {
  if (!(await getBoolConfig(RANK_PERKS_ENABLED_KEY, true))) return ZERO(badge)
  const [gas, pts, prio] = await Promise.all([
    getNumberConfig(gasKey(badge), DEFAULT_GAS_DISCOUNT_PCT[badge]),
    getNumberConfig(pointsKey(badge), DEFAULT_POINTS_BONUS_PCT[badge]),
    badge === 'elite' ? getBoolConfig(RANK_LISTING_PRIORITY_KEY, true) : Promise.resolve(false),
  ])
  return { badge, rankLabel: RANK_LABEL[badge], gasDiscountPct: clampPct(gas, 50), pointsBonusPct: clampPct(pts, 100), listingPriority: prio }
}

export async function getRankPerks(userId: string | null | undefined): Promise<RankPerks> {
  if (!userId) return ZERO('new')
  const row = await db.tradeStats.findUnique({ where: { userId }, select: { badge: true } })
  const badge: RankBadge = isRankBadge(row?.badge) ? row.badge : 'new'
  return getRankPerksForBadge(badge)
}

/** Multiplier applied to points a user earns (1 = no bonus). */
export async function getRankPointsMultiplier(userId: string): Promise<number> {
  const p = await getRankPerks(userId)
  return 1 + p.pointsBonusPct / 100
}

/** Whether Elite listing priority is currently active (used by the ad list). */
export async function isEliteListingPriorityOn(): Promise<boolean> {
  return (await getBoolConfig(RANK_PERKS_ENABLED_KEY, true)) && (await getBoolConfig(RANK_LISTING_PRIORITY_KEY, true))
}
