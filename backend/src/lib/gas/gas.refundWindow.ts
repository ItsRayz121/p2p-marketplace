// Interactive refund-window timing for delivery-failed gas orders.
//
// When delivery exhausts its initial attempts on a PAID order we no longer refund
// instantly. Instead the order enters `awaiting_refund`:
//   • for REFUND_WINDOW_MS we keep retrying delivery (e.g. a flaky TON RPC may
//     recover) and the UI shows a countdown — no refund yet;
//   • once REFUND_WINDOW_MS elapses the user may tap "Request Refund" for an
//     immediate refund;
//   • if the user never does, an automatic safety-net refund fires at
//     AUTO_REFUND_SAFETY_MS so funds are never left stuck.
//
// These are deliberately centralised so the job, the route, and any future
// surface agree on the exact same gates.

/** How long after a delivery failure before the user may request a refund. */
export const REFUND_WINDOW_MS = 5 * 60_000 // 5 minutes

/** Safety-net: auto-refund a still-unclaimed awaiting_refund order at this age. */
export const AUTO_REFUND_SAFETY_MS = 10 * 60_000 // 10 minutes (≈5 min manual window)

/** Spacing between background delivery retries during the window. */
export const RETRY_INTERVAL_MS = 60_000 // every minute

/** True once the order has sat in awaiting_refund long enough to be refundable. */
export function isRefundEligible(refundEligibleAt: Date | null | undefined, now = Date.now()): boolean {
  if (!refundEligibleAt) return false
  return now >= new Date(refundEligibleAt).getTime()
}

/** Milliseconds remaining until the refund button unlocks (0 if already eligible). */
export function refundWaitRemainingMs(refundEligibleAt: Date | null | undefined, now = Date.now()): number {
  if (!refundEligibleAt) return REFUND_WINDOW_MS
  return Math.max(0, new Date(refundEligibleAt).getTime() - now)
}
