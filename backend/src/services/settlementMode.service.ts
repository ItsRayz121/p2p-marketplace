import { FLAGS, isFlagEnabled } from './platformFlags.service'

/**
 * Settlement ordering & (future) custodial-escrow seam.
 *
 * The platform is NON-CUSTODIAL today — it never holds user funds; protection
 * comes from KYC + identity + reputation + dispute. What this module governs is
 * the ORDER in which the two parties move, not custody.
 *
 * Two concepts live here so the rest of the codebase has one place to ask:
 *
 *  1. Settlement ORDER (live) — who transfers first. Controlled by the
 *     `taker_first_settlement_enabled` flag. See getSettlementOrder().
 *
 *  2. Settlement MODE (scaffold) — 'trust' vs 'escrow'. Today the platform is
 *     always 'trust' (no custody). The 'escrow' interface below is intentionally
 *     UNIMPLEMENTED — it documents the seam a future custodial build would fill,
 *     and keeps that future reversible without a refactor. Nothing calls it yet.
 */

// ── Settlement order (live) ────────────────────────────────────────────────

/**
 * Who moves first in a trade.
 *  - 'taker_first': the party responding to the ad transfers their leg first;
 *    the ad owner (merchant) moves second. (New behavior, flag ON.)
 *  - 'per_side'   : legacy per-side order — on a buy ad the merchant/buyer pays
 *    fiat first. (Current behavior, flag OFF / default.)
 */
export type SettlementOrder = 'taker_first' | 'per_side'

/** Resolve the active settlement order from the flag. Cheap (flag is cached). */
export async function getSettlementOrder(): Promise<SettlementOrder> {
  return (await isFlagEnabled(FLAGS.TAKER_FIRST_SETTLEMENT)) ? 'taker_first' : 'per_side'
}

/** Convenience: true when taker-sends-first ordering is active. */
export async function isTakerFirst(): Promise<boolean> {
  return (await getSettlementOrder()) === 'taker_first'
}

// ── Settlement mode (scaffold — NOT wired to anything) ──────────────────────

export type SettlementMode = 'trust' | 'escrow'

/**
 * Always 'trust' today. Kept as a function (not a constant) so a future
 * custodial build can gate it on a flag without touching call sites.
 */
export async function getSettlementMode(): Promise<SettlementMode> {
  return 'trust'
}

/**
 * Future custodial-escrow interface. Intentionally UNIMPLEMENTED — this is the
 * seam a later phase would fill to hold funds on-platform. Left here so the
 * escrow path is a drop-in, not a refactor, if the trust model ever needs it.
 * DO NOT call these; they throw by design until deliberately built.
 */
export interface EscrowProvider {
  /** Lock the maker's crypto leg into platform custody at trade open. */
  lock(tradeRef: string, amount: string, asset: string): Promise<void>
  /** Release custodied crypto to the buyer on completion. */
  release(tradeRef: string): Promise<void>
  /** Return custodied crypto to the maker on cancel/expiry. */
  refund(tradeRef: string): Promise<void>
  /** Move custodied crypto per an admin dispute ruling. */
  settleDispute(tradeRef: string, winner: 'buyer' | 'seller'): Promise<void>
}

const NOT_BUILT = 'Custodial escrow is not implemented — platform is non-custodial (trust mode).'

/** Placeholder provider; every method throws until a custodial build lands. */
export const unimplementedEscrow: EscrowProvider = {
  async lock() { throw new Error(NOT_BUILT) },
  async release() { throw new Error(NOT_BUILT) },
  async refund() { throw new Error(NOT_BUILT) },
  async settleDispute() { throw new Error(NOT_BUILT) },
}
