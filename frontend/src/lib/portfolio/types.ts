export type PortfolioEventType = 'BUY' | 'SELL' | 'OPENING'
export type Currency = 'PKR' | 'USDT'

export interface PortfolioEvent {
  id: string
  assetId: string
  type: PortfolioEventType
  occurredAt: string
  quantity: string
  consideration: string | null
  fee: string | null
  basis: string | null
  zeroCost: boolean
  /** Currency of consideration / fee / basis. */
  quote: Currency
  /** PKR per 1 USDT recorded for this entry, if any. */
  fxRate: string | null
  fxSource: 'platform' | 'manual' | null
  note: string | null
  /** 'ctm' = read from a settled RupChain trade (read-only). Set by the server. */
  source: 'manual' | 'ctm'
  /** Imported entry whose trade stopped qualifying: shown, but not counted. */
  voided: boolean
  voidReason: string | null
}

export interface PortfolioEventInput {
  type: PortfolioEventType
  occurredAt: string
  quantity: string
  consideration?: string
  fee?: string
  basis?: string
  zeroCost?: boolean
  quote?: Currency
  fxRate?: string
  note?: string
  clientRequestId?: string
}

/** Mirrors the backend FIFO engine output. Every number is a decimal string; null means unknown. */
export interface PortfolioPosition {
  assetId: string
  quantity: string
  knownRemainingBasis: string
  basisComplete: boolean
  realizedKnown: string
  realizedComplete: boolean
  unresolvedSales: Array<{ eventId: string; quantity: string }>
  price: string | null
  value: string | null
  unrealized: string | null
}

export interface PortfolioSummary {
  positions: PortfolioPosition[]
  pricedValue: string
  knownRemainingBasis: string
  knownUnrealized: string
  knownRealized: string
  knownTotalPnl: string
  unpricedAssets: string[]
  unknownBasisAssets: string[]
  unresolvedAssets: string[]
  partial: boolean
}

export interface PortfolioPriceView {
  /** In the reporting currency at today's platform rate; null when it cannot be converted. */
  price: string | null
  original: string
  quote: Currency
  observedAt: string
}

export interface PortfolioSummaryResponse {
  currency: Currency
  method: 'FIFO'
  fx: { usdtPkr: string | null }
  summary: PortfolioSummary
  /** Tokens left out because a record has no exchange rate for this currency. */
  fxUnavailableAssets: string[]
  prices: Record<string, PortfolioPriceView>
  asOf: string
}

export interface SeriesPoint {
  t: string
  costBasis: string | null
  realized: string
  value: string | null
  priced: number
  held: number
  complete: boolean
}

export interface PeriodStats {
  realized: string
  realizedComplete: boolean
  moneyIn: string
  moneyOut: string
  openingsAdded: number
  valueStart: string | null
  valueEnd: string | null
  gain: string | null
  gainUnavailableReason: string | null
  returnPct: string | null
  returnMethod: 'MODIFIED_DIETZ'
}

export interface PerformanceResponse {
  currency: Currency
  from: string
  to: string
  points: SeriesPoint[]
  period: PeriodStats
  fxUnavailableAssets: string[]
}

/** A user-scoped, manually tracked asset. Identity is `id`; name/symbol/URL are display metadata only. */
export interface PortfolioAsset {
  id: string
  /** Set when archived: hidden from the main list, history and realized P&L kept. */
  archivedAt?: string | null
  /** The user has asked RupChain to list this token (optional, withdrawable). */
  listingInterest?: boolean
  /** Mirrors a token already available on RupChain (created by the trade import). */
  linkedToRupChainToken?: boolean
  name: string
  symbol?: string | null
  sourceUrl?: string | null
  network?: string | null
  contractAddress?: string | null
}

export type AttentionReason =
  | 'in_progress' | 'disputed' | 'admin_completed' | 'auto_completed' | 'unverified_transfer' | 'invalid_amounts'

export interface ImportPreviewItem {
  tradeRef: string
  tokenName: string
  type: 'BUY' | 'SELL'
  quantity: string
  consideration: string
  quote: Currency
  date: string
}

export interface ImportReport {
  dryRun: boolean
  created: number
  restored: number
  voided: number
  alreadyImported: number
  attention: Array<{ reason: AttentionReason; count: number }>
  hasImportedBefore: boolean
  preview: ImportPreviewItem[]
  skippedForLimit: number
}