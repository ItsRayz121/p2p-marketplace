import { D, type Dec } from './decimal'

/**
 * How trustworthy each headline number is. A total is only a plain number when everything behind it
 * is known. "unavailable" means there is something to measure but nothing could be measured, so the
 * screen must say so instead of printing 0. A genuine zero (nothing held, nothing sold) is "known".
 */
export type FigureState = 'known' | 'partial' | 'unavailable'

export interface Figure {
  state: FigureState
  /** The sum over the parts that could be measured; null when state is "unavailable". */
  amount: string | null
  /** Parts that could be measured / parts that exist (tokens for value and unrealized, sales for realized). */
  covered: number
  total: number
}

export interface Figures {
  value: Figure
  unrealized: Figure
  realized: Figure
  /** Realized + unrealized, with the same rules. Never "known" while any part is missing. */
  total: Figure
  /** Tokens with a recorded quantity above zero. */
  heldCount: number
}

/** The subset of a valued position the figures need. Older cached payloads may lack the sale counts. */
export interface FigurePosition {
  quantity: string
  value: string | null
  unrealized: string | null
  realizedKnown: string
  realizedComplete: boolean
  unresolvedSales?: Array<unknown>
  soldCount?: number
  soldIncompleteCount?: number
}

function make(amount: Dec, covered: number, total: number): Figure {
  if (total === 0) return { state: 'known', amount: '0', covered: 0, total: 0 }
  if (covered === 0) return { state: 'unavailable', amount: null, covered: 0, total }
  return { state: covered < total ? 'partial' : 'known', amount: amount.toFixed(), covered, total }
}

/**
 * `extraUnmeasured` counts tokens that exist but were left out entirely (for example a missing
 * exchange rate), so they can never make a figure look complete.
 */
export function computeFigures(positions: FigurePosition[], extraUnmeasured = 0): Figures {
  let held = 0, priced = 0, unrealizedCovered = 0
  let sold = 0, soldCovered = 0
  let valueSum = new D(0), unrealizedSum = new D(0), realizedSum = new D(0)

  for (const p of positions) {
    if (new D(p.quantity).gt(0)) {
      held += 1
      if (p.value !== null) { priced += 1; valueSum = valueSum.plus(p.value) }
      if (p.unrealized !== null) { unrealizedCovered += 1; unrealizedSum = unrealizedSum.plus(p.unrealized) }
    }
    realizedSum = realizedSum.plus(p.realizedKnown)
    if (p.soldCount !== undefined) {
      sold += p.soldCount
      soldCovered += p.soldCount - (p.soldIncompleteCount ?? 0)
    } else if (!p.realizedComplete || (p.unresolvedSales?.length ?? 0) > 0) {
      // Older payload without sale counts: treat the token as one incomplete sale.
      sold += 1
    } else if (new D(p.realizedKnown).isZero() === false) {
      sold += 1
      soldCovered += 1
    }
  }

  const value = make(valueSum, priced, held + extraUnmeasured)
  const unrealized = make(unrealizedSum, unrealizedCovered, held + extraUnmeasured)
  const realized = make(realizedSum, soldCovered, sold + extraUnmeasured)
  const total = make(
    realizedSum.plus(unrealizedSum),
    unrealized.covered + realized.covered,
    unrealized.total + realized.total,
  )
  return { value, unrealized, realized, total, heldCount: held }
}
