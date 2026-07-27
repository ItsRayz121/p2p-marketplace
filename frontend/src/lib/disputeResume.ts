// Frontend mirror of backend/src/services/disputeResume.ts — keep in sync.
//
// An open dispute parks a trade's `status` at `disputed` so every admin list and
// status badge keeps working, while `disputeResumeStatus` carries the REAL ladder
// rung. Feeding the ladder the real rung is what keeps the step cards alive during
// a dispute, so the parties can still finish the trade themselves.
//
// The dispute closes ONLY when the trade actually completes — the counterparty
// confirming receipt is evidence; the accused merely clicking "sent" is not.

export interface ResumableTrade {
  status: string
  disputeResumeStatus?: string | null
}

/** The rung the trade is really on. Identical to `status` when not disputed. */
export function ladderStatus(trade: ResumableTrade): string {
  return trade.status === 'disputed' && trade.disputeResumeStatus
    ? trade.disputeResumeStatus
    : trade.status
}

/** True when the step ladder should stay live despite an open dispute. */
export function isResumingUnderDispute(trade: ResumableTrade): boolean {
  return trade.status === 'disputed' && !!trade.disputeResumeStatus
}

/**
 * Whether the parties may still settle this themselves.
 *
 * `disputeResumeStatus != null` IS the signal — the backend clears it the moment an
 * admin takes the case over (posts in the dispute thread, or the 48h escalation
 * fires), so a human ruling can never race a party settlement. The optional dispute
 * argument is a second, stricter check where the caller has the record to hand.
 */
export function canPartiesStillSettle(
  trade: ResumableTrade,
  dispute?: { status?: string } | null,
): boolean {
  if (!isResumingUnderDispute(trade)) return false
  // 'escalated' is a 48h TIMEOUT flag, not an admin takeover — settlement stays open.
  return !dispute?.status || dispute.status === 'open' || dispute.status === 'escalated'
}
