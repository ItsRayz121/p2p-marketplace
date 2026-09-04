/**
 * Dispute-resume — let both parties keep settling a trade while a dispute is open.
 *
 * WHY: `status` is a single enum column, so opening a dispute used to OVERWRITE the
 * trade's ladder rung with `disputed`. Every transition endpoint gates on
 * `status === step.from`, so nothing could ever match again and the whole step
 * ladder went dead. That froze the honest-but-slow case (a maker asleep in another
 * timezone, auto-escalated by `confirmDeadlineAt`) just as hard as an actual scam,
 * while doing nothing at all to a scammer who was never going to click anything.
 *
 * THE MODEL. While a dispute is open:
 *   - `status`              stays parked at `disputed` — the outward state. Every
 *                           admin list, filter, dashboard, badge and concurrency
 *                           check that reads `status === 'disputed'` is untouched.
 *   - `disputeResumeStatus` carries the REAL ladder rung, and ADVANCES as the
 *                           parties act.
 *
 * THE SECURITY INVARIANT — the whole reason this is safe:
 *
 *   The dispute does NOT lift when the accused acts. It lifts only when the trade
 *   reaches its terminal status.
 *
 * "Send tokens" / "upload proof" are self-claims with an attached screenshot; they
 * are not verified receipt. If they closed the dispute, the accused could clear his
 * own record by uploading anything. Only the COUNTERPARTY confirming receipt — which
 * is what completes the trade — is real evidence, so that is the only thing that
 * closes the case, as `settled_by_parties` (no winner, no fault, no bond seizure, no
 * points clawback — but the dispute row survives forever on both parties' history).
 *
 * ADMIN OVERRIDE ALWAYS WINS. Resume is allowed only while the dispute is still
 * `open`. The moment an admin picks the case up (under_review / escalated /
 * awaiting_evidence) or resolves it, the ladder re-freezes — otherwise an admin
 * ruling and a party settlement could both land and pay out twice.
 */

import { AppError } from '../lib/errors'
import type { Prisma } from '@prisma/client'

type Tx = Prisma.TransactionClient

/** Minimal shape both markets satisfy. */
export interface ResumableTrade {
  status: string
  disputeResumeStatus?: string | null
}

/**
 * Dispute states in which the parties may still settle the trade themselves.
 *
 * `escalated` is included deliberately: it is set by a 48h TIMEOUT job, which fires
 * precisely because no admin has looked at the case. Freezing there would leave the
 * trade both neglected and unfinishable — the worst of both. What freezes the ladder
 * is real admin ENGAGEMENT (an admin posting in the dispute thread), which clears
 * disputeResumeStatus outright, and a ruling, which sets `resolved`.
 */
export const PARTY_SETTLEABLE_DISPUTE_STATUSES = ['open', 'escalated'] as const

/**
 * The rung this trade is REALLY on. Identical to `status` for every trade that
 * isn't disputed, so all existing behaviour is byte-identical.
 */
export function ladderStatus(trade: ResumableTrade): string {
  return trade.status === 'disputed' && trade.disputeResumeStatus
    ? trade.disputeResumeStatus
    : trade.status
}

/** True when this trade is advancing under an open dispute. */
export function isResumingUnderDispute(trade: ResumableTrade): boolean {
  return trade.status === 'disputed' && !!trade.disputeResumeStatus
}

/**
 * The `data` patch that moves a trade to ladder rung `to`.
 *
 * Normal trade  → `{ status: to }` (unchanged).
 * Under dispute → `status` stays `disputed` and the rung advances instead, so the
 *                 trade is still a live dispute for admin tooling. `terminal: true`
 *                 is the one exception: completing genuinely leaves `disputed`.
 */
export function advanceTo<T extends string>(
  trade: ResumableTrade,
  to: T,
  opts?: { terminal?: boolean },
): { status: T | 'disputed'; disputeResumeStatus?: T | null } {
  if (!isResumingUnderDispute(trade)) return { status: to }
  if (opts?.terminal) return { status: to, disputeResumeStatus: null }
  return { status: 'disputed', disputeResumeStatus: to }
}

/**
 * The CAS `where` clause that claims rung `from`. Mirrors `advanceTo` so an
 * optimistic update can never apply twice, disputed or not.
 */
export function claimRung<T extends string>(
  trade: ResumableTrade,
  from: T,
): { status: T | 'disputed'; disputeResumeStatus?: T } {
  if (!isResumingUnderDispute(trade)) return { status: from }
  return { status: 'disputed', disputeResumeStatus: from }
}

/**
 * Gate a forward action on a disputed trade. No-op for undisputed trades.
 *
 * Blocks the moment an admin has taken the case, so a human ruling can never race
 * a party settlement.
 */
export function assertPartySettleable(
  trade: ResumableTrade,
  dispute: { status: string } | null | undefined,
): void {
  if (trade.status !== 'disputed') return
  if (!trade.disputeResumeStatus) {
    // Legacy disputed trade opened before this feature — its rung was lost, so
    // there is nothing to resume. Admin resolution is the only way out.
    throw new AppError(
      'DISPUTE_FROZEN',
      'This trade is under dispute review and cannot be advanced. An admin will resolve it.',
      409,
    )
  }
  if (!dispute || !(PARTY_SETTLEABLE_DISPUTE_STATUSES as readonly string[]).includes(dispute.status)) {
    throw new AppError(
      'DISPUTE_UNDER_ADMIN_REVIEW',
      'An admin has taken over this dispute, so the trade is locked until they rule on it. Please reply in the dispute thread.',
      409,
    )
  }
}

/**
 * Hand a trade back to its parties after a NO-FAULT close (an admin dismissal, or
 * the USDT "close without winner"). Returns the `data` patch for the trade row.
 *
 * A no-fault close says "there was no real problem here" — so the trade must go
 * back to being a normal, finishable trade. Without this it stays parked at
 * `disputed` with its dispute already resolved, which is a dead end: the ladder is
 * frozen (assertPartySettleable rejects a non-open dispute) and there is no ruling
 * to act on either. The trade could never be completed OR closed.
 *
 * This function only returns `{ status, disputeResumeStatus: null }` — it does NOT
 * touch any deadline field. Every call site MUST re-arm a FRESH deadline for the
 * resumed rung on top of this patch (ctm.trade.service.ts's ctmResumeDeadline /
 * trade.service.ts's usdtResumeDeadline) — never leave it null. The original
 * deadline is long past, so nulling it outright (the old behavior here) leaves the
 * resumed rung with no deadline at all forever if the same party goes dark again,
 * and no sweep can ever re-pick it up. A FRESH window still avoids the escalation
 * job immediately re-disputing a trade whose dispute was just deliberately
 * dismissed — it only fires again if the party genuinely stalls a second time.
 *
 * Legacy fallback — a trade disputed before dispute-resume shipped has no recorded
 * rung, so there is nothing to hand back. Those go terminal (`dispute_resolved`)
 * instead, which is at least honest, rather than sitting in `disputed` forever.
 */
export function restoreAfterNoFaultClose<S extends string>(
  trade: { status: string; disputeResumeStatus?: S | null } | null | undefined,
  legacyTerminalStatus: S,
): { status: S; disputeResumeStatus: null } {
  const rung = trade && trade.status === 'disputed' ? trade.disputeResumeStatus : null
  return { status: rung ?? legacyTerminalStatus, disputeResumeStatus: null }
}

/**
 * Close an open dispute because the parties finished the trade themselves.
 *
 * MUST be called inside the same transaction that completes the trade — the
 * `status: 'open'` filter is the CAS that makes an admin resolution and a party
 * settlement mutually exclusive. Records a no-fault resolution: no winner, no bond
 * seizure, no points clawback. The row itself is never deleted — a party-settled
 * dispute still counts as "this trade was escalated" on both parties' history.
 *
 * Returns true when a dispute was actually closed.
 */
export async function settleDisputeOnCompletion(
  tx: Tx,
  market: 'usdt' | 'ctm',
  tradeId: string,
): Promise<boolean> {
  const data = {
    status: 'resolved' as const,
    resolutionType: 'settled_by_parties' as const,
    resolution:
      'Settled directly by the parties — both legs were delivered and confirmed after the dispute was opened, so the trade completed on its own. No admin ruling; no fault assigned to either side.',
    resolvedAt: new Date(),
  }
  const res =
    market === 'usdt'
      ? await tx.dispute.updateMany({ where: { tradeId, status: 'open' }, data })
      : await tx.ctmDispute.updateMany({ where: { tradeId, status: 'open' }, data })
  return res.count > 0
}
