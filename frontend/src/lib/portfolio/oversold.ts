import type { PortfolioEvent } from './types'
import { computePosition, type TradeEvent } from './engine/fifo'
import { D } from './engine/decimal'

/**
 * Quantity sold beyond what the history shows. Only quantities and order matter, so amounts are set
 * to zero here: this never produces a profit figure, it only answers "would this leave a sale
 * without enough units behind it?".
 */
function excess(events: Array<Pick<PortfolioEvent, 'id' | 'type' | 'occurredAt' | 'quantity' | 'voided'>>): InstanceType<typeof D> {
  const trade: TradeEvent[] = events
    .filter((e) => !e.voided)
    .map((e, i) => ({
      id: e.id, assetId: 'x', type: e.type, at: e.occurredAt, seq: i, quantity: e.quantity,
      ...(e.type === 'OPENING' ? { basis: null } : { consideration: '0', fee: '0' }),
    }))
  let total = new D(0)
  for (const u of computePosition('x', trade).unresolvedSales) total = total.plus(u.quantity)
  return total
}

/**
 * Units that would become sold-beyond-history if `change` were applied to `events`
 * ("0" when nothing new goes wrong). `replace` swaps an entry for a corrected one; `remove` drops it.
 */
export function newlyOversold(
  events: PortfolioEvent[],
  change: { remove: string } | { replace: { id: string; type: PortfolioEvent['type']; occurredAt: string; quantity: string } },
): string {
  const before = excess(events)
  const after = excess(
    'remove' in change
      ? events.filter((e) => e.id !== change.remove)
      : events.map((e) => (e.id === change.replace.id ? { ...e, ...change.replace } : e)),
  )
  const diff = after.minus(before)
  return diff.gt(0) ? diff.toFixed() : '0'
}
