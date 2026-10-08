import { db } from '../prisma'
import { loadTiers, tierFor, type AffiliateTier } from './gas.affiliateTier'
import { getNumberConfig } from '../../services/platformFlags.service'

/**
 * Read-only affiliate reporting. Uses the existing GasAffiliate / GasReferralCode /
 * GasReferral / GasReferralAccrual records — it never changes tiers, caps, commission
 * rules or payout state.
 *
 * Definitions (surfaced in the admin UI):
 *  - Active affiliate     approved AND at least one verified (delivered) referred order in the last 30 days.
 *  - Verified order       a delivered, paid gas order by a referred user (exactly one level-1 accrual).
 *  - Sign-up rate         referred users bound to the affiliate ÷ link clicks.
 *  - Conversion rate      referred users who placed ≥ 1 verified order ÷ referred users (sign-ups).
 *  - Attributable margin  realized platform margin (after discounts) on verified orders — NOT payment volume.
 *  - Commission states    pending = accrued but inside the fraud-hold window; withdrawable = past hold, not yet withdrawn;
 *                         paid = withdrawn to the user's internal USDT balance; reversed = clawed back.
 *  - Payout liability     everything accrued and not yet withdrawn (pending + withdrawable).
 *  Commission is paid out of platform margin; payouts are self-service withdrawals (no admin payout reference exists).
 *  There is no "suspended" status in the affiliate model, so it is reported as not tracked.
 */

const round2 = (n: number) => Math.round(n * 100) / 100
const num = (v: unknown) => (v == null ? 0 : Number(v))
const ACTIVE_WINDOW_DAYS = 30
/** Below this many clicks AND verified orders an affiliate is "new" — never judged as under-performing. */
export const NEW_AFFILIATE_MIN_ORDERS = 5
export const NEW_AFFILIATE_MIN_CLICKS = 20

export interface AffiliatePerf {
  userId: string
  username: string | null
  email: string | null
  referralCode: string | null
  status: string
  socials: Record<string, string> | null
  applicantNote: string | null
  rejectionReason: string | null
  tier: string | null
  tierPct: number | null
  maxMarginPct: number
  minUserDiscountPct: number
  maxLinks: number
  linkCount: number
  clicks: number
  signups: number
  buyers: number
  verifiedOrders: number
  signupRate: number | null
  conversionRate: number | null
  attributableMarginUsdt: number
  commissionEarnedUsdt: number
  commissionPendingUsdt: number
  commissionWithdrawableUsdt: number
  commissionPaidUsdt: number
  commissionReversedUsdt: number
  unpaidUsdt: number
  lastActivityAt: Date | null
  appliedAt: Date
  reviewedAt: Date | null
  isNew: boolean
  isActive: boolean
}

export async function affiliateOverview() {
  const now = Date.now()
  const holdHours = await getNumberConfig('gas_referral_hold_hours', 24)
  const holdCutoff = new Date(now - holdHours * 3_600_000)
  const activeSince = new Date(now - ACTIVE_WINDOW_DAYS * 86_400_000)

  const affiliates = await db.gasAffiliate.findMany({
    orderBy: { createdAt: 'desc' },
    include: { user: { select: { email: true, username: true, referralCode: true } } },
  })
  const ids = affiliates.map((a) => a.userId)

  const [codes, referrals, accruals, tiers] = await Promise.all([
    db.gasReferralCode.findMany({ where: { ownerId: { in: ids }, deletedAt: null }, select: { ownerId: true, clickCount: true, lastClickAt: true } }),
    db.gasReferral.findMany({ where: { referrerId: { in: ids } }, select: { referrerId: true, referredId: true, createdAt: true } }),
    db.gasReferralAccrual.findMany({
      where: { referrerId: { in: ids } },
      select: { referrerId: true, referredId: true, level: true, marginUsdt: true, amountUsdt: true, status: true, createdAt: true },
    }),
    loadTiers(),
  ])

  const perf = new Map<string, AffiliatePerf>()
  for (const a of affiliates) {
    perf.set(a.userId, {
      userId: a.userId,
      username: a.user?.username ?? null,
      email: a.user?.email ?? null,
      referralCode: a.user?.referralCode ?? null,
      status: a.status,
      socials: (a.socials as Record<string, string> | null) ?? null,
      applicantNote: a.applicantNote,
      rejectionReason: a.rejectionReason,
      tier: null, tierPct: null,
      maxMarginPct: a.maxMarginPct, minUserDiscountPct: a.minUserDiscountPct, maxLinks: a.maxLinks, linkCount: 0,
      clicks: 0, signups: 0, buyers: 0, verifiedOrders: 0, signupRate: null, conversionRate: null,
      attributableMarginUsdt: 0, commissionEarnedUsdt: 0, commissionPendingUsdt: 0, commissionWithdrawableUsdt: 0,
      commissionPaidUsdt: 0, commissionReversedUsdt: 0, unpaidUsdt: 0,
      lastActivityAt: null, appliedAt: a.createdAt, reviewedAt: a.reviewedAt, isNew: true, isActive: false,
    })
  }
  const touch = (p: AffiliatePerf, d: Date | null) => { if (d && (!p.lastActivityAt || d > p.lastActivityAt)) p.lastActivityAt = d }
  const buyers = new Map<string, Set<string>>()
  const recentOrders = new Map<string, number>()

  for (const c of codes) {
    const p = perf.get(c.ownerId); if (!p) continue
    p.linkCount++; p.clicks += c.clickCount; touch(p, c.lastClickAt)
  }
  for (const r of referrals) {
    const p = perf.get(r.referrerId); if (!p) continue
    p.signups++; touch(p, r.createdAt)
  }
  for (const a of accruals) {
    const p = perf.get(a.referrerId); if (!p) continue
    const amt = num(a.amountUsdt)
    touch(p, a.createdAt)
    if (a.status === 'reversed') { p.commissionReversedUsdt += amt; continue }
    p.commissionEarnedUsdt += amt
    if (a.status === 'withdrawn') p.commissionPaidUsdt += amt
    else if (a.createdAt <= holdCutoff) p.commissionWithdrawableUsdt += amt
    else p.commissionPendingUsdt += amt
    if (a.level === 1) {
      p.verifiedOrders++
      p.attributableMarginUsdt += num(a.marginUsdt)
      if (!buyers.has(a.referrerId)) buyers.set(a.referrerId, new Set())
      buyers.get(a.referrerId)!.add(a.referredId)
      if (a.createdAt >= activeSince) recentOrders.set(a.referrerId, (recentOrders.get(a.referrerId) ?? 0) + 1)
    }
  }
  for (const p of perf.values()) {
    p.buyers = buyers.get(p.userId)?.size ?? 0
    p.signupRate = p.clicks > 0 ? p.signups / p.clicks : null
    p.conversionRate = p.signups > 0 ? p.buyers / p.signups : null
    const { tier } = tierFor(p.verifiedOrders, tiers)
    p.tier = tier.name; p.tierPct = tier.pct
    p.unpaidUsdt = round2(p.commissionPendingUsdt + p.commissionWithdrawableUsdt)
    p.isActive = p.status === 'approved' && (recentOrders.get(p.userId) ?? 0) > 0
    p.isNew = p.verifiedOrders < NEW_AFFILIATE_MIN_ORDERS && p.clicks < NEW_AFFILIATE_MIN_CLICKS
    for (const k of ['attributableMarginUsdt', 'commissionEarnedUsdt', 'commissionPendingUsdt', 'commissionWithdrawableUsdt', 'commissionPaidUsdt', 'commissionReversedUsdt'] as const) p[k] = round2(p[k])
  }

  const rows = [...perf.values()]
  const count = (s: string) => rows.filter((r) => r.status === s).length
  const sum = (k: keyof Pick<AffiliatePerf, 'verifiedOrders' | 'commissionEarnedUsdt' | 'commissionPendingUsdt' | 'commissionWithdrawableUsdt' | 'commissionPaidUsdt' | 'commissionReversedUsdt' | 'attributableMarginUsdt' | 'clicks' | 'signups'>) => rows.reduce((s, r) => s + r[k], 0)

  return {
    generatedAt: new Date(now).toISOString(),
    definitions: { activeWindowDays: ACTIVE_WINDOW_DAYS, holdHours, newAffiliateMinOrders: NEW_AFFILIATE_MIN_ORDERS, newAffiliateMinClicks: NEW_AFFILIATE_MIN_CLICKS },
    counts: {
      applications: rows.length, pending: count('pending'), approved: count('approved'), rejected: count('rejected'),
      suspended: null as number | null, // the affiliate model has no suspended state
      active: rows.filter((r) => r.isActive).length,
    },
    totals: {
      clicks: sum('clicks'), signups: sum('signups'), verifiedOrders: sum('verifiedOrders'),
      attributableMarginUsdt: round2(sum('attributableMarginUsdt')),
      commissionEarnedUsdt: round2(sum('commissionEarnedUsdt')),
      commissionPendingUsdt: round2(sum('commissionPendingUsdt')),
      commissionWithdrawableUsdt: round2(sum('commissionWithdrawableUsdt')),
      commissionPaidUsdt: round2(sum('commissionPaidUsdt')),
      commissionReversedUsdt: round2(sum('commissionReversedUsdt')),
      payoutLiabilityUsdt: round2(sum('commissionPendingUsdt') + sum('commissionWithdrawableUsdt')),
    },
    tiers: tiers as AffiliateTier[],
    affiliates: rows,
  }
}

export async function affiliateDetail(userId: string) {
  const aff = await db.gasAffiliate.findUnique({ where: { userId }, include: { user: { select: { id: true, email: true, username: true } } } })
  if (!aff) return null
  const [links, referrals, recent, audits, withdrawals] = await Promise.all([
    db.gasReferralCode.findMany({
      where: { ownerId: userId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, code: true, label: true, referralPct: true, userDiscountPct: true, isActive: true, deletedAt: true, clickCount: true, lastClickAt: true, createdAt: true, _count: { select: { referrals: true } } },
    }),
    db.gasReferral.count({ where: { referrerId: userId } }),
    db.gasReferralAccrual.findMany({
      where: { referrerId: userId },
      orderBy: { createdAt: 'desc' },
      take: 25,
      select: { id: true, level: true, marginUsdt: true, amountUsdt: true, pct: true, status: true, createdAt: true, order: { select: { orderRef: true, status: true } } },
    }),
    db.auditLog.findMany({
      where: { targetType: 'GasAffiliate', targetId: { in: [userId, aff.id] } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, action: true, metadata: true, createdAt: true, actor: { select: { username: true, email: true } } },
    }),
    // Self-service payouts show up as completed referral_reward transactions on the user's USDT wallet.
    db.transaction.findMany({
      where: { wallet: { userId }, type: 'referral_reward' },
      orderBy: { createdAt: 'desc' },
      take: 25,
      select: { id: true, amount: true, createdAt: true, metadata: true },
    }),
  ])
  return {
    user: aff.user,
    status: aff.status,
    links: links.map((l) => ({ ...l, signups: l._count.referrals, _count: undefined })),
    signups: referrals,
    recentAccruals: recent.map((r) => ({ ...r, marginUsdt: num(r.marginUsdt), amountUsdt: num(r.amountUsdt) })),
    auditHistory: audits.map((a) => ({ id: a.id, action: a.action, metadata: a.metadata, createdAt: a.createdAt, actor: a.actor.username ?? a.actor.email })),
    payouts: withdrawals.map((w) => ({ id: w.id, amountUsdt: num(w.amount), createdAt: w.createdAt, source: (w.metadata as { source?: string } | null)?.source ?? null })),
  }
}
