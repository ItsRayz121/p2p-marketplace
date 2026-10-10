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
import { getBoolConfig } from './platformFlags.service'
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

export const BOOST_ENABLED_KEY = 'ad_boost_enabled'

/** Admin master switch. Default ON; turning it off stops new boosts (running ones finish unless refunded). */
export const isBoostEnabled = () => getBoolConfig(BOOST_ENABLED_KEY, true)

export async function setBoostEnabled(enabled: boolean): Promise<void> {
  const value = enabled ? 'true' : 'false'
  await db.platformConfig.upsert({ where: { key: BOOST_ENABLED_KEY }, update: { value }, create: { key: BOOST_ENABLED_KEY, value } })
}

export type BoostKind = 'ad' | 'ctm'

/** Reads the boost-relevant fields of an ad or CTM listing, with ownership resolved to a userId. */
async function loadBoostTarget(tx: Prisma.TransactionClient, kind: BoostKind, id: string) {
  if (kind === 'ctm') {
    const l = await tx.ctmListing.findUnique({ where: { id }, select: { status: true, boostedUntil: true, merchantProfile: { select: { userId: true } } } })
    return l ? { userId: l.merchantProfile.userId, status: l.status as string, boostedUntil: l.boostedUntil } : null
  }
  const a = await tx.ad.findUnique({ where: { id }, select: { userId: true, status: true, boostedUntil: true } })
  return a ? { userId: a.userId, status: a.status as string, boostedUntil: a.boostedUntil } : null
}

async function applyBoost(tx: Prisma.TransactionClient, kind: BoostKind, id: string, from: Date | null, until: Date) {
  const where = { id, boostedUntil: from }
  const data = { boostedUntil: until }
  return kind === 'ctm' ? tx.ctmListing.updateMany({ where, data }) : tx.ad.updateMany({ where, data })
}

export async function boostAd(userId: string, adId: string, planKey: string, kind: BoostKind = 'ad'): Promise<{ boostedUntil: string; balance: number }> {
  if (!(await isAirdropEnabledFor(userId))) throw new AppError('POINTS_OFF', 'RupChain Points are not available right now.', 400)
  if (!(await isBoostEnabled())) throw new AppError('BOOST_OFF', 'Boosting is paused right now. Your Points were not charged.', 400)
  const plan = (await getBoostPlans()).find((p) => p.key === planKey)
  if (!plan) throw new AppError('NOT_FOUND', 'That boost option does not exist.', 404)

  const cost = new Prisma.Decimal(plan.cost)
  const result = await db.$transaction(async (tx) => {
    const ad = await loadBoostTarget(tx, kind, adId)
    // Same answer for "not found" and "not yours" so IDs can't be probed.
    if (!ad || ad.userId !== userId) throw new AppError('NOT_FOUND', kind === 'ctm' ? 'Listing not found.' : 'Ad not found.', 404)
    if (ad.status !== 'active') throw new AppError('AD_NOT_ACTIVE', kind === 'ctm' ? 'Only active listings can be boosted.' : 'Only active ads can be boosted.', 400)

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
        metadata: { boost: adId, plan: plan.key, kind, hours: plan.hours },
      },
    })
    // Optimistic guard: only apply if nobody changed the boost since we read it, so two
    // simultaneous requests can't both charge for the same extension. A mismatch throws,
    // which rolls the whole transaction (including the points deduction) back.
    const applied = await applyBoost(tx, kind, adId, ad.boostedUntil, until)
    if (applied.count !== 1) throw new AppError('BOOST_CONFLICT', 'This listing was just boosted. Refresh and try again.', 409)
    const acc = await tx.airdropAccount.findUnique({ where: { userId_seasonId: { userId, seasonId: season.id } }, select: { totalPoints: true } })
    return { boostedUntil: until.toISOString(), balance: Number(acc?.totalPoints ?? 0) }
  })
  return result
}

export interface BoostRefundResult { refunded: number; users: number; listings: number }

/**
 * Refund the unused part of every boost that is still running, and end it. A listing's
 * refund is the Points its owner paid for it (read from the ledger) scaled by the share
 * of purchased hours still ahead, rounded down. Safe to repeat: the boost is cleared in
 * the same transaction, and the ledger key is tied to that boost's end time.
 */
export async function refundActiveBoosts(): Promise<BoostRefundResult> {
  const now = new Date()
  const [ads, ctm] = await Promise.all([
    db.ad.findMany({ where: { boostedUntil: { gt: now } }, select: { id: true, userId: true, boostedUntil: true } }),
    db.ctmListing.findMany({ where: { boostedUntil: { gt: now } }, select: { id: true, boostedUntil: true, merchantProfile: { select: { userId: true } } } }),
  ])
  const targets = [
    ...ads.map((a) => ({ kind: 'ad' as BoostKind, id: a.id, userId: a.userId, until: a.boostedUntil! })),
    ...ctm.map((l) => ({ kind: 'ctm' as BoostKind, id: l.id, userId: l.merchantProfile.userId, until: l.boostedUntil! })),
  ]
  const plans = await getBoostPlans()
  let refunded = 0
  let listings = 0
  const users = new Set<string>()

  for (const t of targets) {
    await db.$transaction(async (tx) => {
      const rows = await tx.airdropLedger.findMany({
        where: { userId: t.userId, source: 'redeem', metadata: { path: ['boost'], equals: t.id } },
        select: { points: true, metadata: true },
      })
      let paid = 0
      let hours = 0
      for (const r of rows) {
        const m = r.metadata as { plan?: string; hours?: number } | null
        const h = Number(m?.hours) || plans.find((p) => p.key === m?.plan)?.hours || 0
        if (h <= 0) continue // unknown duration (old row, plan since removed): leave it out of both sides rather than guess
        hours += h
        paid += Math.abs(Number(r.points))
      }
      const remainingHours = (t.until.getTime() - now.getTime()) / 3_600_000
      const amount = hours > 0 ? Math.min(paid, Math.floor(paid * Math.min(1, remainingHours / hours))) : 0
      const where = { id: t.id, boostedUntil: t.until }
      const cleared = t.kind === 'ctm'
        ? await tx.ctmListing.updateMany({ where, data: { boostedUntil: null } })
        : await tx.ad.updateMany({ where, data: { boostedUntil: null } })
      if (cleared.count !== 1) return // changed under us; skip rather than risk a double refund
      listings++
      if (amount <= 0) return
      const season = await tx.airdropSeason.findFirst({ where: { status: 'active' }, orderBy: { index: 'desc' }, select: { id: true } })
      if (!season) return
      await tx.airdropAccount.upsert({
        where: { userId_seasonId: { userId: t.userId, seasonId: season.id } },
        update: { totalPoints: { increment: amount } },
        create: { userId: t.userId, seasonId: season.id, totalPoints: amount },
      })
      await tx.airdropLedger.create({
        data: {
          userId: t.userId, seasonId: season.id, source: 'admin_adjust', points: new Prisma.Decimal(amount),
          eventKey: `boostrefund:${t.kind}:${t.id}:${t.until.getTime()}`,
          metadata: { boostRefund: t.id, kind: t.kind },
        },
      })
      refunded += amount
      users.add(t.userId)
    })
  }
  return { refunded, users: users.size, listings }
}
