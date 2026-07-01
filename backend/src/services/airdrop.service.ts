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
}

export async function loadAirdropConfig(): Promise<AirdropConfig> {
  const [
    pkrPerPoint, minTradePkr, dailyTradeCap, decayStep, decayMin,
    gasPerOrder, gasMinUsd, gasDailyCap, referralPct, targetUsers, requireKyc,
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
  ])
  return { pkrPerPoint, minTradePkr, dailyTradeCap, decayStep, decayMin, gasPerOrder, gasMinUsd, gasDailyCap, referralPct, requireKyc, targetUsers }
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
    const base = pkr / cfg.pkrPerPoint
    const decayed = base * (await counterpartyDecay(tx, userId, seasonId, pairKey, cfg))
    const pts = await clampDailyTrade(tx, userId, seasonId, decayed, cfg.dailyTradeCap)
    if (pts <= 0) continue
    const eventKey = `${source}:${opts.tradeId}:${role}`
    await writeLedger(tx, { userId, seasonId, source, points: pts, eventKey, pairKey, metadata: { tradeId: opts.tradeId, role, pkr } })
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

      // Daily cap on gas points.
      const agg = await tx.airdropLedger.aggregate({
        where: { userId, seasonId, source: 'gas_order', createdAt: { gte: startOfUtcDay() } },
        _sum: { points: true },
      })
      const used = Number(agg._sum.points ?? 0)
      const pts = cfg.gasDailyCap > 0 ? Math.max(0, Math.min(cfg.gasPerOrder, cfg.gasDailyCap - used)) : cfg.gasPerOrder
      if (pts <= 0) return

      const eventKey = `gas_order:${order.id}`
      await writeLedger(tx, { userId, seasonId, source: 'gas_order', points: pts, eventKey, metadata: { orderRef: order.orderRef, usd } })
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

// ── Public: read model for the Airdrop tab (Phase 2 consumes this) ──────────────
export interface AirdropStatus {
  enabled: boolean
  season: { index: number; name: string } | null
  totalPoints: number
  breakdown: { source: string; points: number }[]
  milestone: { current: number; target: number }
}

export async function getAirdropStatus(userId: string): Promise<AirdropStatus> {
  const enabled = await isAirdropEnabled()
  const season = await db.airdropSeason.findFirst({ where: { status: 'active' }, orderBy: { index: 'desc' } })
  if (!enabled || !season) {
    const target = await getNumberConfig(CFG.targetUsers, DEF.targetUsers)
    return { enabled, season: season ? { index: season.index, name: season.name } : null, totalPoints: 0, breakdown: [], milestone: { current: 0, target } }
  }

  const [account, grouped, userCount, target] = await Promise.all([
    db.airdropAccount.findUnique({ where: { userId_seasonId: { userId, seasonId: season.id } }, select: { totalPoints: true } }),
    db.airdropLedger.groupBy({ by: ['source'], where: { userId, seasonId: season.id }, _sum: { points: true } }),
    db.user.count(),
    getNumberConfig(CFG.targetUsers, DEF.targetUsers),
  ])

  const breakdown = grouped
    .map((g) => ({ source: g.source as string, points: Number(g._sum.points ?? 0) }))
    .filter((b) => b.points !== 0)
    .sort((a, b) => b.points - a.points)

  return {
    enabled: true,
    season: { index: season.index, name: season.name },
    totalPoints: Number(account?.totalPoints ?? 0),
    breakdown,
    milestone: { current: userCount, target },
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
