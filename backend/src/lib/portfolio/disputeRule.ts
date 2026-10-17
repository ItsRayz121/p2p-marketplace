/**
 * What a dispute means for a trade's place in the portfolio.
 *
 * - No dispute, or one closed with NO fault (settled by the parties, or dismissed): nothing special. The trade counts
 *   only if it ends in its own completed state, which the importers check.
 * - OPEN dispute (not yet resolved): the trade is kept out. It is added automatically once the dispute is resolved.
 * - Resolved by an admin ruling:
 *     buyer_wins  -> the exchange stands: the trade is added, dated when the dispute was resolved;
 *     seller_wins -> nothing was exchanged: nothing is added;
 *     split       -> the platform does not record the agreed amounts, so it cannot be added automatically.
 *
 * A dispute whose details are missing is treated as blocking, never as harmless.
 */
export interface DisputeInfo { status?: string | null; resolutionType?: string | null; resolvedAt?: Date | null }

export type DisputeKind = 'none' | 'blocked' | 'buyer_wins' | 'seller_wins'

const NO_FAULT = new Set(['settled_by_parties', 'dismissed'])

export function disputeKind(d: DisputeInfo | null | undefined): DisputeKind {
  if (!d) return 'none'
  if (d.status !== 'resolved') return 'blocked'
  const t = d.resolutionType
  if (typeof t === 'string' && NO_FAULT.has(t)) return 'none'
  if (t === 'buyer_wins') return d.resolvedAt ? 'buyer_wins' : 'blocked'
  if (t === 'seller_wins') return 'seller_wins'
  return 'blocked' // a split, or an unknown outcome
}

/** True when the dispute keeps the trade out of the portfolio. */
export function disputeBlocksImport(d: DisputeInfo | null | undefined): boolean {
  return disputeKind(d) === 'blocked'
}
