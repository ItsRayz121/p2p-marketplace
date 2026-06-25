/**
 * Gas-Payment promo codes — margin-only discount engine.
 *
 * INVARIANT: a promo discount may only ever draw from the platform MARGIN of a
 * gas order, never the base gas cost. discount = min(pct% × margin, margin), so
 * even a 100%-of-margin code leaves the user paying the base cost — never a loss
 * and never a subsidy of real gas. Free-gas-that-covers-base is a SEPARATE
 * admin-grant tool (Phase 3), not a promo code.
 *
 * Concurrency: a code carries ordered redemption tiers (first N → high %, then a
 * default %) plus a lifetime margin budget. Reservation advances totalRedemptions
 * and marginSpentUsdt atomically using an optimistic-lock updateMany guarded on the
 * exact totalRedemptions we read — so concurrent redeemers can never share a slot
 * or overspend the budget. On contention we re-read and retry.
 *
 * The reserve → create order → record redemption sequence is compensating: if the
 * order fails to persist after a successful reserve, releaseReservation() rolls the
 * counters back. Reservation only happens when flag gas_promo_enabled is ON; with
 * the flag OFF this module is never invoked and gas orders behave exactly as today.
 */
import { db } from '../prisma'
import { AppError } from '../errors'
import { logger } from '../logger'
import { isFlagEnabled, FLAGS } from '../../services/platformFlags.service'

export interface PromoTier {
  maxRedemptions: number
  discountPct: number
}

export interface PromoResolution {
  promoCodeId: string
  code: string
  discountUsdt: number
  marginUsdt: number
  discountPct: number
  tierIndex: number // -1 = default tier
}

export interface PromoPreview {
  valid: boolean
  code: string
  discountUsdt: number
  discountPct: number
  /** Remaining high-discount slots in the CURRENT active tier; null when on the default tier. */
  slotsLeft: number | null
  message: string
}

const MAX_RESERVE_ATTEMPTS = 6

/** Codes are stored and compared in a normalized UPPERCASE, trimmed form. */
export function normalizeCode(code: string): string {
  return code.trim().toUpperCase()
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Parse + sanity-check the JSON tiers column into a typed, ordered list. */
function parseTiers(raw: unknown): PromoTier[] {
  if (!Array.isArray(raw)) return []
  const out: PromoTier[] = []
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue
    const maxRedemptions = Number((t as Record<string, unknown>).maxRedemptions)
    const discountPct = Number((t as Record<string, unknown>).discountPct)
    if (!Number.isFinite(maxRedemptions) || maxRedemptions <= 0) continue
    if (!Number.isFinite(discountPct) || discountPct < 0) continue
    out.push({ maxRedemptions: Math.floor(maxRedemptions), discountPct: Math.min(100, discountPct) })
  }
  return out
}

/**
 * Given how many redemptions have already happened, find the tier the NEXT
 * redemption falls into. Returns the discount % and slot index, plus how many
 * slots remain in that active tier (null once past all tiers / on the default).
 */
function resolveTierForSlot(tiers: PromoTier[], usedRedemptions: number): {
  discountPct: number
  tierIndex: number
  slotsLeft: number | null
} {
  let cumulative = 0
  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i]!
    const tierEnd = cumulative + tier.maxRedemptions
    if (usedRedemptions < tierEnd) {
      return { discountPct: tier.discountPct, tierIndex: i, slotsLeft: tierEnd - usedRedemptions }
    }
    cumulative = tierEnd
  }
  return { discountPct: 0, tierIndex: -1, slotsLeft: null } // default tier — filled in by caller
}

type PromoCodeRow = {
  id: string
  code: string
  tiers: unknown
  defaultDiscountPct: number
  marginBudgetUsdt: number
  marginSpentUsdt: number
  totalRedemptions: number
  perUserLimit: number
  minOrderUsd: number
  expiresAt: Date | null
  isActive: boolean
}

/** Compute the discount for a code in its current state, without reserving anything. */
function computeDiscount(
  row: PromoCodeRow,
  marginUsdt: number,
): { discountUsdt: number; discountPct: number; tierIndex: number; slotsLeft: number | null } {
  const tiers = parseTiers(row.tiers)
  const tier = resolveTierForSlot(tiers, row.totalRedemptions)
  const discountPct = tier.tierIndex === -1 ? row.defaultDiscountPct : tier.discountPct
  // Floor at margin, never below 0. Round to 2dp to match the user-paid amount.
  const rawDiscount = round2((discountPct / 100) * marginUsdt)
  const discountUsdt = Math.max(0, Math.min(rawDiscount, round2(marginUsdt)))
  return { discountUsdt, discountPct, tierIndex: tier.tierIndex, slotsLeft: tier.slotsLeft }
}

/** Reasons a code can't be applied — mapped to user-facing messages. */
function validateApplicable(row: PromoCodeRow | null, orderUsd: number): asserts row is PromoCodeRow {
  if (!row || !row.isActive) {
    throw new AppError('PROMO_INVALID', 'This promo code is not valid.', 400)
  }
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
    throw new AppError('PROMO_EXPIRED', 'This promo code has expired.', 400)
  }
  if (orderUsd < row.minOrderUsd) {
    throw new AppError('PROMO_MIN_ORDER', `This code requires a minimum order of $${row.minOrderUsd.toFixed(2)}.`, 400)
  }
  if (row.marginSpentUsdt >= row.marginBudgetUsdt) {
    throw new AppError('PROMO_EXHAUSTED', 'This promo code has been fully redeemed.', 400)
  }
}

async function countUserRedemptions(promoCodeId: string, identity: string): Promise<number> {
  return db.gasPromoRedemption.count({ where: { promoCodeId, identity } })
}

/**
 * Read-only preview: validate a code and report the discount + slots-left for the
 * payment page, WITHOUT consuming a slot. Throws AppError with a clear message when
 * the code can't be applied so the FE can surface it inline.
 */
export async function previewPromo(args: {
  code: string
  orderUsd: number
  marginUsdt: number
  identity: string
}): Promise<PromoPreview> {
  if (!(await isFlagEnabled(FLAGS.GAS_PROMO))) {
    throw new AppError('PROMO_DISABLED', 'Promo codes are not available right now.', 400)
  }
  const code = normalizeCode(args.code)
  const row = await db.gasPromoCode.findUnique({ where: { code } })
  validateApplicable(row, args.orderUsd)

  const used = await countUserRedemptions(row.id, args.identity)
  if (used >= row.perUserLimit) {
    throw new AppError('PROMO_LIMIT', 'You have already used this promo code.', 400)
  }

  const { discountUsdt, discountPct, slotsLeft } = computeDiscount(row, args.marginUsdt)
  if (discountUsdt <= 0) {
    throw new AppError('PROMO_NO_BENEFIT', 'This promo code has no discount left to give.', 400)
  }
  // Re-check budget against the concrete discount this order would consume.
  if (row.marginSpentUsdt + discountUsdt > row.marginBudgetUsdt) {
    throw new AppError('PROMO_EXHAUSTED', 'This promo code has been fully redeemed.', 400)
  }

  return {
    valid: true,
    code: row.code,
    discountUsdt,
    discountPct,
    slotsLeft,
    message: `Code ${row.code} applied — ${discountPct}% off the platform fee`,
  }
}

/**
 * Atomically reserve a slot + budget for this code and return the resolved discount.
 * MUST be paired with recordRedemption() (after the order is created) and
 * releaseReservation() (if order creation fails). Only call when the flag is ON.
 */
export async function reservePromo(args: {
  code: string
  orderUsd: number
  marginUsdt: number
  identity: string
}): Promise<PromoResolution> {
  const code = normalizeCode(args.code)

  for (let attempt = 0; attempt < MAX_RESERVE_ATTEMPTS; attempt++) {
    const row = await db.gasPromoCode.findUnique({ where: { code } })
    validateApplicable(row, args.orderUsd)

    const used = await countUserRedemptions(row.id, args.identity)
    if (used >= row.perUserLimit) {
      throw new AppError('PROMO_LIMIT', 'You have already used this promo code.', 400)
    }

    const { discountUsdt, discountPct, tierIndex } = computeDiscount(row, args.marginUsdt)
    if (discountUsdt <= 0) {
      throw new AppError('PROMO_NO_BENEFIT', 'This promo code has no discount left to give.', 400)
    }
    if (row.marginSpentUsdt + discountUsdt > row.marginBudgetUsdt) {
      throw new AppError('PROMO_EXHAUSTED', 'This promo code has been fully redeemed.', 400)
    }

    // Optimistic lock: only succeeds if no other redemption advanced the counter
    // since we read it, AND the budget still covers this discount at write time.
    const reserved = await db.gasPromoCode.updateMany({
      where: {
        id: row.id,
        isActive: true,
        totalRedemptions: row.totalRedemptions,
        marginSpentUsdt: { lte: row.marginBudgetUsdt - discountUsdt },
      },
      data: {
        totalRedemptions: { increment: 1 },
        marginSpentUsdt: { increment: discountUsdt },
      },
    })

    if (reserved.count === 1) {
      return {
        promoCodeId: row.id,
        code: row.code,
        discountUsdt,
        marginUsdt: round2(args.marginUsdt),
        discountPct,
        tierIndex,
      }
    }
    // Contention — another redemption landed first; re-read and recompute.
  }

  logger.warn({ code }, 'gas promo reservation exhausted retries under contention')
  throw new AppError('PROMO_BUSY', 'This promo code is in high demand. Please try again.', 409)
}

/** Persist the redemption row that ties an order to the reserved discount. */
export async function recordRedemption(args: {
  resolution: PromoResolution
  orderId: string
  identity: string
  userId: string | null
}): Promise<void> {
  await db.gasPromoRedemption.create({
    data: {
      promoCodeId: args.resolution.promoCodeId,
      identity: args.identity,
      userId: args.userId,
      orderId: args.orderId,
      discountUsdt: args.resolution.discountUsdt,
      marginUsdt: args.resolution.marginUsdt,
      tierIndex: args.resolution.tierIndex,
    },
  })
}

/** Roll back a reservation when the order it was for could not be created. */
export async function releaseReservation(resolution: PromoResolution): Promise<void> {
  try {
    await db.gasPromoCode.update({
      where: { id: resolution.promoCodeId },
      data: {
        totalRedemptions: { decrement: 1 },
        marginSpentUsdt: { decrement: resolution.discountUsdt },
      },
    })
  } catch (err) {
    // Best-effort compensation; a stuck reservation only over-counts spend slightly.
    logger.error({ err, promoCodeId: resolution.promoCodeId }, 'failed to release gas promo reservation')
  }
}

/**
 * Identity string for per-user limits + redemption attribution. Mirrors the gas
 * cancellation identity convention: authenticated → user:<id>, guest → ip:<addr>.
 */
export function promoIdentity(userId: string | null, ip: string | undefined): string {
  return userId ? `user:${userId}` : `ip:${ip ?? 'unknown'}`
}

/**
 * Release the promo reservation tied to an order that was abandoned (expired unpaid).
 * Reverses exactly what reservePromo()/recordRedemption() consumed — the tier slot,
 * the spent-budget, and the redemption row — so the slot/budget free up and the user
 * isn't permanently blocked by perUserLimit after never paying. Idempotent: once the
 * redemption row is gone, subsequent calls no-op.
 *
 * Guard: only releases when the order has genuinely reached 'expired', so a payment
 * that lands in the same instant (status moved to payment_detected) keeps its discount.
 */
export async function releasePromoForExpiredOrder(orderId: string): Promise<void> {
  try {
    const order = await db.gasFeeOrder.findUnique({ where: { id: orderId }, select: { status: true } })
    if (!order || order.status !== 'expired') return

    const redemption = await db.gasPromoRedemption.findUnique({
      where: { orderId },
      select: { id: true, promoCodeId: true, discountUsdt: true },
    })
    if (!redemption) return
    const discount = Number(redemption.discountUsdt)

    await db.$transaction([
      db.gasPromoCode.update({
        where: { id: redemption.promoCodeId },
        data: {
          totalRedemptions: { decrement: 1 },
          marginSpentUsdt: { decrement: discount },
        },
      }),
      db.gasPromoRedemption.delete({ where: { id: redemption.id } }),
    ])
    logger.info({ orderId, promoCodeId: redemption.promoCodeId, discount }, 'released promo reservation for expired gas order')
  } catch (err) {
    // Best-effort: a stuck reservation only slightly over-counts spend until the next pass.
    logger.error({ err, orderId }, 'failed to release promo reservation for expired gas order')
  }
}
