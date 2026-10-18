import { D } from './decimal'
import { computePosition, type TradeEvent } from './fifo'
import { convertAmount, type Quote } from './currency'
import { convertEvents, type EventRow } from './summaryBuilder'

/**
 * Tracking periods: the pure part. A period starts at one explicit cutover instant. What a user held then
 * (reconciled from their own records, FIFO) becomes the opening baseline; the earlier entries are archived.
 *
 * Two things are kept apart on purpose and never mixed:
 * - the ACTUAL acquisition cost of the units still held (`lots`, from the user's own records; unknown stays
 *   null, never zero, and a market price never replaces it): used for trading profit/loss;
 * - the opening MARKET value (the cutover-day quote): used only for "performance since tracking began".
 */

/** One remaining FIFO lot at the cutover, with its actual cost in both reporting currencies (null = unknown). */
export interface OpeningLot {
  eventId: string
  acquiredAt: string
  qty: string
  basisPkr: string | null
  basisUsdt: string | null
}

export interface BaselineAsset {
  assetId: string
  /** Units held at the cutover according to the records (never negative). */
  quantity: string
  lots: OpeningLot[]
  /** Units that earlier sales claimed beyond what the records show (no units were invented for them). */
  oversoldQuantity: string
  oversoldSales: number
  /** True when the cost of at least one held unit is not known. */
  basisUnknown: boolean
}

const QUOTES: Quote[] = ['PKR', 'USDT']

/**
 * Holdings at the cutover, per asset, from the entries that make up the current dataset (voided ones must
 * already be left out). Quantities do not depend on the currency; only costs do, so each lot carries both.
 * An asset with nothing left and no oversold units is not part of the baseline.
 */
export function computeBaseline(rows: EventRow[]): BaselineAsset[] {
  const perCurrency = new Map<Quote, Map<string, ReturnType<typeof computePosition>>>()
  for (const cur of QUOTES) {
    const { events } = convertEvents(rows, cur, { keepUnknownCost: true })
    const byAsset = new Map<string, TradeEvent[]>()
    for (const e of events) byAsset.set(e.assetId, [...(byAsset.get(e.assetId) ?? []), e])
    const positions = new Map<string, ReturnType<typeof computePosition>>()
    for (const [assetId, list] of byAsset) positions.set(assetId, computePosition(assetId, list))
    perCurrency.set(cur, positions)
  }

  const pkr = perCurrency.get('PKR')!
  const usdt = perCurrency.get('USDT')!
  const out: BaselineAsset[] = []
  for (const assetId of [...pkr.keys()].sort()) {
    const a = pkr.get(assetId)!
    const b = usdt.get(assetId)!
    // Quantities and lot order cannot depend on the currency; if they ever did, refuse to write a wrong baseline.
    if (a.lots.length !== b.lots.length || a.quantity !== b.quantity) throw new Error(`baseline mismatch between currencies for ${assetId}`)
    const lots: OpeningLot[] = a.lots.map((l, i) => {
      const m = b.lots[i]!
      if (m.eventId !== l.eventId || m.qty !== l.qty) throw new Error(`baseline lot mismatch between currencies for ${assetId}`)
      return { eventId: l.eventId, acquiredAt: l.at, qty: l.qty, basisPkr: l.basis, basisUsdt: m.basis }
    })
    const oversold = a.unresolvedSales.reduce((s, u) => s.plus(u.quantity), new D(0))
    if (lots.length === 0 && oversold.isZero()) continue // fully sold, nothing to carry
    out.push({
      assetId,
      quantity: a.quantity,
      lots,
      oversoldQuantity: oversold.toFixed(),
      oversoldSales: a.unresolvedSales.length,
      basisUnknown: lots.some((l) => l.basisPkr === null && l.basisUsdt === null) || !a.basisComplete,
    })
  }
  return out
}

/** The stored shape the engine needs to continue from a baseline. */
export interface HoldingLike {
  id: string
  assetId: string
  lots: unknown
}

/** Defensive read of the stored lots JSON (it came from this module, but a bad row must not crash the summary). */
export function readLots(raw: unknown): OpeningLot[] {
  if (!Array.isArray(raw)) return []
  const out: OpeningLot[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    if (typeof o.eventId !== 'string' || typeof o.qty !== 'string' || typeof o.acquiredAt !== 'string') continue
    out.push({
      eventId: o.eventId,
      acquiredAt: o.acquiredAt,
      qty: o.qty,
      basisPkr: typeof o.basisPkr === 'string' ? o.basisPkr : null,
      basisUsdt: typeof o.basisUsdt === 'string' ? o.basisUsdt : null,
    })
  }
  return out
}

/**
 * The opening baseline as ordinary OPENING entries in `currency`, so the one calculation pipeline (FIFO,
 * summary, performance) continues from it. Each lot keeps its ACTUAL cost (null = unknown); the lot's
 * original acquisition date is kept in `note`-free form as the cutover time, because "what was held at the
 * cutover" is what the period starts from. FIFO order inside the baseline is the original order.
 */
export function openingRows(holdings: HoldingLike[], currency: Quote, startedAt: Date): EventRow[] {
  const rows: EventRow[] = []
  for (const h of holdings) {
    readLots(h.lots).forEach((lot, i) => {
      const basis = currency === 'PKR' ? lot.basisPkr : lot.basisUsdt
      rows.push({
        // Lot order is kept by the (time, sequence, id) ordering the engine already applies.
        id: `open:${h.id}:${String(i).padStart(4, '0')}`,
        assetId: h.assetId,
        type: 'OPENING',
        occurredAt: startedAt,
        quantity: lot.qty,
        consideration: null,
        fee: null,
        basis,
        zeroCost: basis !== null && new D(basis).isZero(),
        quote: currency,
        fxRate: null,
      })
    })
  }
  return rows
}

export interface OpeningMarket {
  price: string | null
  quote: Quote | null
}

/**
 * Opening MARKET value of one holding in `currency`: units x the cutover-day quote, converted at the
 * cutover-day rate. Null when there was no valid quote (or no rate to convert it) - never zero.
 */
export function openingMarketValue(quantity: string, market: OpeningMarket, currency: Quote, cutoverRate: string | null): string | null {
  if (market.price === null || market.quote === null) return null
  const price = convertAmount(market.price, market.quote, currency, cutoverRate)
  if (price === null) return null
  return new D(price).times(quantity).toFixed()
}

/** Sum of opening market values; null unless EVERY holding with units had a valid quote (a partial sum is not a baseline). */
export function openingMarketTotal(
  holdings: Array<{ quantity: string; market: OpeningMarket }>,
  currency: Quote,
  cutoverRate: string | null,
): string | null {
  let total = new D(0)
  for (const h of holdings) {
    if (!new D(h.quantity).gt(0)) continue
    const v = openingMarketValue(h.quantity, h.market, currency, cutoverRate)
    if (v === null) return null
    total = total.plus(v)
  }
  return total.toFixed()
}

// ── Asset identity ─────────────────────────────────────────────────────────

export interface IdentityInput {
  id: string
  name: string
  symbol: string | null
  network: string | null
  contractAddress: string | null
  /** Platform token id, the per-user USDT key, or null for a token the user typed in. */
  ctmTokenId: string | null
}

const norm = (s: string | null | undefined) => (s ?? '').normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * Identifiers that mean "the same asset". Matching is exact on a normalised value, never on a prefix, so actual
 * USD cash ("usd") and Tether USDT ("usdt") can never be folded into one another.
 */
export function identityKeys(a: IdentityInput): string[] {
  const keys: string[] = []
  if (a.ctmTokenId) keys.push(`platform:${a.ctmTokenId}`)
  if (a.network && a.contractAddress) keys.push(`chain:${norm(a.network)}:${norm(a.contractAddress)}`)
  return keys
}

export interface AliasGroup {
  key: string
  assetIds: string[]
}

/** Groups of two or more tracked assets that share an identity key (possible duplicates to review; never merged automatically). */
export function findAliasGroups(assets: IdentityInput[]): AliasGroup[] {
  const byKey = new Map<string, Set<string>>()
  for (const a of assets) {
    for (const k of identityKeys(a)) byKey.set(k, (byKey.get(k) ?? new Set()).add(a.id))
  }
  return [...byKey.entries()]
    .filter(([, ids]) => ids.size > 1)
    .map(([key, ids]) => ({ key, assetIds: [...ids].sort() }))
    .sort((x, y) => (x.key < y.key ? -1 : 1))
}

// ── Reconciliation record ──────────────────────────────────────────────────

export interface ReconciliationDiscrepancy {
  kind: 'oversold_history' | 'unknown_cost' | 'duplicate_identity' | 'usdt_wallet_difference' | 'unquoted_holding'
  assetId?: string
  /** Plain-language fact, never an instruction to invent a number. */
  detail: string
}

export interface Reconciliation {
  version: 1
  /** Entries that made up the baseline, and how many were left out as voided. */
  entriesCounted: number
  entriesVoided: number
  assetsWithHoldings: number
  /** Listings and reserved balances are context only: they never add to or subtract from holdings. */
  context: {
    wallet: Array<{ coin: string; network: string; owned: string; reserved: string; available: string }>
    listings: Array<{ tokenId: string; side: string; status: string; available: string; locked: string }>
  }
  discrepancies: ReconciliationDiscrepancy[]
}

/** Wallet figures as context. `balance` already INCLUDES the reserved amount, so reserved is a part of owned, not an addition. */
export function walletContext(rows: Array<{ coin: string; network: string; balance: string; lockedBalance: string }>): Reconciliation['context']['wallet'] {
  return rows.map((w) => {
    const owned = new D(w.balance)
    const reserved = new D(w.lockedBalance)
    return { coin: w.coin, network: w.network, owned: owned.toFixed(), reserved: reserved.toFixed(), available: owned.minus(reserved).toFixed() }
  })
}
