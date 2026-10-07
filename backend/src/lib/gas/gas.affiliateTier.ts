/**
 * Affiliate commission tiers.
 *
 * An APPROVED affiliate earns a % of the platform margin on every delivered gas order placed
 * by someone they referred. The % rises as their referred users complete more orders:
 * Starter 30% → Silver 40% → Gold 50% → Elite 60% (defaults; admin can replace the ladder with
 * JSON under `gas_affiliate_tiers`). The metric is lifetime delivered paid orders by referred
 * users (each is exactly one level-1 accrual), so a tier is never lost.
 *
 * Commission stays margin-only: the accrual is still capped at the margin the platform kept
 * after discounts, so a high tier can never pay out more than was earned.
 */
import { db } from '../prisma'
import { getNumberConfig } from '../../services/platformFlags.service'

export const AFFILIATE_TIERS_KEY = 'gas_affiliate_tiers'
// Standard commission for regular referrers (same key + default as gas.referral; kept here to avoid an import cycle).
const STANDARD_PCT_CONFIG = 'gas_referral_default_pct'
const STANDARD_PCT = 10

export interface AffiliateTier {
  key: string
  name: string
  minOrders: number
  pct: number
}

export const DEFAULT_TIERS: AffiliateTier[] = [
  { key: 'starter', name: 'Starter', minOrders: 0, pct: 30 },
  { key: 'silver', name: 'Silver', minOrders: 20, pct: 40 },
  { key: 'gold', name: 'Gold', minOrders: 75, pct: 50 },
  { key: 'elite', name: 'Elite', minOrders: 200, pct: 60 },
]

function parseTiers(raw: string | undefined): AffiliateTier[] | null {
  if (!raw) return null
  try {
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return null
    const out: AffiliateTier[] = []
    for (const o of arr) {
      const r = o as Record<string, unknown>
      const name = typeof r?.name === 'string' ? r.name.trim() : ''
      const minOrders = Number(r?.minOrders)
      const pct = Number(r?.pct)
      if (!name || !Number.isFinite(minOrders) || minOrders < 0 || !Number.isFinite(pct) || pct <= 0 || pct > 90) continue
      out.push({ key: name.toLowerCase().replace(/[^a-z0-9]+/g, '_'), name, minOrders: Math.floor(minOrders), pct })
    }
    return out.length > 0 ? out.sort((a, b) => a.minOrders - b.minOrders) : null
  } catch { return null }
}

/** Tiers low → high. The first tier must start at 0 orders so everyone has a tier. */
export async function loadTiers(): Promise<AffiliateTier[]> {
  const row = await db.platformConfig.findUnique({ where: { key: AFFILIATE_TIERS_KEY } })
  const tiers = parseTiers(row?.value) ?? DEFAULT_TIERS
  return tiers[0]!.minOrders === 0 ? tiers : [{ key: 'base', name: 'Starter', minOrders: 0, pct: tiers[0]!.pct }, ...tiers]
}

export interface AffiliateTierInfo {
  orders: number
  tier: AffiliateTier
  next: AffiliateTier | null
  ordersToNext: number | null
  /** 0..100 progress between this tier's threshold and the next. */
  progressPct: number
  tiers: AffiliateTier[]
}

export function tierFor(orders: number, tiers: AffiliateTier[]): { tier: AffiliateTier; next: AffiliateTier | null } {
  let idx = 0
  for (let i = 0; i < tiers.length; i++) if (orders >= tiers[i]!.minOrders) idx = i
  return { tier: tiers[idx]!, next: tiers[idx + 1] ?? null }
}

/** Delivered paid orders by people this user referred (one level-1 accrual per order). */
export async function countReferredOrders(userId: string): Promise<number> {
  return db.gasReferralAccrual.count({ where: { referrerId: userId, level: 1 } })
}

export async function getAffiliateTierInfo(userId: string): Promise<AffiliateTierInfo> {
  const [tiers, orders] = await Promise.all([loadTiers(), countReferredOrders(userId)])
  const { tier, next } = tierFor(orders, tiers)
  const span = next ? next.minOrders - tier.minOrders : 0
  const progressPct = next && span > 0 ? Math.min(100, Math.max(0, ((orders - tier.minOrders) / span) * 100)) : 100
  return { orders, tier, next, ordersToNext: next ? Math.max(0, next.minOrders - orders) : null, progressPct, tiers }
}

/**
 * Commission % actually paid for an order. Approved affiliates get the higher of their link's
 * own % and their tier %; everyone else keeps the link's %.
 */
export async function effectiveCommissionPct(referrerId: string, linkPct: number): Promise<number> {
  const aff = await db.gasAffiliate.findUnique({ where: { userId: referrerId }, select: { status: true } })
  if (aff?.status !== 'approved') {
    // Regular referrers earn the standard rate (10% by default) even on older links created at 5%.
    const standard = await getNumberConfig(STANDARD_PCT_CONFIG, STANDARD_PCT)
    return Math.max(linkPct, standard)
  }
  const { tier } = await getAffiliateTierInfo(referrerId)
  return Math.max(linkPct, tier.pct)
}
