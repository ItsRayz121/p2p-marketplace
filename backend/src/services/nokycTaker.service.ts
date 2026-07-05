import { Prisma } from '@prisma/client'
import { db } from '../lib/prisma'
import { AppError } from '../lib/errors'
import { FLAGS, isFlagEnabled, getNumberConfig } from './platformFlags.service'
import { countActiveTrades, hasOpenDispute, isTradeLimitBypassed } from './tradeConcurrency.service'
import type { TradeStatus, CtmTradeStatus } from '@prisma/client'

/**
 * No-KYC taker access & limits (Phase 2).
 *
 * Lets an UNVERIFIED user TAKE trades (respond to someone else's ad/listing)
 * without KYC, subject to hard PKR limits, while keeping ad/listing CREATION
 * KYC-mandatory (enforced at the creation paths, unchanged).
 *
 * Layered protection (all admin-tunable via PlatformConfig):
 *   - Per-trade   ≤ nokyc_max_per_trade_pkr   (default 20 000)
 *   - Daily       ≤ nokyc_max_daily_pkr        (default 60 000, rolling 24h)
 *   - Lifetime    ≤ nokyc_rolling_ceiling_pkr  (default 150 000) → forces KYC
 *   - Open trades < nokyc_max_open_trades       (default 1)
 *
 * Safety gate: a no-KYC taker is only ever allowed when THEY send their leg
 * FIRST (so they can't take the counterparty's value and vanish). That's true
 * on sell-side ads today, and on buy-side ads once taker-first settlement is on
 * (Phase 1). The caller passes `takerSendsFirst`.
 *
 * Everything is behind `nokyc_taker_enabled` (default OFF): when OFF this helper
 * enforces the pre-existing "KYC required to trade" behavior for USDT, and adds
 * no relaxation for CTM — so pushing to main changes nothing until a super-admin
 * flips the flag.
 */

// Trade statuses that count toward a taker's volume (everything except the
// terminal "nothing happened" states — a cancelled/expired trade moved no value).
const USDT_COUNTED = [
  'payment_pending', 'payment_uploaded', 'payment_confirmed', 'crypto_sent', 'crypto_released', 'disputed', 'dispute_resolved',
] as unknown as TradeStatus[]
const CTM_COUNTED = [
  'awaiting_payment', 'payment_uploaded', 'payment_confirmed', 'seller_transferring', 'proof_submitted', 'buyer_confirming', 'completed', 'disputed', 'dispute_resolved',
] as unknown as CtmTradeStatus[]

/** Sum a user's taker-side PKR volume across BOTH markets, optionally since a time. */
async function takerVolumePkr(userId: string, since?: Date): Promise<Prisma.Decimal> {
  const party = { OR: [{ buyerId: userId }, { sellerId: userId }] }
  const timeFilter = since ? { createdAt: { gte: since } } : {}
  const [usdt, ctm] = await Promise.all([
    db.trade.aggregate({ _sum: { fiatAmount: true }, where: { ...party, ...timeFilter, status: { in: USDT_COUNTED } } }),
    db.ctmTrade.aggregate({ _sum: { fiatAmount: true }, where: { ...party, ...timeFilter, status: { in: CTM_COUNTED } } }),
  ])
  return new Prisma.Decimal(usdt._sum.fiatAmount ?? 0).add(ctm._sum.fiatAmount ?? 0)
}

/** A taker's remaining no-KYC headroom, for surfacing in the UI (best-effort). */
export async function getNoKycTakerStatus(userId: string): Promise<{
  verified: boolean
  enabled: boolean
  perTradePkr: number
  dailyUsedPkr: number
  dailyLimitPkr: number
  lifetimeUsedPkr: number
  lifetimeCeilingPkr: number
  openTrades: number
  maxOpenTrades: number
}> {
  const [user, enabled, perTrade, dailyLimit, ceiling, maxOpen] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { kycStatus: true } }),
    isFlagEnabled(FLAGS.NOKYC_TAKER),
    getNumberConfig('nokyc_max_per_trade_pkr', 20000),
    getNumberConfig('nokyc_max_daily_pkr', 60000),
    getNumberConfig('nokyc_rolling_ceiling_pkr', 150000),
    getNumberConfig('nokyc_max_open_trades', 1),
  ])
  const verified = user?.kycStatus === 'approved'
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const [daily, lifetime, openTrades] = await Promise.all([
    verified ? Promise.resolve(new Prisma.Decimal(0)) : takerVolumePkr(userId, since),
    verified ? Promise.resolve(new Prisma.Decimal(0)) : takerVolumePkr(userId),
    countActiveTrades(userId),
  ])
  return {
    verified,
    enabled,
    perTradePkr: perTrade,
    dailyUsedPkr: daily.toNumber(),
    dailyLimitPkr: dailyLimit,
    lifetimeUsedPkr: lifetime.toNumber(),
    lifetimeCeilingPkr: ceiling,
    openTrades,
    maxOpenTrades: maxOpen,
  }
}

/**
 * Throw if an unverified taker may NOT open this trade. No-op (returns) when the
 * taker is KYC-approved — verified users keep their existing limits elsewhere.
 *
 * @param takerId        the initiator (party responding to the ad/listing)
 * @param fiatAmount     PKR value of THIS trade
 * @param takerSendsFirst true when the taker locks their own leg before the maker moves
 */
export async function assertNoKycTakerAllowed(params: {
  takerId: string
  fiatAmount: Prisma.Decimal | number | string
  takerSendsFirst: boolean
  /**
   * What to do when the flag is OFF (default) and the taker is unverified — this
   * MUST mirror each market's pre-existing behavior so deploying is a no-op until
   * the flag is flipped:
   *   - 'block' (default): throw KYC_REQUIRED. Use for USDT, which hard-gates trading on KYC today.
   *   - 'allow': permit with no limits. Use for CTM, which does NOT gate trading on KYC today.
   */
  flagOffBehavior?: 'block' | 'allow'
}): Promise<void> {
  const { takerId, takerSendsFirst, flagOffBehavior = 'block' } = params
  const fiat = new Prisma.Decimal(params.fiatAmount)

  const user = await db.user.findUnique({ where: { id: takerId }, select: { kycStatus: true } })
  // Verified takers are unaffected by no-KYC caps.
  if (user?.kycStatus === 'approved') return

  // Test/staff accounts bypass entirely (parity with the concurrency cap).
  if (await isTradeLimitBypassed(takerId)) return

  // Flag OFF (default) → preserve each market's pre-existing behavior verbatim.
  if (!(await isFlagEnabled(FLAGS.NOKYC_TAKER))) {
    if (flagOffBehavior === 'allow') return
    throw new AppError('KYC_REQUIRED', 'KYC verification required to trade', 403)
  }

  // No-KYC is only safe where the taker commits their leg first. On buy-side ads
  // the taker moves second until taker-first settlement is enabled (Phase 1), so
  // block no-KYC there and ask them to verify.
  if (!takerSendsFirst) {
    throw new AppError(
      'KYC_REQUIRED',
      'Verify your identity (KYC) to trade on this listing. Unverified trading is available on listings where you send first.',
      403,
    )
  }

  // Escalation: a dispute filed against the taker freezes further no-KYC trading
  // until they verify. (Payment-reversal freezes are applied out-of-band by admin;
  // this covers the on-platform signal.)
  if (await hasOpenDispute(takerId)) {
    throw new AppError(
      'KYC_REQUIRED',
      'There is an open dispute involving your account. Please complete KYC verification to continue trading.',
      403,
    )
  }

  const [perTrade, dailyLimit, ceiling, maxOpen] = await Promise.all([
    getNumberConfig('nokyc_max_per_trade_pkr', 20000),
    getNumberConfig('nokyc_max_daily_pkr', 60000),
    getNumberConfig('nokyc_rolling_ceiling_pkr', 150000),
    getNumberConfig('nokyc_max_open_trades', 1),
  ])

  // Per-trade cap.
  if (perTrade > 0 && fiat.gt(perTrade)) {
    throw new AppError(
      'NOKYC_LIMIT_EXCEEDED',
      `Unverified trades are limited to PKR ${perTrade.toLocaleString()} each. Verify your identity to trade larger amounts.`,
      403,
    )
  }

  // Single-open-trade cap (default 1) — a no-KYC taker must finish their current
  // trade before starting another.
  if (maxOpen > 0) {
    const open = await countActiveTrades(takerId)
    if (open >= maxOpen) {
      throw new AppError(
        'NOKYC_TOO_MANY_OPEN_TRADES',
        maxOpen === 1
          ? 'Finish your current trade before starting another. Verify your identity to run more at once.'
          : `Unverified users can have ${maxOpen} open trades at a time. Verify your identity to run more.`,
        429,
      )
    }
  }

  // Daily (rolling 24h) cap.
  if (dailyLimit > 0) {
    const daily = await takerVolumePkr(takerId, new Date(Date.now() - 24 * 60 * 60 * 1000))
    if (daily.add(fiat).gt(dailyLimit)) {
      throw new AppError(
        'NOKYC_DAILY_LIMIT_EXCEEDED',
        `This would exceed the daily unverified limit of PKR ${dailyLimit.toLocaleString()}. Verify your identity to trade more today.`,
        403,
      )
    }
  }

  // Lifetime ceiling → crossing it forces KYC to continue at all.
  if (ceiling > 0) {
    const lifetime = await takerVolumePkr(takerId)
    if (lifetime.add(fiat).gt(ceiling)) {
      throw new AppError(
        'KYC_REQUIRED',
        `You've reached the unverified trading limit of PKR ${ceiling.toLocaleString()}. Please complete KYC verification to keep trading.`,
        403,
      )
    }
  }
}
