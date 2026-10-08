import { db } from '../prisma'

/**
 * Read-only reporting over every gas promotion program. Nothing here writes or
 * changes eligibility, budgets, rewards or settlement — it only reads the records
 * those systems already keep.
 *
 * Metric definitions (also shown in the admin UI):
 *  - Reward cost        what the platform actually gave up, on DELIVERED orders only:
 *                         promo / share reward   → the margin discount (discountUsdt)
 *                         free code / giveaway / direct free gas → the gas value delivered (gasAmountUSD)
 *  - Gross margin       platformMarginUsdt on delivered orders, BEFORE any discount.
 *                       Customer payment volume is never counted as revenue.
 *  - Net contribution   gross margin − reward cost − affiliate commission accrued on the same orders.
 *                       Discounts and commissions are each subtracted once; they come out of margin only.
 *  - Committed budget   the cap an admin set; Spent budget is what the system has reserved so far.
 *                       Committed ≠ actual spend, and reserved spend can exceed delivered cost while orders are in flight.
 *  - Not tracked        the field cannot be derived from stored data (returned as null, never guessed).
 *  Attribution shows which orders used a code. It is NOT evidence the code caused the sale.
 */

export type ProgramKey = 'promo_code' | 'free_code' | 'giveaway' | 'community_giveaway' | 'direct_free_gas' | 'share_reward'

export interface CampaignRow {
  program: ProgramKey
  id: string
  name: string
  label: string | null
  status: 'active' | 'expired' | 'disabled' | 'exhausted' | 'open' | 'closed' | 'drawn'
  createdAt: Date
  redemptions: number
  uniqueRedeemers: number
  completedOrders: number
  refundedOrders: number
  grossMarginUsdt: number | null
  rewardCostUsdt: number | null
  commissionUsdt: number | null
  netContributionUsdt: number | null
  budgetUsdt: number | null
  spentUsdt: number | null
  insufficientData: boolean
}

const round = (n: number) => Math.round(n * 10000) / 10000
const num = (v: unknown) => (v == null ? 0 : Number(v))
/** Below this many redemptions a campaign's averages/rankings are too noisy to compare. */
export const MIN_SAMPLE = 10

function startFor(days: number | null): Date | null {
  return days ? new Date(Date.now() - days * 86_400_000) : null
}

export async function promotionsOverview(days: number | null) {
  const since = startFor(days)
  const orderRange = since ? { createdAt: { gte: since } } : {}
  const now = new Date()

  // ── Promo codes ────────────────────────────────────────────────────────────
  const [promoCodes, promoRedemptions, promoCommissions] = await Promise.all([
    db.gasPromoCode.findMany({ orderBy: { createdAt: 'desc' } }),
    db.gasPromoRedemption.findMany({
      where: since ? { createdAt: { gte: since } } : {},
      take: 50_000,
      select: {
        promoCodeId: true, identity: true, createdAt: true, discountUsdt: true,
        order: { select: { id: true, status: true, platformMarginUsdt: true, discountUsdt: true, refundAmount: true } },
      },
    }),
    db.gasReferralAccrual.findMany({
      where: { status: { not: 'reversed' }, order: { promoCodeId: { not: null }, status: 'delivered', ...orderRange } },
      select: { amountUsdt: true, order: { select: { promoCodeId: true } } },
    }),
  ])
  const promoComm = new Map<string, number>()
  for (const c of promoCommissions) {
    const k = c.order.promoCodeId
    if (k) promoComm.set(k, (promoComm.get(k) ?? 0) + num(c.amountUsdt))
  }
  const promoRows: CampaignRow[] = promoCodes.map((c) => {
    const reds = promoRedemptions.filter((r) => r.promoCodeId === c.id)
    const delivered = reds.filter((r) => r.order.status === 'delivered')
    const gross = delivered.reduce((s, r) => s + num(r.order.platformMarginUsdt), 0)
    const cost = delivered.reduce((s, r) => s + num(r.order.discountUsdt), 0)
    const comm = promoComm.get(c.id) ?? 0
    const expired = c.expiresAt ? c.expiresAt < now : false
    const exhausted = c.marginSpentUsdt >= c.marginBudgetUsdt
    return {
      program: 'promo_code', id: c.id, name: c.code, label: c.ownerLabel,
      status: !c.isActive ? (exhausted ? 'exhausted' : 'disabled') : expired ? 'expired' : 'active',
      createdAt: c.createdAt,
      redemptions: reds.length,
      uniqueRedeemers: new Set(reds.map((r) => r.identity)).size,
      completedOrders: delivered.length,
      refundedOrders: reds.filter((r) => r.order.status === 'refunded').length,
      grossMarginUsdt: round(gross), rewardCostUsdt: round(cost), commissionUsdt: round(comm),
      netContributionUsdt: round(gross - cost - comm),
      budgetUsdt: c.marginBudgetUsdt, spentUsdt: c.marginSpentUsdt,
      insufficientData: reds.length < MIN_SAMPLE,
    }
  })

  // ── Free codes ─────────────────────────────────────────────────────────────
  const [freeCodes, freeRedemptions] = await Promise.all([
    db.gasFreeCode.findMany({ orderBy: { createdAt: 'desc' } }),
    db.gasFreeCodeRedemption.findMany({
      where: since ? { createdAt: { gte: since } } : {},
      take: 50_000,
      select: { freeCodeId: true, identity: true, createdAt: true, order: { select: { status: true, gasAmountUSD: true } } },
    }),
  ])
  const freeRows: CampaignRow[] = freeCodes.map((c) => {
    const reds = freeRedemptions.filter((r) => r.freeCodeId === c.id)
    const delivered = reds.filter((r) => r.order.status === 'delivered')
    const cost = delivered.reduce((s, r) => s + num(r.order.gasAmountUSD), 0)
    const expired = c.expiresAt ? c.expiresAt < now : false
    return {
      program: 'free_code', id: c.id, name: c.code, label: c.kolLabel,
      status: !c.isActive ? (c.redeemedCount >= c.slotLimit || c.spentUsdt >= c.budgetUsdt ? 'exhausted' : 'disabled') : expired ? 'expired' : 'active',
      createdAt: c.createdAt,
      redemptions: reds.length,
      uniqueRedeemers: new Set(reds.map((r) => r.identity)).size,
      completedOrders: delivered.length,
      refundedOrders: reds.filter((r) => r.order.status === 'refunded').length,
      // Free orders carry no customer payment, and no downstream sales are attributed to them.
      grossMarginUsdt: null, rewardCostUsdt: round(cost), commissionUsdt: null,
      netContributionUsdt: null,
      budgetUsdt: c.budgetUsdt, spentUsdt: c.spentUsdt,
      insufficientData: reds.length < MIN_SAMPLE,
    }
  })

  // ── Platform gas giveaways ─────────────────────────────────────────────────
  const [giveaways, entries] = await Promise.all([
    db.gasGiveawayCampaign.findMany({ orderBy: { createdAt: 'desc' } }),
    db.gasGiveawayEntry.findMany({ select: { campaignId: true, userId: true, status: true, orderId: true } }),
  ])
  const giveawayOrderIds = entries.map((e) => e.orderId).filter((x): x is string => !!x)
  const giveawayOrders = giveawayOrderIds.length
    ? await db.gasFeeOrder.findMany({ where: { id: { in: giveawayOrderIds }, ...orderRange }, select: { id: true, status: true, gasAmountUSD: true } })
    : []
  const goById = new Map(giveawayOrders.map((o) => [o.id, o]))
  const giveawayRows: CampaignRow[] = giveaways.map((g) => {
    const es = entries.filter((e) => e.campaignId === g.id)
    const won = es.filter((e) => e.orderId && goById.has(e.orderId))
    const delivered = won.filter((e) => goById.get(e.orderId!)!.status === 'delivered')
    const cost = delivered.reduce((s, e) => s + num(goById.get(e.orderId!)!.gasAmountUSD), 0)
    return {
      program: 'giveaway', id: g.id, name: g.code, label: g.kolLabel,
      status: !g.isActive ? 'disabled' : g.status === 'open' ? 'open' : g.status === 'drawn' ? 'drawn' : 'closed',
      createdAt: g.createdAt,
      redemptions: won.length, // winners paid out
      uniqueRedeemers: new Set(won.map((e) => e.userId)).size,
      completedOrders: delivered.length,
      refundedOrders: won.filter((e) => goById.get(e.orderId!)!.status === 'refunded').length,
      grossMarginUsdt: null, rewardCostUsdt: round(cost), commissionUsdt: null, netContributionUsdt: null,
      // Budget is a winner count × native amount — not stored in USD, so not a USD budget.
      budgetUsdt: null, spentUsdt: round(cost),
      insufficientData: won.length < MIN_SAMPLE,
    }
  })

  // ── Community giveaways (creator-funded; no platform money moves) ─────────
  const [community, communityEntries] = await Promise.all([
    db.promoGiveaway.findMany({ orderBy: { createdAt: 'desc' }, select: { id: true, code: true, title: true, status: true, isActive: true, createdAt: true } }),
    db.promoGiveawayEntry.findMany({ where: since ? { createdAt: { gte: since } } : {}, select: { giveawayId: true, userId: true } }),
  ])
  const communityRows: CampaignRow[] = community.map((g) => {
    const es = communityEntries.filter((e) => e.giveawayId === g.id)
    return {
      program: 'community_giveaway', id: g.id, name: g.code, label: g.title,
      status: !g.isActive ? 'disabled' : g.status === 'open' ? 'open' : 'closed',
      createdAt: g.createdAt,
      redemptions: es.length,
      uniqueRedeemers: new Set(es.map((e) => e.userId)).size,
      completedOrders: 0, refundedOrders: 0,
      grossMarginUsdt: null, rewardCostUsdt: 0, commissionUsdt: null, netContributionUsdt: null,
      budgetUsdt: null, spentUsdt: 0,
      insufficientData: es.length < MIN_SAMPLE,
    }
  })

  // ── Direct free-gas deliveries (admin tool) ───────────────────────────────
  const directOrders = await db.gasFeeOrder.findMany({
    where: { isFreeGrant: true, gasFreeCodeId: null, ...orderRange },
    take: 20_000,
    select: { id: true, status: true, gasAmountUSD: true, createdAt: true },
  })
  const directNotGiveaway = directOrders.filter((o) => !giveawayOrderIds.includes(o.id))
  const directDelivered = directNotGiveaway.filter((o) => o.status === 'delivered')
  const directCost = directDelivered.reduce((s, o) => s + num(o.gasAmountUSD), 0)

  // ── Share & Earn ──────────────────────────────────────────────────────────
  const [shareRewards, shareOrders] = await Promise.all([
    db.gasShareReward.findMany({ where: since ? { createdAt: { gte: since } } : {}, select: { status: true, userId: true, createdAt: true, usedAt: true } }),
    db.gasFeeOrder.findMany({
      where: { shareRewardId: { not: null }, ...orderRange },
      take: 20_000,
      select: { status: true, platformMarginUsdt: true, discountUsdt: true },
    }),
  ])
  const shareDelivered = shareOrders.filter((o) => o.status === 'delivered')
  const shareGross = shareDelivered.reduce((s, o) => s + num(o.platformMarginUsdt), 0)
  const shareCost = shareDelivered.reduce((s, o) => s + num(o.discountUsdt), 0)

  // ── Per-program roll-up ───────────────────────────────────────────────────
  const sum = (rows: CampaignRow[], k: keyof Pick<CampaignRow, 'redemptions' | 'completedOrders' | 'refundedOrders'>) => rows.reduce((s, r) => s + r[k], 0)
  const sumN = (rows: CampaignRow[], k: 'grossMarginUsdt' | 'rewardCostUsdt' | 'commissionUsdt' | 'netContributionUsdt' | 'budgetUsdt' | 'spentUsdt') =>
    rows.length === 0 ? (k === 'rewardCostUsdt' || k === 'spentUsdt' ? 0 : null) : rows.every((r) => r[k] == null) ? null : round(rows.reduce((s, r) => s + (r[k] ?? 0), 0))
  const counts = (rows: CampaignRow[]) => ({
    total: rows.length,
    active: rows.filter((r) => r.status === 'active' || r.status === 'open').length,
    expired: rows.filter((r) => r.status === 'expired').length,
    disabled: rows.filter((r) => r.status === 'disabled' || r.status === 'exhausted').length,
  })

  const programs = {
    promo_code: {
      key: 'promo_code' as const, label: 'Promo codes', funding: 'Platform margin (discount only — never below base gas cost)', ...counts(promoRows),
      redemptions: sum(promoRows, 'redemptions'), uniqueRedeemers: new Set(promoRedemptions.map((r) => r.identity)).size,
      completedOrders: sum(promoRows, 'completedOrders'), refundedOrders: sum(promoRows, 'refundedOrders'),
      grossMarginUsdt: sumN(promoRows, 'grossMarginUsdt'), rewardCostUsdt: sumN(promoRows, 'rewardCostUsdt'),
      commissionUsdt: sumN(promoRows, 'commissionUsdt'), netContributionUsdt: sumN(promoRows, 'netContributionUsdt'),
      budgetUsdt: sumN(promoRows, 'budgetUsdt'), spentUsdt: sumN(promoRows, 'spentUsdt'),
    },
    free_code: {
      key: 'free_code' as const, label: 'Free-gas codes', funding: 'Platform funds (full gas value)', ...counts(freeRows),
      redemptions: sum(freeRows, 'redemptions'), uniqueRedeemers: new Set(freeRedemptions.map((r) => r.identity)).size,
      completedOrders: sum(freeRows, 'completedOrders'), refundedOrders: sum(freeRows, 'refundedOrders'),
      grossMarginUsdt: null, rewardCostUsdt: sumN(freeRows, 'rewardCostUsdt'), commissionUsdt: null, netContributionUsdt: null,
      budgetUsdt: sumN(freeRows, 'budgetUsdt'), spentUsdt: sumN(freeRows, 'spentUsdt'),
    },
    giveaway: {
      key: 'giveaway' as const, label: 'Gas giveaways', funding: 'Platform funds (winners × fixed amount)', ...counts(giveawayRows),
      redemptions: sum(giveawayRows, 'redemptions'), uniqueRedeemers: new Set(entries.filter((e) => e.orderId).map((e) => e.userId)).size,
      completedOrders: sum(giveawayRows, 'completedOrders'), refundedOrders: sum(giveawayRows, 'refundedOrders'),
      grossMarginUsdt: null, rewardCostUsdt: sumN(giveawayRows, 'rewardCostUsdt'), commissionUsdt: null, netContributionUsdt: null,
      budgetUsdt: null, spentUsdt: sumN(giveawayRows, 'spentUsdt'),
    },
    community_giveaway: {
      key: 'community_giveaway' as const, label: 'Community giveaways', funding: 'Creator-funded off-platform — no platform funds move', ...counts(communityRows),
      redemptions: sum(communityRows, 'redemptions'), uniqueRedeemers: new Set(communityEntries.map((e) => e.userId)).size,
      completedOrders: 0, refundedOrders: 0,
      grossMarginUsdt: null, rewardCostUsdt: 0, commissionUsdt: null, netContributionUsdt: null, budgetUsdt: null, spentUsdt: 0,
    },
    direct_free_gas: {
      key: 'direct_free_gas' as const, label: 'Direct free gas', funding: 'Platform funds (admin-initiated)', total: directNotGiveaway.length, active: 0, expired: 0, disabled: 0,
      redemptions: directNotGiveaway.length, uniqueRedeemers: null,
      completedOrders: directDelivered.length, refundedOrders: directNotGiveaway.filter((o) => o.status === 'refunded').length,
      grossMarginUsdt: null, rewardCostUsdt: round(directCost), commissionUsdt: null, netContributionUsdt: null, budgetUsdt: null, spentUsdt: round(directCost),
    },
    share_reward: {
      key: 'share_reward' as const, label: 'Share & Earn', funding: 'Platform margin (discount on a later order)', total: shareRewards.length,
      active: shareRewards.filter((r) => r.status === 'approved' || r.status === 'reserved').length, expired: 0,
      disabled: shareRewards.filter((r) => r.status === 'rejected').length,
      redemptions: shareRewards.filter((r) => r.status === 'used').length, uniqueRedeemers: new Set(shareRewards.filter((r) => r.status === 'used').map((r) => r.userId)).size,
      completedOrders: shareDelivered.length, refundedOrders: shareOrders.filter((o) => o.status === 'refunded').length,
      grossMarginUsdt: round(shareGross), rewardCostUsdt: round(shareCost), commissionUsdt: null, netContributionUsdt: round(shareGross - shareCost),
      budgetUsdt: null, spentUsdt: round(shareCost),
    },
  }

  // ── Trend: daily redemptions (UTC days) ───────────────────────────────────
  const trendDays = Math.min(days ?? 30, 90)
  const dayKey = (d: Date) => d.toISOString().slice(0, 10)
  const buckets = new Map<string, { date: string; promo: number; free: number; shareReward: number; freeGrants: number }>()
  for (let i = trendDays - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000)
    buckets.set(dayKey(d), { date: dayKey(d), promo: 0, free: 0, shareReward: 0, freeGrants: 0 })
  }
  for (const r of promoRedemptions) { const b = buckets.get(dayKey(r.createdAt)); if (b) b.promo++ }
  for (const r of freeRedemptions) { const b = buckets.get(dayKey(r.createdAt)); if (b) b.free++ }
  for (const r of shareRewards) { if (r.usedAt) { const b = buckets.get(dayKey(r.usedAt)); if (b) b.shareReward++ } }
  for (const o of directNotGiveaway) { const b = buckets.get(dayKey(o.createdAt)); if (b) b.freeGrants++ }

  const campaigns = [...promoRows, ...freeRows, ...giveawayRows, ...communityRows]

  // ── Totals ────────────────────────────────────────────────────────────────
  const all = Object.values(programs)
  const totals = {
    campaigns: campaigns.length,
    redemptions: all.reduce((s, p) => s + p.redemptions, 0),
    completedOrders: all.reduce((s, p) => s + p.completedOrders, 0),
    refundedOrders: all.reduce((s, p) => s + p.refundedOrders, 0),
    rewardCostUsdt: round(all.reduce((s, p) => s + (p.rewardCostUsdt ?? 0), 0)),
    // Gross margin is only recorded where customers actually paid (promo codes, share rewards).
    grossMarginUsdt: round(all.reduce((s, p) => s + (p.grossMarginUsdt ?? 0), 0)),
    commissionUsdt: round(all.reduce((s, p) => s + (p.commissionUsdt ?? 0), 0)),
  }
  // Net contribution of the programs that track revenue; free programs are a pure cost line.
  const freeProgramCost = round(programs.free_code.rewardCostUsdt! + programs.giveaway.rewardCostUsdt! + programs.direct_free_gas.rewardCostUsdt!)
  const netTracked = round((programs.promo_code.netContributionUsdt ?? 0) + (programs.share_reward.netContributionUsdt ?? 0))

  return {
    generatedAt: now.toISOString(),
    range: { days, since: since ? since.toISOString() : null },
    minSample: MIN_SAMPLE,
    totals: { ...totals, freeProgramCostUsdt: freeProgramCost, netTrackedContributionUsdt: netTracked, netAfterFreeProgramsUsdt: round(netTracked - freeProgramCost) },
    programs,
    trend: [...buckets.values()],
    campaigns,
  }
}
