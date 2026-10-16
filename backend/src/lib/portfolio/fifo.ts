import { Prisma } from '@prisma/client'

/**
 * Portfolio calculation engine (analytical shadow ledger).
 *
 * Pure functions over decimal STRINGS: no floats, no database, no custody or settlement access, and
 * no descriptive asset details. Assets are identified by `assetId` only, so editing how a token is
 * labelled can never change any number produced here.
 *
 * Method: FIFO, portfolio-wide per asset. This is a portfolio accounting method, not a tax filing
 * determination. Single quote currency per call; fees are charged in the quote currency (other fee
 * assets are not supported yet and must be rejected upstream, not guessed at).
 */
// decimal.js defaults to 20 significant digits, too few for 28-digit amounts with 18 decimals.
const D = Prisma.Decimal.clone({ precision: 60, rounding: Prisma.Decimal.ROUND_HALF_EVEN })
type Dec = InstanceType<typeof D>

/** Rounding applied ONLY when splitting a lot's basis or a sale's proceeds across lots. */
export const ALLOC_DP = 8
const ROUND = Prisma.Decimal.ROUND_HALF_EVEN

const AMOUNT_RE = /^\d{1,28}(\.\d{1,18})?$/

export type TradeType = 'BUY' | 'SELL' | 'OPENING'

export interface TradeEvent {
  id: string
  assetId: string
  type: TradeType
  /** ISO-8601 UTC. Ordering is (at, seq, id) so equal timestamps are deterministic. */
  at: string
  seq?: number
  /** Decimal string, > 0. */
  quantity: string
  /** BUY/SELL: gross consideration in the quote currency, excluding fee. Ignored for OPENING. */
  consideration?: string
  /** BUY/SELL: fee in the quote currency (default 0). BUY fees are capitalised into basis; SELL fees reduce proceeds. */
  fee?: string
  /**
   * OPENING only. `null`/omitted = basis UNKNOWN (stays unknown, never zero).
   * A genuine zero basis must be declared with `zeroCost: true` and basis '0'.
   */
  basis?: string | null
  zeroCost?: boolean
}

export interface Mark {
  /** Current unit price in the quote currency, or null when there is no price (never treated as 0). */
  price: string | null
}

interface Lot {
  eventId: string
  qty: Dec
  /** null = unknown basis */
  basis: Dec | null
}

export interface UnresolvedSale {
  eventId: string
  /** Quantity sold in excess of recorded holdings; no P&L is produced for it. */
  quantity: string
}

export interface AssetPosition {
  assetId: string
  quantity: string
  /** Sum of remaining basis over lots whose basis is known. */
  knownRemainingBasis: string
  /** True only when every remaining lot has a known basis. */
  basisComplete: boolean
  realizedKnown: string
  /** False when some sold units came from lots with unknown basis. */
  realizedComplete: boolean
  unresolvedSales: UnresolvedSale[]
}

export interface ValuedPosition extends AssetPosition {
  price: string | null
  /** quantity x price, only when a price exists. */
  value: string | null
  /** value - remaining basis, only when price AND complete basis are known. */
  unrealized: string | null
}

export interface PortfolioSummary {
  positions: ValuedPosition[]
  pricedValue: string
  /** Remaining basis of positions that are both priced and fully known (the unrealized denominator). */
  knownRemainingBasis: string
  knownUnrealized: string
  knownRealized: string
  /** knownRealized + knownUnrealized; excludes anything unknown. */
  knownTotalPnl: string
  /** Assets that hold a positive quantity but have no price. */
  unpricedAssets: string[]
  /** Assets whose remaining or sold units have unknown basis. */
  unknownBasisAssets: string[]
  /** Assets with sales that exceed recorded holdings. */
  unresolvedAssets: string[]
  /** True when anything above is non-empty: the totals must be shown as partial. */
  partial: boolean
}

function dec(label: string, v: string | undefined, { positive }: { positive: boolean }): Dec {
  if (typeof v !== 'string' || !AMOUNT_RE.test(v)) throw new Error(`invalid ${label}`)
  const d = new D(v)
  if (positive ? !d.gt(0) : d.lt(0)) throw new Error(`invalid ${label}`)
  return d
}

const q8 = (d: Dec) => d.toDecimalPlaces(ALLOC_DP, ROUND)
const out = (d: Dec) => d.toFixed()

function sortEvents(events: TradeEvent[]): TradeEvent[] {
  return [...events].sort((a, b) => {
    const ta = Date.parse(a.at), tb = Date.parse(b.at)
    if (Number.isNaN(ta) || Number.isNaN(tb)) throw new Error('invalid date')
    return ta - tb || (a.seq ?? 0) - (b.seq ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  })
}

/** FIFO position for one asset from its events. */
export function computePosition(assetId: string, events: TradeEvent[]): AssetPosition {
  const mine = events.filter((e) => e.assetId === assetId)
  const seen = new Set<string>()
  for (const e of mine) {
    if (seen.has(e.id)) throw new Error('duplicate event id')
    seen.add(e.id)
  }

  const lots: Lot[] = []
  let realized = new D(0)
  let realizedComplete = true
  const unresolved: UnresolvedSale[] = []

  for (const e of sortEvents(mine)) {
    const qty = dec('quantity', e.quantity, { positive: true })

    if (e.type === 'OPENING') {
      let basis: Dec | null = null
      if (e.basis != null) {
        basis = dec('basis', e.basis, { positive: false })
        if (basis.isZero() && !e.zeroCost) throw new Error('zero basis must be declared with zeroCost')
      }
      lots.push({ eventId: e.id, qty, basis })
      continue
    }

    const gross = dec('consideration', e.consideration, { positive: false })
    const fee = e.fee === undefined ? new D(0) : dec('fee', e.fee, { positive: false })

    if (e.type === 'BUY') {
      lots.push({ eventId: e.id, qty, basis: gross.plus(fee) })
      continue
    }

    // SELL
    const net = gross.minus(fee)
    let toSell = qty
    const pieces: Array<{ qty: Dec; basis: Dec | null }> = []
    while (toSell.gt(0) && lots.length > 0) {
      const lot = lots[0]!
      const take = D.min(toSell, lot.qty)
      let matched: Dec | null = null
      if (lot.basis !== null) {
        matched = take.eq(lot.qty) ? lot.basis : q8(lot.basis.times(take).div(lot.qty))
        lot.basis = lot.basis.minus(matched)
      }
      lot.qty = lot.qty.minus(take)
      pieces.push({ qty: take, basis: matched })
      toSell = toSell.minus(take)
      if (lot.qty.isZero()) lots.shift()
    }
    if (toSell.gt(0)) {
      // Sold more than the record shows: no imaginary short-sale profit, ask for opening history.
      unresolved.push({ eventId: e.id, quantity: out(toSell) })
    }

    // Split net proceeds across ALL sold units by quantity (matched pieces first, the unresolved
    // excess last). The last matched piece takes the rounding remainder so shares sum exactly.
    let allocated = new D(0)
    pieces.forEach((p, i) => {
      const isLastOfAll = i === pieces.length - 1 && toSell.isZero()
      const share = isLastOfAll ? net.minus(allocated) : q8(net.times(p.qty).div(qty))
      allocated = allocated.plus(share)
      if (p.basis === null) realizedComplete = false
      else realized = realized.plus(share.minus(p.basis))
    })
  }

  let quantity = new D(0)
  let basis = new D(0)
  let basisComplete = true
  for (const l of lots) {
    quantity = quantity.plus(l.qty)
    if (l.basis === null) basisComplete = false
    else basis = basis.plus(l.basis)
  }

  return {
    assetId,
    quantity: out(quantity),
    knownRemainingBasis: out(basis),
    basisComplete,
    realizedKnown: out(realized),
    realizedComplete,
    unresolvedSales: unresolved,
  }
}

export function valuePosition(p: AssetPosition, mark: Mark | undefined): ValuedPosition {
  const price = mark?.price ?? null
  let value: Dec | null = null
  if (price !== null) value = dec('price', price, { positive: false }).times(p.quantity)
  const unrealized = value !== null && p.basisComplete ? value.minus(p.knownRemainingBasis) : null
  return {
    ...p,
    price,
    value: value === null ? null : out(value),
    unrealized: unrealized === null ? null : out(unrealized),
  }
}

/**
 * Portfolio-wide summary. Unknown stays unknown: an unpriced asset is NOT valued at zero and an
 * unknown basis is NOT treated as zero; both force `partial` and are excluded from the totals.
 * A position that is fully sold (quantity 0) still contributes its realized P&L.
 */
export function summarizePortfolio(
  events: TradeEvent[],
  marks: Record<string, Mark | undefined>,
): PortfolioSummary {
  const ids = [...new Set(events.map((e) => e.assetId))].sort()
  const positions = ids.map((id) => valuePosition(computePosition(id, events), marks[id]))

  let pricedValue = new D(0), knownBasis = new D(0), knownUnrealized = new D(0), knownRealized = new D(0)
  const unpriced: string[] = [], unknownBasis: string[] = [], unresolved: string[] = []

  for (const p of positions) {
    const holds = new D(p.quantity).gt(0)
    if (holds && p.value === null) unpriced.push(p.assetId)
    if (!p.basisComplete || !p.realizedComplete) unknownBasis.push(p.assetId)
    if (p.unresolvedSales.length > 0) unresolved.push(p.assetId)

    if (p.value !== null) pricedValue = pricedValue.plus(p.value)
    if (p.unrealized !== null) {
      knownBasis = knownBasis.plus(p.knownRemainingBasis)
      knownUnrealized = knownUnrealized.plus(p.unrealized)
    }
    knownRealized = knownRealized.plus(p.realizedKnown)
  }

  return {
    positions,
    pricedValue: out(pricedValue),
    knownRemainingBasis: out(knownBasis),
    knownUnrealized: out(knownUnrealized),
    knownRealized: out(knownRealized),
    knownTotalPnl: out(knownRealized.plus(knownUnrealized)),
    unpricedAssets: unpriced,
    unknownBasisAssets: unknownBasis,
    unresolvedAssets: unresolved,
    partial: unpriced.length + unknownBasis.length + unresolved.length > 0,
  }
}
