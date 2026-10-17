import { D, ALLOC_DP, ROUND } from './decimal'

/**
 * Which of a user's P2P USDT marketplace trades may be copied into their tracker, and as what.
 *
 * USDT is tracked as one holding per user ("Tether USDT"), valued at 1 USDT per USDT, so what a user earns
 * from buying low and selling high shows up as FIFO profit in PKR. Their own entries for USDT bought or sold
 * elsewhere go on the same holding, and the FIFO engine mixes them all by date.
 *
 * Read-only by design (nothing here writes). Only a trade whose crypto was RELEASED and that never had a
 * dispute counts; anything unfinished, disputed or cancelled is left out rather than guessed at.
 */

/** Stored in PortfolioAsset.ctmTokenId for the per-user USDT holding (one per user; no real token has this id). */
export const USDT_ASSET_KEY = 'p2p-usdt'
/** PortfolioEvent.source for an imported P2P USDT trade. */
export const USDT_SOURCE = 'p2p'

const AMOUNT_RE = /^\d{1,28}(\.\d{1,18})?$/
const IN_PROGRESS = new Set(['payment_pending', 'payment_uploaded', 'payment_confirmed', 'crypto_sent'])

export interface UsdtTradeFacts {
  id: string
  orderRef: string
  /** The user whose tracker is being filled. */
  userId: string
  buyerId: string
  sellerId: string
  coin: string
  status: string
  amount: string
  fiatAmount: string
  releasedAt: Date | null
  hasDispute: boolean
}

export type UsdtClass =
  | { kind: 'eligible' }
  | { kind: 'ignore' }
  | { kind: 'left_out'; reason: 'in_progress' | 'disputed' | 'invalid_amounts' }

export function classifyUsdtTrade(f: UsdtTradeFacts): UsdtClass {
  if (f.coin.toUpperCase() !== 'USDT') return { kind: 'ignore' }
  if (f.status === 'cancelled') return { kind: 'ignore' }
  if (f.userId !== f.buyerId && f.userId !== f.sellerId) return { kind: 'ignore' }
  if (f.status === 'disputed' || f.status === 'dispute_resolved' || f.hasDispute) return { kind: 'left_out', reason: 'disputed' }
  if (IN_PROGRESS.has(f.status)) return { kind: 'left_out', reason: 'in_progress' }
  if (f.status !== 'crypto_released' || !f.releasedAt) return { kind: 'left_out', reason: 'in_progress' }
  if (toUsdtEventSpec(f) === null) return { kind: 'left_out', reason: 'invalid_amounts' }
  return { kind: 'eligible' }
}

export interface UsdtEventSpec {
  sourceRef: string
  type: 'BUY' | 'SELL'
  occurredAt: Date
  quantity: string
  /** PKR paid or received for the whole quantity. */
  consideration: string
  quote: 'PKR'
  /** PKR per 1 USDT of THIS trade, so the USDT view converts it at the rate it really traded at. */
  fxRate: string
  note: string
}

/** The tracker entry for this trade from `f.userId`'s side; null if it cannot be represented safely. */
export function toUsdtEventSpec(f: UsdtTradeFacts): UsdtEventSpec | null {
  if (!f.releasedAt) return null
  const type = f.userId === f.buyerId ? 'BUY' : f.userId === f.sellerId ? 'SELL' : null
  if (!type) return null
  if (!AMOUNT_RE.test(f.amount) || !AMOUNT_RE.test(f.fiatAmount)) return null
  const qty = new D(f.amount)
  const fiat = new D(f.fiatAmount)
  if (!qty.gt(0) || !fiat.gt(0)) return null
  const rate = fiat.div(qty).toDecimalPlaces(ALLOC_DP, ROUND)
  if (!rate.gt(0)) return null
  return {
    sourceRef: f.id, type, occurredAt: f.releasedAt, quantity: qty.toFixed(), consideration: fiat.toFixed(), quote: 'PKR',
    fxRate: rate.toFixed(), note: `Imported from RupChain P2P trade ${f.orderRef}`,
  }
}

/**
 * The USDT/PKR rate implied by a PKR entry for USDT itself: what was paid (or received) per USDT. For USDT the
 * price IS the exchange rate, so an entry the user typed in for USDT bought or sold elsewhere can be shown in USDT
 * without any separate rate. Null when the amounts cannot give one.
 */
export function impliedUsdtRate(consideration: string | null, quantity: string): string | null {
  if (consideration === null || !AMOUNT_RE.test(consideration) || !AMOUNT_RE.test(quantity)) return null
  const q = new D(quantity)
  const c = new D(consideration)
  if (!q.gt(0) || !c.gt(0)) return null
  const rate = c.div(q).toDecimalPlaces(ALLOC_DP, ROUND)
  return rate.gt(0) ? rate.toFixed() : null
}

export interface ExistingUsdtEvent { id: string; sourceRef: string; voidedAt: Date | null }

export interface UsdtImportPlan {
  toCreate: UsdtEventSpec[]
  toRestore: string[]
  toVoid: Array<{ eventId: string; reason: 'in_progress' | 'disputed' | 'invalid_amounts' | 'trade_missing' }>
  alreadyImported: number
}

/** Compare the user's trades with what was imported before. Idempotent: running it twice yields an empty plan. */
export function planUsdtImport(trades: UsdtTradeFacts[], existing: ExistingUsdtEvent[]): UsdtImportPlan {
  const byRef = new Map(existing.map((e) => [e.sourceRef, e]))
  const plan: UsdtImportPlan = { toCreate: [], toRestore: [], toVoid: [], alreadyImported: 0 }
  const seen = new Set<string>()
  for (const t of trades) {
    seen.add(t.id)
    const c = classifyUsdtTrade(t)
    const prev = byRef.get(t.id)
    if (c.kind === 'eligible') {
      if (prev) { if (prev.voidedAt) plan.toRestore.push(prev.id); else plan.alreadyImported += 1 }
      else plan.toCreate.push(toUsdtEventSpec(t)!)
      continue
    }
    if (prev && !prev.voidedAt) plan.toVoid.push({ eventId: prev.id, reason: c.kind === 'left_out' ? c.reason : 'in_progress' })
  }
  for (const e of existing) if (!seen.has(e.sourceRef) && !e.voidedAt) plan.toVoid.push({ eventId: e.id, reason: 'trade_missing' })
  return plan
}
