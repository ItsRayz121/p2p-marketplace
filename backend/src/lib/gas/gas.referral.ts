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
import { AppError } from '../errors'
import { logger } from '../logger'
import { isFlagEnabled, FLAGS, getNumberConfig } from '../../services/platformFlags.service'
import type { GasFeeOrder } from '@prisma/client'

const DEFAULT_PCT_CONFIG = 'gas_referral_default_pct'
const DEFAULT_PCT = 5

function round2(n: number): number { return Math.round(n * 100) / 100 }
export function normalizeReferralCode(code: string): string { return code.trim().toUpperCase() }

/** Generate a short, human-friendly, unique referral code. */
async function generateUniqueCode(): Promise<string> {
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

  const margin = Number(order.platformMarginUsdt ?? 0)
  const discount = Number(order.discountUsdt ?? 0)
  const realizedMargin = round2(Math.max(0, margin - discount))
  if (realizedMargin <= 0) return

  const pct = binding.code.referralPct
  const amount = round2((pct / 100) * realizedMargin)
  if (amount <= 0) return

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
  withdrawnUsdt: number
  boundToReferrer: boolean
}

/** Dashboard summary for a user: their code, referred count, and earnings. */
export async function getReferralSummary(userId: string): Promise<ReferralSummary> {
  const enabled = await isFlagEnabled(FLAGS.GAS_REFERRAL)
  if (!enabled) {
    return { enabled: false, code: null, referralPct: null, referredCount: 0, totalAccruedUsdt: 0, availableUsdt: 0, withdrawnUsdt: 0, boundToReferrer: false }
  }

  const own = await getOrCreateOwnCode(userId)
  const [referredCount, accruals, binding] = await Promise.all([
    db.gasReferral.count({ where: { referrerId: userId } }),
    db.gasReferralAccrual.findMany({ where: { referrerId: userId }, select: { amountUsdt: true, status: true } }),
    db.gasReferral.findUnique({ where: { referredId: userId }, select: { id: true } }),
  ])

  let total = 0, available = 0, withdrawn = 0
  for (const a of accruals) {
    const amt = Number(a.amountUsdt)
    total += amt
    if (a.status === 'available') available += amt
    else if (a.status === 'withdrawn') withdrawn += amt
  }

  return {
    enabled: true,
    code: own.code,
    referralPct: own.referralPct,
    referredCount,
    totalAccruedUsdt: round2(total),
    availableUsdt: round2(available),
    withdrawnUsdt: round2(withdrawn),
    boundToReferrer: !!binding,
  }
}
