/**
 * Gas-Payment KOL free codes — self-serve, instant, 100%-free discount engine.
 *
 * Unlike a promo code (gas.promo.ts), which may only ever discount the platform
 * MARGIN, a free code waives the ENTIRE order cost (base gas + margin) — the
 * platform genuinely pays for the gas, the same way an admin free-grant does
 * (see issueFreeGasOrder in gasFee.routes.ts). Each redemption gives a FIXED
 * native gas amount (e.g. 0.00001 BNB) set once by the admin — the user does not
 * choose the amount. It exists to let a KOL hand out a code where the first N
 * people to apply it each get that fixed amount for free, restricted to one
 * specific token/chain, capped by BOTH a slot count and a lifetime USDT budget —
 * whichever is hit first auto-disables the code so later applicants see it as
 * ended and fall back to a normal (margin-only) promo code.
 *
 * Two hard anti-abuse rules, enforced server-side regardless of what the client
 * sends: (1) must be logged in — guests can never redeem; (2) only available on
 * a user's first-ever gas order, of any kind — once they have ANY prior GasFeeOrder
 * row, every future redemption attempt is rejected. The checkout UI hides the
 * code box entirely once a user is no longer eligible (see /gas-fee/chains
 * freeCodeEnabled), but this module is the actual enforcement.
 *
 * Concurrency mirrors gas.promo.ts exactly: reservation advances redeemedCount
 * and spentUsdt atomically using an optimistic-lock updateMany guarded on the
 * exact redeemedCount we read, so concurrent redeemers can never share a slot or
 * overspend the budget. On contention we re-read and retry. The reserve → create
 * order → record redemption sequence is compensating: if the order fails to
 * persist after a successful reserve, releaseReservation() rolls the counters
 * back. Reservation only happens when flag gas_free_code_enabled is ON.
 */
import { db } from '../prisma'
import type { Prisma } from '@prisma/client'
import { AppError } from '../errors'
import { logger } from '../logger'
import { isFlagEnabled, FLAGS } from '../../services/platformFlags.service'

export interface FreeCodeResolution {
  freeCodeId: string
  code: string
  amountNative: number // fixed gas amount given (native units, e.g. BNB)
  amountUsdt: number    // full order cost waived (base + margin), in USD
}

export interface FreeCodePreview {
  valid: boolean
  code: string
  kolLabel: string
  gasTokenConfigId: string
  amountNative: number
  amountUsdt: number
  slotsLeft: number
  budgetLeftUsdt: number
  message: string
}

const MAX_RESERVE_ATTEMPTS = 6

/** Codes are stored and compared in a normalized UPPERCASE, trimmed form. */
export function normalizeFreeCode(code: string): string {
  return code.trim().toUpperCase()
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

type FreeCodeRow = {
  id: string
  code: string
  kolLabel: string
  gasTokenConfigId: string
  amountNative: Prisma.Decimal
  slotLimit: number
  redeemedCount: number
  budgetUsdt: number
  spentUsdt: number
  perUserLimit: number
  expiresAt: Date | null
  isActive: boolean
}

/** Reasons a code can't be applied — mapped to user-facing messages. */
function validateApplicable(row: FreeCodeRow | null, tokenConfigId: string): asserts row is FreeCodeRow {
  if (!row) {
    throw new AppError('FREE_CODE_INVALID', 'This code is not valid.', 400)
  }
  if (row.gasTokenConfigId !== tokenConfigId) {
    throw new AppError('FREE_CODE_WRONG_TOKEN', `Code ${row.code} is only valid for a specific network/token — switch to redeem it.`, 400)
  }
  if (!row.isActive) {
    throw new AppError('FREE_CODE_ENDED', 'This giveaway has ended.', 400)
  }
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
    throw new AppError('FREE_CODE_ENDED', 'This giveaway has ended.', 400)
  }
  if (row.redeemedCount >= row.slotLimit || row.spentUsdt >= row.budgetUsdt) {
    throw new AppError('FREE_CODE_ENDED', 'This giveaway has ended.', 400)
  }
}

/**
 * Hard eligibility gate: must be logged in, and this must be the user's first
 * gas order EVER (any chain, any payment method, any status). Throws a clear
 * AppError otherwise. Shared by the preview and reserve paths so neither can be
 * bypassed by skipping straight to order creation.
 */
export async function assertFreeCodeEligible(userId: string | null): Promise<void> {
  if (!userId) {
    throw new AppError('FREE_CODE_LOGIN_REQUIRED', 'Log in to redeem this code.', 401)
  }
  const priorOrders = await db.gasFeeOrder.count({ where: { userId } })
  if (priorOrders > 0) {
    throw new AppError('FREE_CODE_NOT_FIRST_ORDER', 'This code is only available on your first gas order.', 400)
  }
}

async function countUserRedemptions(freeCodeId: string, identity: string): Promise<number> {
  return db.gasFreeCodeRedemption.count({ where: { freeCodeId, identity } })
}

/**
 * Read-only preview: validate a code against the selected token and report the
 * fixed amount + slots/budget left for the checkout UI, WITHOUT consuming a
 * slot. Throws AppError with a clear message when the code can't be applied so
 * the FE can surface it inline (and fall back to a normal promo code).
 */
export async function previewFreeCode(args: {
  code: string
  gasTokenConfigId: string
  nativeUsdRate: number
  platformFeeUsdt: number
  userId: string | null
  identity: string
}): Promise<FreeCodePreview> {
  if (!(await isFlagEnabled(FLAGS.GAS_FREE_CODE))) {
    throw new AppError('FREE_CODE_DISABLED', 'Free-gas codes are not available right now.', 400)
  }
  await assertFreeCodeEligible(args.userId)

  const code = normalizeFreeCode(args.code)
  const row = await db.gasFreeCode.findUnique({ where: { code } })
  validateApplicable(row, args.gasTokenConfigId)

  const used = await countUserRedemptions(row.id, args.identity)
  if (used >= row.perUserLimit) {
    throw new AppError('FREE_CODE_LIMIT', 'You have already used this code.', 400)
  }

  const amountNative = Number(row.amountNative)
  const amountUsdt = round2(amountNative * args.nativeUsdRate + args.platformFeeUsdt)

  return {
    valid: true,
    code: row.code,
    kolLabel: row.kolLabel,
    gasTokenConfigId: row.gasTokenConfigId,
    amountNative,
    amountUsdt,
    slotsLeft: row.slotLimit - row.redeemedCount,
    budgetLeftUsdt: round2(row.budgetUsdt - row.spentUsdt),
    message: `Code ${row.code} applied — you'll receive ${amountNative} free`,
  }
}

/**
 * Atomically reserve a slot + budget for this code and return the resolved
 * waiver (including the fixed native amount to actually deliver). MUST be
 * paired with recordRedemption() (after the order is created) and
 * releaseReservation() (if order creation fails). Only call when the flag is ON.
 */
export async function reserveFreeCode(args: {
  code: string
  gasTokenConfigId: string
  nativeUsdRate: number
  platformFeeUsdt: number
  userId: string | null
  identity: string
}): Promise<FreeCodeResolution> {
  await assertFreeCodeEligible(args.userId)
  const code = normalizeFreeCode(args.code)

  for (let attempt = 0; attempt < MAX_RESERVE_ATTEMPTS; attempt++) {
    const row = await db.gasFreeCode.findUnique({ where: { code } })
    validateApplicable(row, args.gasTokenConfigId)

    const used = await countUserRedemptions(row.id, args.identity)
    if (used >= row.perUserLimit) {
      throw new AppError('FREE_CODE_LIMIT', 'You have already used this code.', 400)
    }

    const amountNative = Number(row.amountNative)
    const orderCost = round2(amountNative * args.nativeUsdRate + args.platformFeeUsdt)
    if (row.spentUsdt + orderCost > row.budgetUsdt) {
      throw new AppError('FREE_CODE_ENDED', 'This giveaway has ended.', 400)
    }

    // Optimistic lock: only succeeds if no other redemption advanced the counter
    // since we read it, AND the budget still covers this order at write time.
    // isActive stays a pure admin kill switch — exhaustion ("giveaway ended") is
    // detected purely from redeemedCount/spentUsdt vs slotLimit/budgetUsdt in
    // validateApplicable, so a release (below) never has to un-exhaust anything.
    const reserved = await db.gasFreeCode.updateMany({
      where: {
        id: row.id,
        isActive: true,
        redeemedCount: row.redeemedCount,
        spentUsdt: { lte: row.budgetUsdt - orderCost },
      },
      data: {
        redeemedCount: { increment: 1 },
        spentUsdt: { increment: orderCost },
      },
    })

    if (reserved.count === 1) {
      return { freeCodeId: row.id, code: row.code, amountNative, amountUsdt: orderCost }
    }
    // Contention — another redemption landed first; re-read and recompute.
  }

  logger.warn({ code }, 'gas free-code reservation exhausted retries under contention')
  throw new AppError('FREE_CODE_BUSY', 'This code is in high demand. Please try again.', 409)
}

/** Persist the redemption row that ties an order to the reserved waiver. */
export async function recordFreeCodeRedemption(args: {
  resolution: FreeCodeResolution
  orderId: string
  identity: string
  userId: string | null
}): Promise<void> {
  await db.gasFreeCodeRedemption.create({
    data: {
      freeCodeId: args.resolution.freeCodeId,
      identity: args.identity,
      userId: args.userId,
      orderId: args.orderId,
      amountUsdt: args.resolution.amountUsdt,
    },
  })
}

/** Roll back a reservation when the order it was for could not be created. */
export async function releaseFreeCodeReservation(resolution: FreeCodeResolution): Promise<void> {
  try {
    await db.gasFreeCode.update({
      where: { id: resolution.freeCodeId },
      data: {
        redeemedCount: { decrement: 1 },
        spentUsdt: { decrement: resolution.amountUsdt },
      },
    })
  } catch (err) {
    // Best-effort compensation; a stuck reservation only over-counts spend slightly.
    logger.error({ err, freeCodeId: resolution.freeCodeId }, 'failed to release gas free-code reservation')
  }
}

/**
 * Identity string for per-user limits + redemption attribution. Mirrors the
 * promo/cancellation identity convention: authenticated → user:<id>, guest → ip:<addr>.
 * Free codes always require login (see assertFreeCodeEligible), so this will
 * always resolve to the user:<id> form in practice.
 */
export function freeCodeIdentity(userId: string | null, ip: string | undefined): string {
  return userId ? `user:${userId}` : `ip:${ip ?? 'unknown'}`
}

/**
 * Whether the CALLER (identified by userId) is even a candidate for a free code
 * right now — flag ON, logged in, and no prior gas order. Used by /gas-fee/chains
 * to decide whether to show the code box on the checkout screen at all, so it
 * genuinely "never appears again" after a user's first order. Never throws.
 */
export async function isFreeCodeEligibleForUser(userId: string | null): Promise<boolean> {
  if (!(await isFlagEnabled(FLAGS.GAS_FREE_CODE))) return false
  if (!userId) return false
  const priorOrders = await db.gasFeeOrder.count({ where: { userId } })
  return priorOrders === 0
}
