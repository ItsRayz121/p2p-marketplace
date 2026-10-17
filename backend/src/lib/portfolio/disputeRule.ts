/**
 * When a dispute keeps a trade out of the portfolio.
 *
 * - No dispute: nothing blocks it.
 * - An OPEN dispute (not yet resolved) always blocks it. It is added automatically only after the dispute is resolved.
 * - A resolved dispute blocks it when an admin RULED (buyer wins, seller wins, a split): a ruling does not prove that
 *   money and crypto both moved the way the trade says.
 * - A resolved dispute that carried NO fault (the two sides settled it themselves, or the admin dismissed it) does not
 *   block it. The trade then counts only if it also ended in its own completed state, which the importer checks.
 *
 * A dispute whose details are missing is treated as blocking, never as harmless.
 */
export interface DisputeInfo { status?: string | null; resolutionType?: string | null }

const NO_FAULT = new Set(['settled_by_parties', 'dismissed'])

export function disputeBlocksImport(d: DisputeInfo | null | undefined): boolean {
  if (!d) return false
  if (d.status !== 'resolved') return true
  return !(typeof d.resolutionType === 'string' && NO_FAULT.has(d.resolutionType))
}
