/**
 * Listing boost — spend RupChain Points to list a USDT ad above un-boosted ads for a
 * fixed period. Points only (no real money). Boosts never touch ad price, terms, review
 * status or the owner's trader rank: they only change list order and add a "Featured" label.
 */
import { randomBytes } from 'crypto'
import { Prisma } from '@prisma/client'
import { db } from '../lib/prisma'
import { AppError } from '../lib/errors'
import { isAirdropEnabledFor } from './airdrop.service'
import { DEFAULT_BOOST_PLANS, MAX_BOOST_HOURS, nextBoostEnd, validPlan, type BoostPlan } from './adBoost.rules'

export { MAX_BOOST_HOURS, type BoostPlan }
export const BOOST_PLANS_KEY = 'ad_boost_plans'

/** Plans live in code and can be replaced from admin config (`ad_boost_plans`, JSON array). */
export async function getBoostPlans(): Promise<BoostPlan[]> {
  const row = await db.platformConfig.findUnique({ where: { key: BOOST_PLANS_KEY } })
  if (row?.value) {
    try {
      const parsed = JSON.parse(row.value) as unknown
      if (Array.isArray(parsed)) {
        const plans = parsed.map(validPlan).filter((p): p is BoostPlan => !!p)
        if (plans.length > 0) return plans
      }
    } catch { /* fall back to defaults */ }
  }
  return DEFAULT_BOOST_PLANS
}

export async function boostAd(userId: string, adId: string, planKey: string): Promise<{ boostedUntil: string; balance: number }> {
  if (!(await isAirdropEnabledFor(userId))) throw new AppError('POINTS_OFF', 'RupChain Points are not available right now.', 400)
  const plan = (await getBoostPlans()).find((p) => p.key === planKey)
  if (!plan) throw new AppError('NOT_FOUND', 'That boost option does not exist.', 404)

  const cost = new Prisma.Decimal(plan.cost)
  const result = await db.$transaction(async (tx) => {
    const ad = await tx.ad.findUnique({ where: { id: adId }, select: { userId: true, status: true, boostedUntil: true, coin: true } })
    // Same answer for "not found" and "not yours" so ad IDs can't be probed.
    if (!ad || ad.userId !== userId) throw new AppError('NOT_FOUND', 'Ad not found.', 404)
    if (ad.status !== 'active') throw new AppError('AD_NOT_ACTIVE', 'Only active ads can be boosted.', 400)

    const now = new Date()
    const until = nextBoostEnd(now, ad.boostedUntil, plan.hours)
    if (!until) throw new AppError('BOOST_CAP', `An ad can be boosted up to ${MAX_BOOST_HOURS / 24} days ahead. Try again once the current boost runs down.`, 409)

    const season = await tx.airdropSeason.findFirst({ where: { status: 'active' }, orderBy: { index: 'desc' }, select: { id: true } })
    if (!season) throw new AppError('POINTS_OFF', 'No active points season.', 400)
    // Guarded conditional decrement: a double-submit can never spend the same points twice.
    const flip = await tx.airdropAccount.updateMany({
      where: { userId, seasonId: season.id, totalPoints: { gte: cost } },
      data: { totalPoints: { decrement: cost } },
    })
    if (flip.count !== 1) throw new AppError('INSUFFICIENT_POINTS', `You need ${plan.cost} points for this boost.`, 400)
    await tx.airdropLedger.create({
      data: {
        userId, seasonId: season.id, source: 'redeem', points: cost.negated(),
        eventKey: `boost:${userId}:${Date.now()}:${randomBytes(4).toString('hex')}`,
        metadata: { boost: adId, plan: plan.key },
      },
    })
    // Optimistic guard: only apply if nobody changed the boost since we read it, so two
    // simultaneous requests can't both charge for the same extension. A mismatch throws,
    // which rolls the whole transaction (including the points deduction) back.
    const applied = await tx.ad.updateMany({ where: { id: adId, boostedUntil: ad.boostedUntil }, data: { boostedUntil: until } })
    if (applied.count !== 1) throw new AppError('BOOST_CONFLICT', 'This ad was just boosted. Refresh and try again.', 409)
    const acc = await tx.airdropAccount.findUnique({ where: { userId_seasonId: { userId, seasonId: season.id } }, select: { totalPoints: true } })
    return { boostedUntil: until.toISOString(), balance: Number(acc?.totalPoints ?? 0) }
  })
  return result
}
