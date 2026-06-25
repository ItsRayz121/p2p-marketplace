/**
 * Gas referrals — KOL income paid from the platform margin only.
 *
 * Model: any user can own a referral code. A referred user is bound to a referrer
 * FIRST-TOUCH and stays bound for life. Every delivered, paid gas order by a
 * referred user accrues `referralPct × realized margin` to the referrer, where
 * realized margin = platformMarginUsdt − discountUsdt (the margin actually kept
 * after any promo discount). The reward therefore can NEVER exceed the margin and
 * never touches the base gas cost. Free-grant orders (platform-funded) accrue
 * nothing. Accrual fires only on 'delivered' (terminal success — delivered orders
 * are never refunded), so a failed/refunded order never pays commission.
 *
 * Everything here is inert unless flag gas_referral_enabled is ON.
 */
import { db } from '../prisma'
import { Prisma } from '@prisma/client'
import { AppError } from '../errors'
import { logger } from '../logger'
import { isFlagEnabled, FLAGS, getNumberConfig } from '../../services/platformFlags.service'
import type { GasFeeOrder } from '@prisma/client'

const DEFAULT_PCT_CONFIG = 'gas_referral_default_pct'
const DEFAULT_PCT = 5
// Anti-abuse + withdrawal config (PlatformConfig keys; safe defaults).
const MIN_ORDER_CONFIG       = 'gas_referral_min_order_usd'        // skip accrual below this order value
const MAX_PER_REFERRED_CONFIG = 'gas_referral_max_per_referred_usdt' // lifetime cap per referred user (0 = none)
const HOLD_HOURS_CONFIG      = 'gas_referral_hold_hours'          // fraud-hold before earnings are withdrawable
const MIN_WITHDRAW_CONFIG    = 'gas_referral_min_withdraw_usdt'   // minimum withdrawal
const DEFAULT_HOLD_HOURS     = 72
const DEFAULT_MIN_WITHDRAW   = 5

function round2(n: number): number { return Math.round(n * 100) / 100 }
export function normalizeReferralCode(code: string): string { return code.trim().toUpperCase() }

/** Generate a short, human-friendly, unique referral code. */
export async function generateUniqueCode(): Promise<string> {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no ambiguous 0/O/1/I
  for (let attempt = 0; attempt < 12; attempt++) {
    let s = 'GAS'
    for (let i = 0; i < 5; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)]
    const existing = await db.gasReferralCode.findUnique({ where: { code: s } })
    if (!existing) return s
  }
  throw new AppError('REFERRAL_CODE_GEN', 'Could not allocate a referral code, please retry.', 500)
}

/** Get the caller's referral code, creating one on first access (pct from config). */
export async function getOrCreateOwnCode(userId: string): Promise<{ id: string; code: string; referralPct: number; isActive: boolean }> {
  const existing = await db.gasReferralCode.findFirst({ where: { ownerId: userId }, orderBy: { createdAt: 'asc' } })
  if (existing) return { id: existing.id, code: existing.code, referralPct: existing.referralPct, isActive: existing.isActive }
  const pct = await getNumberConfig(DEFAULT_PCT_CONFIG, DEFAULT_PCT)
  const code = await generateUniqueCode()
  const created = await db.gasReferralCode.create({ data: { code, ownerId: userId, referralPct: pct } })
  return { id: created.id, code: created.code, referralPct: created.referralPct, isActive: created.isActive }
}

/**
 * Bind the caller to a referrer via a code (first-touch, permanent). Idempotent:
 * if already bound, returns the existing binding unchanged. Blocks self-referral.
 */
export async function bindReferral(userId: string, rawCode: string): Promise<{ bound: boolean; referrerId: string }> {
  const code = normalizeReferralCode(rawCode)
  const existingBinding = await db.gasReferral.findUnique({ where: { referredId: userId } })
  if (existingBinding) return { bound: false, referrerId: existingBinding.referrerId }

  const refCode = await db.gasReferralCode.findUnique({ where: { code } })
  if (!refCode || !refCode.isActive) throw new AppError('REFERRAL_INVALID', 'This referral code is not valid.', 400)
  if (refCode.ownerId === userId) throw new AppError('REFERRAL_SELF', 'You cannot refer yourself.', 400)

  try {
    await db.gasReferral.create({ data: { referredId: userId, referrerId: refCode.ownerId, codeId: refCode.id } })
  } catch {
    // Unique race: someone bound this user concurrently — treat as already bound.
    const now = await db.gasReferral.findUnique({ where: { referredId: userId } })
    return { bound: false, referrerId: now?.referrerId ?? refCode.ownerId }
  }
  return { bound: true, referrerId: refCode.ownerId }
}

/**
 * Accrue a referral reward for a freshly-delivered order. Best-effort + idempotent
 * (orderId is unique). No-op unless the flag is ON, the order is a paid (non-free)
 * order with a bound referrer and a positive realized margin.
 */
export async function accrueReferralForDelivery(order: GasFeeOrder): Promise<void> {
  if (!(await isFlagEnabled(FLAGS.GAS_REFERRAL))) return
  if (order.isFreeGrant) return
  if (!order.userId) return

  const binding = await db.gasReferral.findUnique({
    where: { referredId: order.userId },
    include: { code: true },
  })
  if (!binding || !binding.code.isActive) return
  if (binding.referrerId === order.userId) return // safety: never self-accrue

  // Anti-abuse: ignore dust orders below the configured minimum order value.
  const minOrderUsd = await getNumberConfig(MIN_ORDER_CONFIG, 0)
  if (minOrderUsd > 0 && Number(order.paymentAmount) < minOrderUsd) return

  const grossMargin = Number(order.platformMarginUsdt ?? 0)
  const discount = Number(order.discountUsdt ?? 0)
  const realizedMargin = round2(Math.max(0, grossMargin - discount))
  if (realizedMargin <= 0) return

  const pct = binding.code.referralPct
  // Commission is referralPct of the GROSS margin, but never more than the margin the
  // platform actually KEPT after all discounts (realizedMargin). This guarantees the
  // platform can never pay out more margin than it earned — affiliate commission and the
  // buyer's auto-discount together stay margin-only and never touch the base gas cost.
  let amount = round2(Math.min((pct / 100) * grossMargin, realizedMargin))
  if (amount <= 0) return

  // Anti-abuse: clamp to the per-referred-user lifetime commission cap (if set), so a
  // single referred account can't farm unlimited commission for the referrer.
  const maxPerReferred = await getNumberConfig(MAX_PER_REFERRED_CONFIG, 0)
  if (maxPerReferred > 0) {
    const prior = await db.gasReferralAccrual.aggregate({
      where: { referrerId: binding.referrerId, referredId: order.userId },
      _sum: { amountUsdt: true },
    })
    const already = Number(prior._sum.amountUsdt ?? 0)
    const remaining = round2(maxPerReferred - already)
    if (remaining <= 0) return
    amount = Math.min(amount, remaining)
    if (amount <= 0) return
  }

  try {
    await db.gasReferralAccrual.create({
      data: {
        referrerId: binding.referrerId,
        referredId: order.userId,
        orderId: order.id,
        marginUsdt: realizedMargin,
        amountUsdt: amount,
        pct,
        status: 'available',
      },
    })
    logger.info({ orderId: order.id, referrerId: binding.referrerId, amount }, 'gas referral accrued')
  } catch {
    // Unique(orderId) — already accrued (e.g. retried delivery finalisation). Ignore.
  }
}

export interface ReferralSummary {
  enabled: boolean
  code: string | null
  referralPct: number | null
  referredCount: number
  totalAccruedUsdt: number
  availableUsdt: number
  withdrawableUsdt: number      // available AND past the fraud-hold window
  withdrawnUsdt: number
  minWithdrawUsdt: number
  kycOk: boolean
  boundToReferrer: boolean
}

function holdCutoff(holdHours: number): Date {
  return new Date(Date.now() - holdHours * 3_600_000)
}

/** Dashboard summary for a user: their code, referred count, and earnings. */
export async function getReferralSummary(userId: string): Promise<ReferralSummary> {
  const enabled = await isFlagEnabled(FLAGS.GAS_REFERRAL)
  if (!enabled) {
    return { enabled: false, code: null, referralPct: null, referredCount: 0, totalAccruedUsdt: 0, availableUsdt: 0, withdrawableUsdt: 0, withdrawnUsdt: 0, minWithdrawUsdt: 0, kycOk: false, boundToReferrer: false }
  }

  const own = await getOrCreateOwnCode(userId)
  const [holdHours, minWithdraw] = await Promise.all([
    getNumberConfig(HOLD_HOURS_CONFIG, DEFAULT_HOLD_HOURS),
    getNumberConfig(MIN_WITHDRAW_CONFIG, DEFAULT_MIN_WITHDRAW),
  ])
  const cutoff = holdCutoff(holdHours)

  const [referredCount, accruals, binding, user] = await Promise.all([
    db.gasReferral.count({ where: { referrerId: userId } }),
    db.gasReferralAccrual.findMany({ where: { referrerId: userId }, select: { amountUsdt: true, status: true, createdAt: true } }),
    db.gasReferral.findUnique({ where: { referredId: userId }, select: { id: true } }),
    db.user.findUnique({ where: { id: userId }, select: { kycLevel: true } }),
  ])

  let total = 0, available = 0, withdrawable = 0, withdrawn = 0
  for (const a of accruals) {
    const amt = Number(a.amountUsdt)
    total += amt
    if (a.status === 'available') {
      available += amt
      if (a.createdAt <= cutoff) withdrawable += amt
    } else if (a.status === 'withdrawn') withdrawn += amt
  }

  return {
    enabled: true,
    code: own.code,
    referralPct: own.referralPct,
    referredCount,
    totalAccruedUsdt: round2(total),
    availableUsdt: round2(available),
    withdrawableUsdt: round2(withdrawable),
    withdrawnUsdt: round2(withdrawn),
    minWithdrawUsdt: minWithdraw,
    kycOk: !!user && user.kycLevel !== 'none',
    boundToReferrer: !!binding,
  }
}

/**
 * Withdraw available referral earnings (past the fraud-hold window) into the user's
 * internal USDT balance. Guards: flag ON, KYC ≥ basic, total ≥ min threshold. The
 * eligible accruals are flipped to 'withdrawn' and the USDT wallet credited inside one
 * transaction with a CAS guard, so a double-submit can never pay twice.
 */
export async function withdrawReferralEarnings(userId: string): Promise<{ withdrawnUsdt: number; newBalanceUsdt: number }> {
  if (!(await isFlagEnabled(FLAGS.GAS_REFERRAL))) {
    throw new AppError('REFERRAL_DISABLED', 'Referrals are not available right now.', 400)
  }
  const user = await db.user.findUnique({ where: { id: userId }, select: { kycLevel: true } })
  if (!user || user.kycLevel === 'none') {
    throw new AppError('KYC_REQUIRED', 'Complete identity verification (KYC) to withdraw referral earnings.', 403)
  }
  const [holdHours, minWithdraw] = await Promise.all([
    getNumberConfig(HOLD_HOURS_CONFIG, DEFAULT_HOLD_HOURS),
    getNumberConfig(MIN_WITHDRAW_CONFIG, DEFAULT_MIN_WITHDRAW),
  ])
  const cutoff = holdCutoff(holdHours)

  return db.$transaction(async (tx) => {
    const eligible = await tx.gasReferralAccrual.findMany({
      where: { referrerId: userId, status: 'available', createdAt: { lte: cutoff } },
      select: { id: true, amountUsdt: true },
    })
    const total = round2(eligible.reduce((s, a) => s + Number(a.amountUsdt), 0))
    if (total <= 0) throw new AppError('NOTHING_TO_WITHDRAW', 'You have no withdrawable referral earnings yet.', 400)
    if (total < minWithdraw) throw new AppError('BELOW_MIN_WITHDRAW', `Minimum withdrawal is $${minWithdraw.toFixed(2)}. You have $${total.toFixed(2)} available.`, 400)

    const ids = eligible.map((a) => a.id)
    // CAS: only flip rows still 'available'; if the count drifts, abort the whole tx.
    const flipped = await tx.gasReferralAccrual.updateMany({
      where: { id: { in: ids }, status: 'available' },
      data: { status: 'withdrawn' },
    })
    if (flipped.count !== ids.length) {
      throw new AppError('REFERRAL_BUSY', 'Withdrawal is being processed — please retry in a moment.', 409)
    }

    // Credit the user's internal USDT balance (real, withdrawable funds).
    const existingUsdt = await tx.wallet.findFirst({ where: { userId, coin: 'USDT' }, select: { network: true } })
    const network = existingUsdt?.network ?? 'BEP20'
    const amountDec = new Prisma.Decimal(total)
    const wallet = await tx.wallet.upsert({
      where: { userId_coin_network: { userId, coin: 'USDT', network } },
      create: { userId, coin: 'USDT', network, balance: amountDec, lockedBalance: new Prisma.Decimal(0) },
      update: { balance: { increment: amountDec } },
    })
    await tx.transaction.create({
      data: {
        walletId: wallet.id,
        type: 'referral_reward',
        amount: amountDec,
        fee: new Prisma.Decimal(0),
        status: 'completed',
        metadata: { source: 'gas_referral_payout', accrualCount: ids.length },
      },
    })
    logger.info({ userId, total, accrualCount: ids.length }, 'gas referral earnings withdrawn to USDT balance')
    return { withdrawnUsdt: total, newBalanceUsdt: Number(wallet.balance) }
  })
}
