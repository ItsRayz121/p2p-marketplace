/**
 * Loyalty discount resolver for gas orders.
 *
 * Four RupChain-funded offers can discount a gas order's platform MARGIN: the user's
 * points level, their trader rank (Gold and above), an active points-shop perk, and an approved Share & Earn reward. They do
 * NOT stack: only the single highest-percentage offer applies. Promo codes and affiliate
 * discounts are decided earlier and stay as they are; this resolver then keeps the total
 * discount (all sources) at or below `gas_max_discount_pct` of the margin (default 90%),
 * and never below the base gas cost (the discount is margin-only).
 */
import { getNumberConfig } from '../../services/platformFlags.service'
import { getAirdropFeeDiscountPct } from '../../services/airdrop.service'
import { getRankPerks } from '../../services/rankPerks.service'
import { getActiveGasDiscountPct } from '../../services/pointsShop.service'
import { peekShareReward, reserveSpecificShareReward } from './gas.share'

export const MAX_DISCOUNT_PCT_KEY = 'gas_max_discount_pct'
const DEFAULT_MAX_DISCOUNT_PCT = 90

export type LoyaltySource = 'none' | 'level' | 'rank' | 'perk' | 'share'

export interface LoyaltyDiscount {
  discountUsdt: number
  source: LoyaltySource
  pct: number
  /** Set only when the winning offer is a share reward (it was reserved and must be released on failure). */
  rewardId: string | null
}

function round2(n: number): number { return Math.round(n * 100) / 100 }

export async function resolveLoyaltyDiscount(
  userId: string | null | undefined,
  marginUsdt: number,
  alreadyDiscountedUsdt: number,
): Promise<LoyaltyDiscount> {
  const none: LoyaltyDiscount = { discountUsdt: 0, source: 'none', pct: 0, rewardId: null }
  if (!userId || !(marginUsdt > 0)) return none

  const maxPct = Math.min(100, Math.max(0, await getNumberConfig(MAX_DISCOUNT_PCT_KEY, DEFAULT_MAX_DISCOUNT_PCT)))
  const room = round2(Math.max(0, Math.min(marginUsdt - alreadyDiscountedUsdt, (maxPct / 100) * marginUsdt - alreadyDiscountedUsdt)))
  if (room <= 0) return none

  const [levelPct, perkPct, share, rank] = await Promise.all([
    getAirdropFeeDiscountPct(userId),
    getActiveGasDiscountPct(userId),
    peekShareReward(userId),
    getRankPerks(userId),
  ])
  const all: Array<{ source: LoyaltySource; pct: number; rewardId: string | null }> = [
    { source: 'level', pct: levelPct, rewardId: null },
    { source: 'rank', pct: rank.gasDiscountPct, rewardId: null },
    { source: 'perk', pct: perkPct, rewardId: null },
    { source: 'share', pct: share?.discountPct ?? 0, rewardId: share?.id ?? null },
  ]
  const candidates = all.filter((c) => c.pct > 0).sort((a, b) => b.pct - a.pct)

  for (const c of candidates) {
    const discountUsdt = Math.min(round2((Math.min(c.pct, maxPct) / 100) * marginUsdt), room)
    if (discountUsdt <= 0) continue
    if (c.source === 'share') {
      // Reserve atomically; if someone else grabbed it, fall through to the next best offer.
      if (!c.rewardId || !(await reserveSpecificShareReward(c.rewardId))) continue
    }
    return { discountUsdt, source: c.source, pct: c.pct, rewardId: c.rewardId }
  }
  return none
}
