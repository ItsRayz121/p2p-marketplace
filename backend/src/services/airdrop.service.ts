/**
 * Airdrop / points earning engine (Phase 1).
 *
 * Users earn NON-TRANSFERABLE loyalty points for platform activity. Points are
 * share-of-a-fixed-pool per season (see schema comment on AirdropSeason), so the
 * point RATES here only decide *relative* share — they can never over-issue token.
 *
 * Everything is inert unless the flag `airdrop_enabled` is ON. Every award is
 * idempotent on `eventKey`, so the overlapping poller / webhook / reconciliation
 * paths that finalise trades and gas orders can never double-award.
 *
 * Two award surfaces:
 *  - awardTradePointsTx(tx, …) runs INSIDE the trade-completion transaction, right
 *    next to incrementTradeStreak. That transaction is already CAS-guarded to run
 *    exactly once, so a duplicate eventKey there is impossible; the unique index is
 *    pure defence-in-depth.
 *  - awardGasPointsForDelivery(order) runs at the TOP LEVEL from the gas job (which
 *    retries), so it opens its own transaction and swallows the unique-violation as
 *    an idempotent no-op.
 */
import { db } from '../lib/prisma'
import { Prisma } from '@prisma/client'
import { isFlagEnabled, FLAGS, getNumberConfig, getBoolConfig } from './platformFlags.service'
import { logger } from '../lib/logger'
import { AppError } from '../lib/errors'
import type { GasFeeOrder, AirdropSource } from '@prisma/client'

type Tx = Prisma.TransactionClient
type TradeType = 'usdt' | 'ctm'

// ── Config keys (all admin-tunable via PATCH /admin/config; safe defaults) ──────
const CFG = {
  pkrPerPoint: 'airdrop_pkr_per_point',            // PKR of volume per 1 point
  minTradePkr: 'airdrop_min_trade_pkr',            // trades below this earn nothing
  dailyTradeCap: 'airdrop_daily_trade_points_cap', // max trade-source points/user/day
  decayStep: 'airdrop_counterparty_decay_step',    // wash-decay: -step per prior trade w/ same pair
  decayMin: 'airdrop_counterparty_min_factor',     // decay floor
  gasPerOrder: 'airdrop_gas_points_per_order',
  gasMinUsd: 'airdrop_gas_min_order_usd',
  gasDailyCap: 'airdrop_gas_daily_cap',
  referralPct: 'airdrop_referral_pct',             // referrer earns this % of referred user's points
  requireKyc: 'airdrop_require_kyc',               // only KYC'd users earn ("true"/"false")
  targetUsers: 'airdrop_target_users',             // milestone denominator for the progress bar
  // ── Streak (Phase 3) ──
  checkinPoints: 'airdrop_checkin_points',                 // points for a daily check-in
  repairCost: 'airdrop_streak_repair_cost',               // points to restore a broken streak
  repairWindowDays: 'airdrop_streak_repair_window_days',   // days after a break you may repair
  repairMax: 'airdrop_streak_repair_max',                  // repairs allowed per season
  freezeMax: 'airdrop_streak_freeze_max',                  // max banked freeze tokens
  freezeEarnEvery: 'airdrop_streak_freeze_earn_every',     // earn 1 freeze every N streak days
  // ── Levels (Phase 4) ──
  levelDiscountCap: 'airdrop_level_discount_cap',          // hard ceiling on level fee discount %
} as const

const DEF = {
  pkrPerPoint: 1000,
  minTradePkr: 1000,
  dailyTradeCap: 300,
  decayStep: 0.2,
  decayMin: 0.2,
  gasPerOrder: 1,
  gasMinUsd: 2,
  gasDailyCap: 10,
  referralPct: 10,
  requireKyc: true,
  targetUsers: 1_000_000,
  checkinPoints: 1,
  repairCost: 500,
  repairWindowDays: 3,
  repairMax: 2,
  freezeMax: 3,
  freezeEarnEvery: 30,
  levelDiscountCap: 50,
}

export interface AirdropConfig {
  pkrPerPoint: number
  minTradePkr: number
  dailyTradeCap: number
  decayStep: number
  decayMin: number
  gasPerOrder: number
  gasMinUsd: number
  gasDailyCap: number
  referralPct: number
  requireKyc: boolean
  targetUsers: number
  checkinPoints: number
  repairCost: number
  repairWindowDays: number
  repairMax: number
  freezeMax: number
  freezeEarnEvery: number
  levelDiscountCap: number
}

export async function loadAirdropConfig(): Promise<AirdropConfig> {
  const [
    pkrPerPoint, minTradePkr, dailyTradeCap, decayStep, decayMin,
    gasPerOrder, gasMinUsd, gasDailyCap, referralPct, targetUsers, requireKyc,
    checkinPoints, repairCost, repairWindowDays, repairMax, freezeMax, freezeEarnEvery,
    levelDiscountCap,
  ] = await Promise.all([
    getNumberConfig(CFG.pkrPerPoint, DEF.pkrPerPoint),
    getNumberConfig(CFG.minTradePkr, DEF.minTradePkr),
    getNumberConfig(CFG.dailyTradeCap, DEF.dailyTradeCap),
    getNumberConfig(CFG.decayStep, DEF.decayStep),
    getNumberConfig(CFG.decayMin, DEF.decayMin),
    getNumberConfig(CFG.gasPerOrder, DEF.gasPerOrder),
    getNumberConfig(CFG.gasMinUsd, DEF.gasMinUsd),
    getNumberConfig(CFG.gasDailyCap, DEF.gasDailyCap),
    getNumberConfig(CFG.referralPct, DEF.referralPct),
    getNumberConfig(CFG.targetUsers, DEF.targetUsers),
    getBoolConfig(CFG.requireKyc, DEF.requireKyc),
    getNumberConfig(CFG.checkinPoints, DEF.checkinPoints),
    getNumberConfig(CFG.repairCost, DEF.repairCost),
    getNumberConfig(CFG.repairWindowDays, DEF.repairWindowDays),
    getNumberConfig(CFG.repairMax, DEF.repairMax),
    getNumberConfig(CFG.freezeMax, DEF.freezeMax),
    getNumberConfig(CFG.freezeEarnEvery, DEF.freezeEarnEvery),
    getNumberConfig(CFG.levelDiscountCap, DEF.levelDiscountCap),
  ])
  return {
    pkrPerPoint, minTradePkr, dailyTradeCap, decayStep, decayMin, gasPerOrder, gasMinUsd, gasDailyCap,
    referralPct, requireKyc, targetUsers,
    checkinPoints, repairCost, repairWindowDays, repairMax, freezeMax, freezeEarnEvery,
    levelDiscountCap,
  }
}

// ── Levels — cumulative lifetime points unlock a fee discount. Levels are PERKS,
//    separate from the streak multiplier, so the two never compound into a runaway.
//    Discount is CAPPED at 50% (airdrop_level_discount_cap) to protect revenue. ──
export interface LevelTier {
  key: string
  name: string
  min: number
  discountPct: number
}

export const LEVEL_TIERS: LevelTier[] = [
  { key: 'diamond',  name: 'Diamond',  min: 300_000, discountPct: 50 },
  { key: 'platinum', name: 'Platinum', min: 100_000, discountPct: 35 },
  { key: 'gold',     name: 'Gold',     min: 25_000,  discountPct: 20 },
  { key: 'silver',   name: 'Silver',   min: 5_000,   discountPct: 10 },
  { key: 'bronze',   name: 'Bronze',   min: 0,       discountPct: 0 },
]

export interface UserLevel {
  level: string
  levelName: string
  discountPct: number
  cumulativePoints: number
  nextLevel: string | null
  pointsToNext: number | null
}

/** Cumulative lifetime points = net total across all of a user's season accounts. */
async function cumulativePoints(userId: string): Promise<number> {
  const agg = await db.airdropAccount.aggregate({ where: { userId }, _sum: { totalPoints: true } })
  return Math.max(0, Number(agg._sum.totalPoints ?? 0))
}

function tierFor(points: number, cap: number): { tier: LevelTier; next: LevelTier | null } {
  // LEVEL_TIERS is high→low; the first whose min we meet is our level.
  for (let i = 0; i < LEVEL_TIERS.length; i++) {
    const t = LEVEL_TIERS[i]!
    if (points >= t.min) {
      const next = i > 0 ? LEVEL_TIERS[i - 1]! : null
      return { tier: { ...t, discountPct: Math.min(t.discountPct, cap) }, next }
    }
  }
  const last = LEVEL_TIERS[LEVEL_TIERS.length - 1]!
  return { tier: last, next: LEVEL_TIERS[LEVEL_TIERS.length - 2] ?? null }
}

export async function getUserLevel(userId: string): Promise<UserLevel> {
  const cap = await getNumberConfig(CFG.levelDiscountCap, DEF.levelDiscountCap)
  const points = await cumulativePoints(userId)
  const { tier, next } = tierFor(points, cap)
  return {
    level: tier.key,
    levelName: tier.name,
    discountPct: tier.discountPct,
    cumulativePoints: points,
    nextLevel: next?.name ?? null,
    pointsToNext: next ? Math.max(0, next.min - points) : null,
  }
}

/**
 * The fee-discount % a user's level currently grants. Returns 0 unless BOTH
 * airdrop_enabled AND airdrop_levels_enabled are ON — so points can accrue for
 * weeks before any live fee is touched. Capped at airdrop_level_discount_cap.
 */
export async function getAirdropFeeDiscountPct(userId: string | null): Promise<number> {
  if (!userId) return 0
  if (!(await isFlagEnabled(FLAGS.AIRDROP))) return 0
  if (!(await isFlagEnabled(FLAGS.AIRDROP_LEVELS))) return 0
  const { discountPct } = await getUserLevel(userId)
  return discountPct
}

/**
 * Margin-only discount for a gas order from the buyer's airdrop level. Mirrors the
 * affiliate/promo flooring: the discount is `levelPct% × margin`, but never more
 * than the margin left after any promo/affiliate discount already applied — so it
 * can never push the user below the base gas cost. Returns 0 when levels are off.
 */
export async function airdropLevelOrderDiscount(
  userId: string | null,
  marginUsdt: number,
  alreadyDiscountedUsdt: number,
): Promise<{ discountUsdt: number }> {
  const pct = await getAirdropFeeDiscountPct(userId)
  if (pct <= 0) return { discountUsdt: 0 }
  const room = Math.max(0, marginUsdt - alreadyDiscountedUsdt)
  if (room <= 0) return { discountUsdt: 0 }
  const raw = Math.round((pct / 100) * marginUsdt * 100) / 100
  return { discountUsdt: Math.min(raw, Math.round(room * 100) / 100) }
}

// ── Streak multiplier — PLATEAUS at 2.0× so late joiners stay viable (the 1000-day
//    badge is cosmetic; the point advantage caps here). Applies to earned points. ──
export function streakMultiplier(count: number): number {
  if (count >= 366) return 2.0
  if (count >= 101) return 1.75
  if (count >= 31) return 1.5
  if (count >= 8) return 1.25
  return 1.0
}

export function isAirdropEnabled(): Promise<boolean> {
  return isFlagEnabled(FLAGS.AIRDROP)
}

// ── Small helpers ───────────────────────────────────────────────────────────
function dec(n: number | Prisma.Decimal): Prisma.Decimal {
  return new Prisma.Decimal(Number(n).toFixed(4))
}
function canonicalPair(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}
function startOfUtcDay(): Date {
  const d = new Date()
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}
function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'
}

async function resolveActiveSeasonId(client: Tx | typeof db): Promise<string | null> {
  const s = await client.airdropSeason.findFirst({
    where: { status: 'active' },
    orderBy: { index: 'desc' },
    select: { id: true },
  })
  return s?.id ?? null
}

async function isKycOk(client: Tx | typeof db, userId: string): Promise<boolean> {
  const u = await client.user.findUnique({ where: { id: userId }, select: { kycLevel: true } })
  return !!u && u.kycLevel !== 'none'
}

function startOfUtcDayOf(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

/** Make sure a zero-row account exists so streak fields can be updated before the
 *  first point award. */
async function ensureAccount(tx: Tx, userId: string, seasonId: string): Promise<void> {
  await tx.airdropAccount.upsert({
    where: { userId_seasonId: { userId, seasonId } },
    create: { userId, seasonId, totalPoints: new Prisma.Decimal(0) },
    update: {},
  })
}

/**
 * Record that the user was active today and advance their streak. Returns the
 * streak multiplier to apply to points earned by this same action. Idempotent per
 * UTC day — a second qualifying action the same day returns the multiplier without
 * advancing again, so trading + gas + check-in on one day counts once.
 *
 * Grace model: consecutive day → +1. Skipped exactly one day → a banked freeze (if
 * any) covers it and the streak advances, else auto-grace HOLDS the streak (no
 * break). Skipped two or more days → the streak breaks (recording the pre-break
 * value so it can be repaired) and restarts at 1.
 */
async function applyStreakTouch(tx: Tx, userId: string, seasonId: string, cfg: AirdropConfig): Promise<number> {
  await ensureAccount(tx, userId, seasonId)
  const acc = await tx.airdropAccount.findUniqueOrThrow({
    where: { userId_seasonId: { userId, seasonId } },
    select: { streakCount: true, longestStreak: true, lastActiveDay: true, freezes: true, streakBrokenAt: true, preBreakStreak: true },
  })
  const today = startOfUtcDay()
  const last = acc.lastActiveDay ? startOfUtcDayOf(acc.lastActiveDay) : null
  if (last && last.getTime() === today.getTime()) return streakMultiplier(acc.streakCount) // already active today

  let streakCount = acc.streakCount
  let freezes = acc.freezes
  let preBreakStreak = acc.preBreakStreak
  let streakBrokenAt = acc.streakBrokenAt

  const gap = last ? Math.round((today.getTime() - last.getTime()) / 86_400_000) : null
  if (gap === null || streakCount === 0) {
    streakCount = 1
  } else if (gap === 1) {
    streakCount += 1
  } else if (gap === 2) {
    if (freezes > 0) { freezes -= 1; streakCount += 1 } // freeze covers the single missed day
    // else auto-grace: hold — no advance, no break
  } else {
    // Two or more missed days → break, remember the pre-break value for repair.
    preBreakStreak = streakCount
    streakBrokenAt = new Date()
    streakCount = 1
  }

  // Earn a freeze every N streak days (up to the cap).
  if (cfg.freezeEarnEvery > 0 && streakCount > 0 && streakCount % cfg.freezeEarnEvery === 0 && freezes < cfg.freezeMax) {
    freezes += 1
  }
  const longestStreak = Math.max(acc.longestStreak, streakCount)

  await tx.airdropAccount.update({
    where: { userId_seasonId: { userId, seasonId } },
    data: { streakCount, longestStreak, freezes, preBreakStreak, streakBrokenAt, lastActiveDay: today },
  })
  return streakMultiplier(streakCount)
}

/**
 * Write one ledger row + keep the cached per-season total in sync. Assumes the
 * caller guarantees eventKey uniqueness (inside an already-once-only tx). Throws
 * P2002 on a genuine duplicate — callers on retryable paths must catch it.
 */
async function writeLedger(
  tx: Tx,
  a: { userId: string; seasonId: string; source: AirdropSource; points: number; eventKey: string; pairKey?: string | null; metadata?: Prisma.InputJsonValue },
): Promise<void> {
  const points = dec(a.points)
  await tx.airdropLedger.create({
    data: {
      userId: a.userId,
      seasonId: a.seasonId,
      source: a.source,
      points,
      eventKey: a.eventKey,
      pairKey: a.pairKey ?? null,
      metadata: a.metadata ?? {},
    },
  })
  await tx.airdropAccount.upsert({
    where: { userId_seasonId: { userId: a.userId, seasonId: a.seasonId } },
    create: { userId: a.userId, seasonId: a.seasonId, totalPoints: points },
    update: { totalPoints: { increment: points } },
  })
}

/** Wash-trade decay: the Nth trade with the same counterparty this season pays
 *  max(min, 1 − step·N) of full rate. Kills back-and-forth farming between two
 *  accounts while leaving genuine repeat partners mostly intact early on. */
async function counterpartyDecay(tx: Tx, userId: string, seasonId: string, pairKey: string, cfg: AirdropConfig): Promise<number> {
  const prior = await tx.airdropLedger.count({
    where: { userId, seasonId, pairKey, source: { in: ['usdt_trade', 'ctm_trade'] } },
  })
  return Math.max(cfg.decayMin, 1 - cfg.decayStep * prior)
}

/** Clamp `pts` so the user's trade-source points today can't exceed the daily cap. */
async function clampDailyTrade(tx: Tx, userId: string, seasonId: string, pts: number, cap: number): Promise<number> {
  if (cap <= 0) return pts // 0 = no cap
  const agg = await tx.airdropLedger.aggregate({
    where: { userId, seasonId, source: { in: ['usdt_trade', 'ctm_trade'] }, createdAt: { gte: startOfUtcDay() } },
    _sum: { points: true },
  })
  const used = Number(agg._sum.points ?? 0)
  return Math.max(0, Math.min(pts, cap - used))
}

/** Referrer earns `referralPct` % of the points their referred user just earned.
 *  Idempotent: keyed off the source award's eventKey so it can never double. */
async function awardReferralOverride(
  tx: Tx,
  a: { earnerUserId: string; basePoints: number; seasonId: string; sourceEventKey: string; cfg: AirdropConfig },
): Promise<void> {
  if (a.cfg.referralPct <= 0 || a.basePoints <= 0) return
  const u = await tx.user.findUnique({ where: { id: a.earnerUserId }, select: { referredById: true } })
  const referrerId = u?.referredById
  if (!referrerId || referrerId === a.earnerUserId) return
  if (a.cfg.requireKyc && !(await isKycOk(tx, referrerId))) return
  const pts = a.basePoints * (a.cfg.referralPct / 100)
  if (pts <= 0) return
  await writeLedger(tx, {
    userId: referrerId,
    seasonId: a.seasonId,
    source: 'referral',
    points: pts,
    eventKey: `referral:${a.sourceEventKey}`,
    metadata: { referredId: a.earnerUserId, sourceEventKey: a.sourceEventKey },
  })
}

// ── Public: trade points (called INSIDE the completion tx) ──────────────────────
/**
 * Award points to both sides of a freshly-completed trade. MUST be called inside
 * the same transaction that flips the trade to its terminal completed state (that
 * CAS guarantees once-only, so eventKeys never collide here). No-op unless the flag
 * is ON and an active season exists.
 */
export async function awardTradePointsTx(
  tx: Tx,
  opts: { tradeType: TradeType; tradeId: string; buyerId: string; sellerId: string; fiatAmountPKR: Prisma.Decimal | number },
): Promise<void> {
  if (!(await isAirdropEnabled())) return
  if (opts.buyerId === opts.sellerId) return
  const seasonId = await resolveActiveSeasonId(tx)
  if (!seasonId) return

  const cfg = await loadAirdropConfig()
  const pkr = Number(opts.fiatAmountPKR)
  if (!Number.isFinite(pkr) || pkr < cfg.minTradePkr) return

  const pairKey = canonicalPair(opts.buyerId, opts.sellerId)
  const source: AirdropSource = opts.tradeType === 'usdt' ? 'usdt_trade' : 'ctm_trade'
  const roles: Array<[string, 'buyer' | 'seller']> = [[opts.buyerId, 'buyer'], [opts.sellerId, 'seller']]

  for (const [userId, role] of roles) {
    if (cfg.requireKyc && !(await isKycOk(tx, userId))) continue
    const mult = await applyStreakTouch(tx, userId, seasonId, cfg)
    const base = pkr / cfg.pkrPerPoint
    const decayed = base * (await counterpartyDecay(tx, userId, seasonId, pairKey, cfg)) * mult
    const pts = await clampDailyTrade(tx, userId, seasonId, decayed, cfg.dailyTradeCap)
    if (pts <= 0) continue
    const eventKey = `${source}:${opts.tradeId}:${role}`
    await writeLedger(tx, { userId, seasonId, source, points: pts, eventKey, pairKey, metadata: { tradeId: opts.tradeId, role, pkr, streakMult: mult } })
    await awardReferralOverride(tx, { earnerUserId: userId, basePoints: pts, seasonId, sourceEventKey: eventKey, cfg })
  }
}

// ── Public: gas points (called at TOP LEVEL from the gas job) ───────────────────
/**
 * Award a flat point per delivered paid gas order (best-effort, idempotent). Opens
 * its own transaction; a duplicate eventKey (retried delivery finalisation) rolls
 * the tx back and is swallowed as a no-op.
 */
export async function awardGasPointsForDelivery(order: GasFeeOrder): Promise<void> {
  try {
    if (!(await isAirdropEnabled())) return
    if (!order.userId) return
    const userId = order.userId
    const cfg = await loadAirdropConfig()
    const usd = Number(order.gasAmountUSD ?? 0)
    if (cfg.gasMinUsd > 0 && usd < cfg.gasMinUsd) return

    await db.$transaction(async (tx) => {
      const seasonId = await resolveActiveSeasonId(tx)
      if (!seasonId) return
      if (cfg.requireKyc && !(await isKycOk(tx, userId))) return

      const mult = await applyStreakTouch(tx, userId, seasonId, cfg)
      const gasBase = cfg.gasPerOrder * mult
      // Daily cap on gas points.
      const agg = await tx.airdropLedger.aggregate({
        where: { userId, seasonId, source: 'gas_order', createdAt: { gte: startOfUtcDay() } },
        _sum: { points: true },
      })
      const used = Number(agg._sum.points ?? 0)
      const pts = cfg.gasDailyCap > 0 ? Math.max(0, Math.min(gasBase, cfg.gasDailyCap - used)) : gasBase
      if (pts <= 0) return

      const eventKey = `gas_order:${order.id}`
      await writeLedger(tx, { userId, seasonId, source: 'gas_order', points: pts, eventKey, metadata: { orderRef: order.orderRef, usd, streakMult: mult } })
      await awardReferralOverride(tx, { earnerUserId: userId, basePoints: pts, seasonId, sourceEventKey: eventKey, cfg })
    })
  } catch (e) {
    if (!isUniqueViolation(e)) logger.warn({ err: e, orderId: order.id }, 'airdrop gas award failed')
  }
}

// ── Public: clawback (reversal on dispute-loss / admin reversal) ────────────────
/**
 * Reverse every positive award tied to a trade (and its referral overrides) by
 * writing offsetting negative rows. Idempotent — a clawback that already exists is
 * skipped, so calling this twice is safe. No-op if the flag is off.
 */
export async function clawbackTradePoints(tradeType: TradeType, tradeId: string, reason: string): Promise<void> {
  try {
    if (!(await isAirdropEnabled())) return
    const source: AirdropSource = tradeType === 'usdt' ? 'usdt_trade' : 'ctm_trade'
    const prefix = `${source}:${tradeId}`
    await db.$transaction(async (tx) => {
      const rows = await tx.airdropLedger.findMany({
        where: {
          OR: [{ eventKey: { startsWith: prefix } }, { eventKey: { startsWith: `referral:${prefix}` } }],
          points: { gt: 0 },
        },
      })
      for (const r of rows) {
        const clawKey = `clawback:${r.eventKey}`
        const exists = await tx.airdropLedger.findUnique({ where: { eventKey: clawKey }, select: { id: true } })
        if (exists) continue
        await tx.airdropLedger.create({
          data: { userId: r.userId, seasonId: r.seasonId, source: 'clawback', points: r.points.negated(), eventKey: clawKey, pairKey: r.pairKey, metadata: { reason, of: r.eventKey } },
        })
        await tx.airdropAccount.update({
          where: { userId_seasonId: { userId: r.userId, seasonId: r.seasonId } },
          data: { totalPoints: { decrement: r.points } },
        })
      }
    })
  } catch (e) {
    logger.warn({ err: e, tradeId }, 'airdrop clawback failed')
  }
}

// ── Public: daily check-in ──────────────────────────────────────────────────
export interface CheckinResult {
  streak: number
  multiplier: number
  alreadyToday: boolean
  pointsAwarded: number
}

export async function dailyCheckin(userId: string): Promise<CheckinResult> {
  if (!(await isAirdropEnabled())) throw new AppError('AIRDROP_OFF', 'The airdrop is not live yet.', 400)
  const cfg = await loadAirdropConfig()
  return db.$transaction(async (tx) => {
    const seasonId = await resolveActiveSeasonId(tx)
    if (!seasonId) throw new AppError('AIRDROP_OFF', 'No active airdrop season.', 400)
    if (cfg.requireKyc && !(await isKycOk(tx, userId))) {
      throw new AppError('KYC_REQUIRED', 'Complete identity verification (KYC) to earn airdrop points.', 403)
    }
    const dayStr = startOfUtcDay().toISOString().slice(0, 10)
    const eventKey = `checkin:${userId}:${dayStr}`
    const existing = await tx.airdropLedger.findUnique({ where: { eventKey }, select: { id: true } })

    const mult = await applyStreakTouch(tx, userId, seasonId, cfg)
    let pointsAwarded = 0
    if (!existing && cfg.checkinPoints > 0) {
      pointsAwarded = cfg.checkinPoints
      await writeLedger(tx, { userId, seasonId, source: 'checkin', points: pointsAwarded, eventKey, metadata: { day: dayStr } })
    }
    const acc = await tx.airdropAccount.findUniqueOrThrow({ where: { userId_seasonId: { userId, seasonId } }, select: { streakCount: true } })
    return { streak: acc.streakCount, multiplier: mult, alreadyToday: !!existing, pointsAwarded }
  })
}

// ── Public: repair a broken streak (spend points) ───────────────────────────
export async function repairStreak(userId: string): Promise<{ restored: number; cost: number }> {
  if (!(await isAirdropEnabled())) throw new AppError('AIRDROP_OFF', 'The airdrop is not live yet.', 400)
  const cfg = await loadAirdropConfig()
  return db.$transaction(async (tx) => {
    const seasonId = await resolveActiveSeasonId(tx)
    if (!seasonId) throw new AppError('AIRDROP_OFF', 'No active airdrop season.', 400)
    const acc = await tx.airdropAccount.findUnique({
      where: { userId_seasonId: { userId, seasonId } },
      select: { streakCount: true, preBreakStreak: true, streakBrokenAt: true, repairsUsed: true, totalPoints: true, longestStreak: true },
    })
    if (!acc || !acc.streakBrokenAt) throw new AppError('NO_BROKEN_STREAK', 'There is no broken streak to repair.', 400)
    if (Date.now() - acc.streakBrokenAt.getTime() > cfg.repairWindowDays * 86_400_000) {
      throw new AppError('REPAIR_WINDOW_CLOSED', `The repair window (${cfg.repairWindowDays} days) has closed.`, 400)
    }
    if (acc.repairsUsed >= cfg.repairMax) throw new AppError('REPAIR_LIMIT', `You've used all ${cfg.repairMax} repairs this season.`, 400)
    if (acc.preBreakStreak <= acc.streakCount) throw new AppError('NOTHING_TO_RESTORE', 'Your current streak is already at or above the pre-break value.', 400)
    if (Number(acc.totalPoints) < cfg.repairCost) {
      throw new AppError('INSUFFICIENT_POINTS', `You need ${cfg.repairCost} points to repair your streak.`, 400)
    }
    const eventKey = `repair:${userId}:${Date.now()}`
    await writeLedger(tx, { userId, seasonId, source: 'admin_adjust', points: -cfg.repairCost, eventKey, metadata: { reason: 'streak_repair' } })
    await tx.airdropAccount.update({
      where: { userId_seasonId: { userId, seasonId } },
      data: {
        streakCount: acc.preBreakStreak,
        longestStreak: Math.max(acc.longestStreak, acc.preBreakStreak),
        streakBrokenAt: null,
        repairsUsed: acc.repairsUsed + 1,
        lastActiveDay: startOfUtcDay(),
      },
    })
    return { restored: acc.preBreakStreak, cost: cfg.repairCost }
  })
}

// ── Public: voluntary reset to zero ─────────────────────────────────────────
export async function resetStreak(userId: string): Promise<void> {
  if (!(await isAirdropEnabled())) throw new AppError('AIRDROP_OFF', 'The airdrop is not live yet.', 400)
  const seasonId = await resolveActiveSeasonId(db)
  if (!seasonId) return
  await db.airdropAccount.updateMany({
    where: { userId, seasonId },
    data: { streakCount: 0, preBreakStreak: 0, streakBrokenAt: null, lastActiveDay: null },
  })
}

// ── Public: read model for the Airdrop tab ──────────────────────────────────────
export interface AirdropStreak {
  count: number
  longest: number
  multiplier: number
  freezes: number
  brokenAt: string | null
  preBreakStreak: number
  canRepair: boolean
  repairCost: number
  repairsLeft: number
  checkedInToday: boolean
}

export interface AirdropStatus {
  enabled: boolean
  season: { index: number; name: string } | null
  totalPoints: number
  breakdown: { source: string; points: number }[]
  milestone: { current: number; target: number }
  streak: AirdropStreak | null
  level: UserLevel | null
  levelsLive: boolean // whether the level discount is actually applied to fees yet
}

export async function getAirdropStatus(userId: string): Promise<AirdropStatus> {
  const enabled = await isAirdropEnabled()
  const season = await db.airdropSeason.findFirst({ where: { status: 'active' }, orderBy: { index: 'desc' } })
  if (!enabled || !season) {
    const target = await getNumberConfig(CFG.targetUsers, DEF.targetUsers)
    return { enabled, season: season ? { index: season.index, name: season.name } : null, totalPoints: 0, breakdown: [], milestone: { current: 0, target }, streak: null, level: null, levelsLive: false }
  }

  const cfg = await loadAirdropConfig()
  const dayStr = startOfUtcDay().toISOString().slice(0, 10)
  const [account, grouped, userCount, checkin, level, levelsLive] = await Promise.all([
    db.airdropAccount.findUnique({
      where: { userId_seasonId: { userId, seasonId: season.id } },
      select: { totalPoints: true, streakCount: true, longestStreak: true, freezes: true, streakBrokenAt: true, preBreakStreak: true, repairsUsed: true },
    }),
    db.airdropLedger.groupBy({ by: ['source'], where: { userId, seasonId: season.id }, _sum: { points: true } }),
    db.user.count(),
    db.airdropLedger.findUnique({ where: { eventKey: `checkin:${userId}:${dayStr}` }, select: { id: true } }),
    getUserLevel(userId),
    isFlagEnabled(FLAGS.AIRDROP_LEVELS),
  ])

  const breakdown = grouped
    .map((g) => ({ source: g.source as string, points: Number(g._sum.points ?? 0) }))
    .filter((b) => b.points !== 0)
    .sort((a, b) => b.points - a.points)

  const streakCount = account?.streakCount ?? 0
  const withinWindow = account?.streakBrokenAt
    ? Date.now() - account.streakBrokenAt.getTime() <= cfg.repairWindowDays * 86_400_000
    : false
  const repairsLeft = Math.max(0, cfg.repairMax - (account?.repairsUsed ?? 0))
  const streak: AirdropStreak = {
    count: streakCount,
    longest: account?.longestStreak ?? 0,
    multiplier: streakMultiplier(streakCount),
    freezes: account?.freezes ?? 0,
    brokenAt: account?.streakBrokenAt ? account.streakBrokenAt.toISOString() : null,
    preBreakStreak: account?.preBreakStreak ?? 0,
    canRepair: withinWindow && repairsLeft > 0 && (account?.preBreakStreak ?? 0) > streakCount && Number(account?.totalPoints ?? 0) >= cfg.repairCost,
    repairCost: cfg.repairCost,
    repairsLeft,
    checkedInToday: !!checkin,
  }

  return {
    enabled: true,
    season: { index: season.index, name: season.name },
    totalPoints: Number(account?.totalPoints ?? 0),
    breakdown,
    milestone: { current: userCount, target: cfg.targetUsers },
    streak,
    level,
    levelsLive,
  }
}

export interface AirdropLedgerEntry {
  id: string
  source: string
  points: number
  createdAt: Date
  metadata: unknown
}

export async function getAirdropLedger(userId: string, limit = 50): Promise<AirdropLedgerEntry[]> {
  const season = await db.airdropSeason.findFirst({ where: { status: 'active' }, orderBy: { index: 'desc' }, select: { id: true } })
  if (!season) return []
  const rows = await db.airdropLedger.findMany({
    where: { userId, seasonId: season.id },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 100),
    select: { id: true, source: true, points: true, createdAt: true, metadata: true },
  })
  return rows.map((r) => ({ id: r.id, source: r.source as string, points: Number(r.points), createdAt: r.createdAt, metadata: r.metadata }))
}
