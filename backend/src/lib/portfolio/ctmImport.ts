import { D, ALLOC_DP, ROUND } from './decimal'

/**
 * Which RupChain CTM trades may be copied into a user's tracker, and as what.
 *
 * Read-only by design: nothing here (or in the service that uses it) updates a trade, a wallet, an
 * order, a payout or any settlement state. `completed` alone is NOT treated as proof that both sides
 * settled, because a CTM trade can reach `completed` three ways: the buyer confirms receipt, a timer
 * auto-completes it after the buyer stays silent (a self-claim; no funds move), or an administrator
 * force-completes it (even out of a dispute). Only the first, backed by evidence where the settlement
 * type is on-chain, is imported. The rest are listed as "needs attention" and can be recorded by hand.
 */

export type AttentionReason =
  | 'in_progress'          // not finished yet; will be re-checked on the next sync
  | 'disputed'             // a dispute exists or existed: the outcome came from arbitration
  | 'admin_completed'      // completed by an administrator, not by the buyer's confirmation
  | 'auto_completed'       // completed by the timer; the buyer never confirmed
  | 'unverified_transfer'  // on-chain settlement without a verified token-transfer proof
  | 'invalid_amounts'      // amounts cannot be represented safely

export type Evidence = 'on_chain_verified' | 'buyer_confirmed'

export interface CtmTradeFacts {
  id: string
  displayRef: string | null
  /** The user whose tracker is being filled. */
  userId: string
  buyerId: string
  sellerId: string
  status: string
  settlementType: 'MANUAL' | 'ON_CHAIN' | 'HYBRID'
  completedAt: Date | null
  /** When the trade was opened. Only used to date a trade that never completed, in the review list. */
  createdAt?: Date | null
  tokenId: string
  tokenAmount: string
  fiatAmount: string
  paymentCurrency: string
  usdtAmount: string | null
  hasDispute: boolean
  adminForceCompleted: boolean
  autoCompleted: boolean
  verifiedTokenProof: boolean
}

export type Classification =
  | { kind: 'eligible'; evidence: Evidence }
  | { kind: 'attention'; reason: AttentionReason }
  | { kind: 'ignore' }

const IN_PROGRESS = new Set([
  'awaiting_payment', 'payment_uploaded', 'payment_confirmed', 'seller_transferring', 'proof_submitted', 'buyer_confirming',
])
const AMOUNT_RE = /^\d{1,28}(\.\d{1,18})?$/

export function classifyTrade(f: CtmTradeFacts): Classification {
  if (f.status === 'cancelled' || f.status === 'expired') return { kind: 'ignore' } // nothing was exchanged
  if (IN_PROGRESS.has(f.status)) return { kind: 'attention', reason: 'in_progress' }
  if (f.status === 'disputed' || f.status === 'dispute_resolved' || f.hasDispute) return { kind: 'attention', reason: 'disputed' }
  if (f.status !== 'completed' || !f.completedAt) return { kind: 'attention', reason: 'in_progress' }
  if (f.adminForceCompleted) return { kind: 'attention', reason: 'admin_completed' }
  if (f.autoCompleted) return { kind: 'attention', reason: 'auto_completed' }

  const onChain = f.settlementType === 'ON_CHAIN' || f.settlementType === 'HYBRID'
  if (onChain && !f.verifiedTokenProof) return { kind: 'attention', reason: 'unverified_transfer' }

  if (toEventSpec(f) === null) return { kind: 'attention', reason: 'invalid_amounts' }
  return { kind: 'eligible', evidence: onChain ? 'on_chain_verified' : 'buyer_confirmed' }
}

export interface TradeDescription {
  side: 'BUY' | 'SELL'
  quantity: string
  /** Amount in `quote`, or null if it cannot be represented safely. */
  consideration: string | null
  quote: 'PKR' | 'USDT'
  /** PKR per 1 USDT implied by the trade (USDT-paid trades only). */
  fxRate: string | null
}

/**
 * What a trade looked like for `f.userId`, for the review list. Unlike `toEventSpec` this does not
 * need the trade to be finished, and it never decides whether the trade counts: it only describes it.
 * Null when the user is neither party or the token amount is unusable.
 */
export function describeTrade(f: CtmTradeFacts): TradeDescription | null {
  const side = f.userId === f.buyerId ? 'BUY' : f.userId === f.sellerId ? 'SELL' : null
  if (!side) return null
  if (!AMOUNT_RE.test(f.tokenAmount) || new D(f.tokenAmount).lte(0)) return null
  let quote: 'PKR' | 'USDT' = 'PKR'
  let consideration: string | null = AMOUNT_RE.test(f.fiatAmount) && new D(f.fiatAmount).gt(0) ? new D(f.fiatAmount).toFixed() : null
  let fxRate: string | null = null
  if (f.paymentCurrency === 'USDT' && f.usdtAmount && AMOUNT_RE.test(f.usdtAmount) && new D(f.usdtAmount).gt(0) && consideration !== null) {
    const rate = new D(f.fiatAmount).div(f.usdtAmount).toDecimalPlaces(ALLOC_DP, ROUND)
    if (rate.gt(0)) { quote = 'USDT'; consideration = new D(f.usdtAmount).toFixed(); fxRate = rate.toFixed() }
  }
  return { side, quantity: new D(f.tokenAmount).toFixed(), consideration, quote, fxRate }
}

export interface ImportedEventSpec {
  sourceRef: string
  assetKey: string // CTM token id
  type: 'BUY' | 'SELL'
  occurredAt: Date
  quantity: string
  consideration: string
  quote: 'PKR' | 'USDT'
  /** PKR per 1 USDT implied by this trade (USDT-paid trades only). */
  fxRate: string | null
  note: string
}

/** The tracker entry for this trade, from the point of view of `f.userId`; null if it cannot be represented safely. */
export function toEventSpec(f: CtmTradeFacts): ImportedEventSpec | null {
  if (!f.completedAt) return null
  let type: 'BUY' | 'SELL'
  if (f.userId === f.buyerId) type = 'BUY'
  else if (f.userId === f.sellerId) type = 'SELL'
  else return null
  if (!AMOUNT_RE.test(f.tokenAmount) || new D(f.tokenAmount).lte(0)) return null

  let quote: 'PKR' | 'USDT' = 'PKR'
  let consideration = f.fiatAmount
  let fxRate: string | null = null
  if (f.paymentCurrency === 'USDT' && f.usdtAmount && AMOUNT_RE.test(f.usdtAmount) && new D(f.usdtAmount).gt(0)) {
    if (!AMOUNT_RE.test(f.fiatAmount) || new D(f.fiatAmount).lte(0)) return null
    quote = 'USDT'
    consideration = f.usdtAmount
    const rate = new D(f.fiatAmount).div(f.usdtAmount).toDecimalPlaces(ALLOC_DP, ROUND)
    if (!rate.gt(0)) return null
    fxRate = rate.toFixed()
  }
  if (!AMOUNT_RE.test(consideration)) return null

  return {
    sourceRef: f.id,
    assetKey: f.tokenId,
    type,
    occurredAt: f.completedAt,
    quantity: new D(f.tokenAmount).toFixed(),
    consideration: new D(consideration).toFixed(),
    quote,
    fxRate,
    note: `Imported from RupChain trade ${f.displayRef ?? f.id}`,
  }
}

export interface ExistingImported {
  id: string
  sourceRef: string
  voidedAt: Date | null
}

export interface ImportPlan {
  toCreate: ImportedEventSpec[]
  /** Existing imported entries whose trade qualifies again. */
  toRestore: string[]
  /** Existing imported entries whose trade no longer qualifies: kept, but excluded from calculations. */
  toVoid: Array<{ eventId: string; reason: AttentionReason | 'trade_missing' }>
  alreadyImported: number
  /** Eligible trades the user already recorded by hand: skipped so they are never counted twice. */
  recordedManually: number
  attention: Array<{ reason: AttentionReason; count: number }>
}

/**
 * Compare the user's trades with what was imported before.
 * Idempotent: running it twice yields an empty plan the second time.
 */
export function makePlan(trades: CtmTradeFacts[], existing: ExistingImported[], linkedByHand: ReadonlySet<string> = new Set()): ImportPlan {
  const byRef = new Map(existing.map((e) => [e.sourceRef, e]))
  const toCreate: ImportedEventSpec[] = []
  const toRestore: string[] = []
  const toVoid: ImportPlan['toVoid'] = []
  const attention = new Map<AttentionReason, number>()
  let already = 0
  let manual = 0
  const seen = new Set<string>()

  for (const t of trades) {
    seen.add(t.id)
    const c = classifyTrade(t)
    const prev = byRef.get(t.id)
    if (c.kind === 'ignore') {
      if (prev && !prev.voidedAt) toVoid.push({ eventId: prev.id, reason: 'in_progress' })
      continue
    }
    if (c.kind === 'attention') {
      attention.set(c.reason, (attention.get(c.reason) ?? 0) + 1)
      if (prev && !prev.voidedAt) toVoid.push({ eventId: prev.id, reason: c.reason })
      continue
    }
    if (prev) {
      if (prev.voidedAt) toRestore.push(prev.id)
      else already += 1
      continue
    }
    // The user already recorded this trade by hand: that record stands, so it is not imported as well.
    if (linkedByHand.has(t.id)) { manual += 1; continue }
    const spec = toEventSpec(t)
    if (spec) toCreate.push(spec)
  }

  // An imported entry whose trade can no longer be found must not keep counting.
  for (const e of existing) {
    if (!seen.has(e.sourceRef) && !e.voidedAt) toVoid.push({ eventId: e.id, reason: 'trade_missing' })
  }

  return {
    toCreate: toCreate.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime()),
    toRestore,
    toVoid,
    alreadyImported: already,
    recordedManually: manual,
    attention: [...attention.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => a.reason.localeCompare(b.reason)),
  }
}
