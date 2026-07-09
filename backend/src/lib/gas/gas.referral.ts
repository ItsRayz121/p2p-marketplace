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
import { notify } from '../notify'
import type { GasFeeOrder } from '@prisma/client'

const DEFAULT_PCT_CONFIG = 'gas_referral_default_pct'
const DEFAULT_PCT = 5
// Standard buyer discount given to a friend who joins via ANY referral link (base or
// custom). Self-service custom links use this for both the discount and the commission;
// the base code is healed up to this discount so the primary link also rewards the friend.
export const USER_DISCOUNT_CONFIG = 'gas_referral_user_discount_pct'
export const DEFAULT_USER_DISCOUNT = 5
// Anti-abuse + withdrawal config (PlatformConfig keys; safe defaults).
const MIN_ORDER_CONFIG       = 'gas_referral_min_order_usd'        // skip accrual below this order value
const MAX_PER_REFERRED_CONFIG = 'gas_referral_max_per_referred_usdt' // lifetime cap per referred user (0 = none)
const HOLD_HOURS_CONFIG      = 'gas_referral_hold_hours'          // fraud-hold before earnings are withdrawable
const MIN_WITHDRAW_CONFIG    = 'gas_referral_min_withdraw_usdt'   // minimum withdrawal
const DEFAULT_HOLD_HOURS     = 24
const DEFAULT_MIN_WITHDRAW   = 5

function round2(n: number): number { return Math.round(n * 100) / 100 }
export function normalizeReferralCode(code: string): string { return code.trim().toUpperCase() }

/**
 * Validate + normalize a user-chosen ("vanity") referral code and ensure it is not already
 * taken in EITHER namespace — gas/affiliate codes (`GasReferralCode`, including soft-deleted
 * ones, which still attribute) or signup codes (`User.referralCode`). This keeps a code's
 * attribution unambiguous no matter which surface it is typed into (see resolveReferralOwner).
 * Returns the upper-cased code. Throws CODE_INVALID / CODE_TAKEN.
 */
export async function normalizeAndAssertVanityCode(raw: string): Promise<string> {
  const code = raw.trim().toUpperCase()
  if (!/^[A-Z0-9]{3,20}$/.test(code)) {
    throw new AppError('CODE_INVALID', 'Your link code must be 3–20 letters or numbers (no spaces or symbols).', 400)
  }
  const [gas, signup] = await Promise.all([
    db.gasReferralCode.findUnique({ where: { code }, select: { id: true } }),
    db.user.findFirst({ where: { referralCode: { equals: code, mode: 'insensitive' } }, select: { id: true } }),
  ])
  if (gas || signup) throw new AppError('CODE_TAKEN', 'That code is already taken — try another.', 409)
  return code
}

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

/**
 * Get the caller's BASE referral code (the oldest one they own), creating one on first
 * access. The base code carries the standard friend discount so the user's primary link
 * rewards both sides — a legacy base code created before the discount existed is healed
 * up to the configured default (idempotent; at most one write).
 */
export async function getOrCreateOwnCode(userId: string): Promise<{ id: string; code: string; referralPct: number; isActive: boolean; label: string | null }> {
  const discount = await getNumberConfig(USER_DISCOUNT_CONFIG, DEFAULT_USER_DISCOUNT)
  const existing = await db.gasReferralCode.findFirst({ where: { ownerId: userId }, orderBy: { createdAt: 'asc' } })
  if (existing) {
    if (existing.userDiscountPct < discount) {
      const healed = await db.gasReferralCode.update({ where: { id: existing.id }, data: { userDiscountPct: discount } })
      return { id: healed.id, code: healed.code, referralPct: healed.referralPct, isActive: healed.isActive, label: healed.label }
    }
    return { id: existing.id, code: existing.code, referralPct: existing.referralPct, isActive: existing.isActive, label: existing.label }
  }
  const pct = await getNumberConfig(DEFAULT_PCT_CONFIG, DEFAULT_PCT)
  const code = await generateUniqueCode()
  const created = await db.gasReferralCode.create({ data: { code, ownerId: userId, referralPct: pct, userDiscountPct: discount } })
  return { id: created.id, code: created.code, referralPct: created.referralPct, isActive: created.isActive, label: created.label }
}

/**
 * Set a vanity label/alias on the caller's own referral code. Purely cosmetic — it
 * does not change the code string or attribution; it just lets a user name their link
 * (e.g. "My Twitter drop"). Available to every user, not only affiliates.
 */
export async function setOwnCodeLabel(userId: string, rawLabel: string | null): Promise<{ label: string | null }> {
  const label = rawLabel?.trim().slice(0, 60) || null
  const own = await getOrCreateOwnCode(userId)
  const updated = await db.gasReferralCode.update({ where: { id: own.id }, data: { label } })
  return { label: updated.label }
}

/**
 * Resolve a referral code from EITHER namespace to its owner. The platform has two
 * code surfaces that must behave as one: the signup code (`User.referralCode`, shown
 * on /referral) and gas/affiliate codes (`GasReferralCode`, used at gas checkout).
 * A code typed anywhere should attribute to the same person regardless of which
 * surface it came from. Gas/affiliate codes are matched first because they carry the
 * discount-split (we return their id so the affiliate split is preserved); otherwise
 * we fall back to the signup code. Matching is case-insensitive.
 */
export async function resolveReferralOwner(rawCode: string): Promise<{ ownerId: string; gasCodeId: string | null } | null> {
  const norm = normalizeReferralCode(rawCode)
  if (!norm) return null
  const gas = await db.gasReferralCode.findUnique({ where: { code: norm } })
  // A soft-deleted custom link still attributes to its owner forever (old shared links
  // never break) but no longer carries its discount split → bind via the owner's base code.
  if (gas && gas.isActive) return { ownerId: gas.ownerId, gasCodeId: gas.deletedAt ? null : gas.id }
  const bySignup = await db.user.findFirst({ where: { referralCode: { equals: norm, mode: 'insensitive' } }, select: { id: true } })
  if (bySignup) return { ownerId: bySignup.id, gasCodeId: null }
  return null
}

/**
 * Unify a referred user under a single canonical referrer across BOTH systems —
 * the signup binding (`User.referredById`) and the gas binding (`GasReferral`).
 *
 * First-touch in EITHER system wins for both: whoever the user is already bound to
 * (signup OR gas) stays the owner, and we only fill in the *missing* side ("healing"),
 * so a person referred at signup automatically starts earning their referrer gas
 * commission, and vice-versa. When the user is bound to nobody yet, `rawCode` decides
 * the owner (cross-resolved against both namespaces). Idempotent; blocks self-referral.
 */
export async function bindReferral(referredUserId: string, rawCode?: string): Promise<{ bound: boolean; referrerId: string | null }> {
  const [user, gasBinding] = await Promise.all([
    db.user.findUnique({ where: { id: referredUserId }, select: { referredById: true } }),
    db.gasReferral.findUnique({ where: { referredId: referredUserId }, select: { referrerId: true } }),
  ])

  // Canonical owner already locked by an earlier touch in either system.
  let ownerId = user?.referredById ?? gasBinding?.referrerId ?? null
  let gasCodeId: string | null = null

  if (!ownerId) {
    if (!rawCode) return { bound: false, referrerId: null }
    const resolved = await resolveReferralOwner(rawCode)
    if (!resolved) throw new AppError('REFERRAL_INVALID', 'This referral code is not valid.', 400)
    if (resolved.ownerId === referredUserId) throw new AppError('REFERRAL_SELF', 'You cannot refer yourself.', 400)
    ownerId = resolved.ownerId
    gasCodeId = resolved.gasCodeId
  }
  if (ownerId === referredUserId) return { bound: false, referrerId: ownerId } // safety: never self-bind

  let didBind = false
  let signupNewlyBound = false
  // Heal the signup side (first-touch: only when not already set).
  if (!user?.referredById) {
    const res = await db.user.updateMany({ where: { id: referredUserId, referredById: null }, data: { referredById: ownerId } })
    if (res.count > 0) { didBind = true; signupNewlyBound = true }
  }
  // Heal the gas side. GasReferral.codeId is required, so attach the matched
  // affiliate code (preserving its split) or fall back to the owner's default code.
  if (!gasBinding) {
    const codeId = gasCodeId ?? (await getOrCreateOwnCode(ownerId)).id
    try {
      await db.gasReferral.create({ data: { referredId: referredUserId, referrerId: ownerId, codeId } })
      didBind = true
    } catch { /* unique race — already bound concurrently */ }
  }

  // Notify the referrer that a new person joined via their link. This path only
  // covers "heal" cases where bindReferral itself first establishes the signup
  // binding (a user created WITHOUT referredById, later bound via a gas code).
  // The common case — signup with a referral link — pre-sets referredById at user
  // creation, so it never reaches here; those paths call notifyReferralJoined()
  // directly (email path at verification, Google/Telegram at signup).
  if (signupNewlyBound && ownerId) {
    void notifyReferralJoined(ownerId, referredUserId)
  }

  return { bound: didBind, referrerId: ownerId }
}

/**
 * Notify a referrer that a new person joined via their link — the in-app bell +
 * web push + a Telegram DM (a positive, low-volume, user-initiated event worth
 * surfacing). This is the notification that was previously never delivered for
 * normal signups (referredById is set inline at user creation, so bindReferral's
 * "newly bound" branch never fired).
 *
 * De-duplicated on (referrer, referred) so it fires AT MOST ONCE per referred
 * user, which makes it safe to call from every seam — the three signup paths and
 * the bindReferral heal — without any risk of double-buzzing the referrer.
 * Best-effort: never throws into the caller.
 */
export async function notifyReferralJoined(referrerId: string, referredUserId: string): Promise<void> {
  try {
    if (!referrerId || referrerId === referredUserId) return

    // Idempotency guard — one join notification per referred user, ever.
    const already = await db.notification.findFirst({
      where: {
        userId: referrerId,
        type: 'referral',
        metadata: { path: ['referredUserId'], equals: referredUserId },
      },
      select: { id: true },
    })
    if (already) return

    const ru = await db.user.findUnique({ where: { id: referredUserId }, select: { username: true } })
    const who = ru?.username ? `@${ru.username}` : 'Someone new'
    notify(
      referrerId,
      'referral',
      'New referral joined 🎉',
      `${who} just signed up with your referral link. You'll earn rewards when they trade or top up gas.`,
      { referredUserId },
      undefined,
      '/referral',
      { telegram: true },
    )
  } catch (err) {
    logger.error({ err, referrerId, referredUserId }, 'notifyReferralJoined failed')
  }
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
    // Tell the referrer they just earned — a positive money event (bell + push +
    // Telegram DM). Fires only on a genuinely new accrual (past the unique guard).
    notify(
      binding.referrerId,
      'referral',
      'Referral reward earned 💰',
      `You earned $${amount.toFixed(2)} USDT in referral commission. Withdraw it from your Referral page after the hold window.`,
      { orderId: order.id, amountUsdt: amount },
      undefined,
      '/referral',
      { telegram: true },
    )
  } catch {
    // Unique(orderId) — already accrued (e.g. retried delivery finalisation). Ignore.
  }
}

export interface ReferralSummary {
  enabled: boolean
  code: string | null
  label: string | null
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
    return { enabled: false, code: null, label: null, referralPct: null, referredCount: 0, totalAccruedUsdt: 0, availableUsdt: 0, withdrawableUsdt: 0, withdrawnUsdt: 0, minWithdrawUsdt: 0, kycOk: false, boundToReferrer: false }
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
    label: own.label,
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
