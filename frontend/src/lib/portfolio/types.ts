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
  source: 'manual' | 'ctm' | 'p2p'
  /** Imported entry whose trade stopped qualifying: shown, but not counted. */
  voided: boolean
  voidReason: string | null
  /** When the user last corrected this entry (signed-in accounts only); null/absent if never. */
  editedAt?: string | null
  /** The RupChain trade this entry was recorded for by hand (signed-in accounts only). */
  linkedTradeRef?: string | null
  /** 'platform' = the RupChain price was used; 'own' = the price the user got; null/absent = not stated. */
  priceBasis?: PriceBasis | null
}

/** Which price a buy or sell used. Informational: it never changes a calculation. */
export type PriceBasis = 'platform' | 'own'

/** An earlier version of an entry, kept when it was corrected or removed. */
export interface EventRevision {
  id: string
  action: 'edit' | 'delete'
  /** The entry as it was before the change. */
  before: Partial<Pick<PortfolioEvent, 'type' | 'occurredAt' | 'quantity' | 'consideration' | 'fee' | 'basis' | 'zeroCost' | 'quote' | 'fxRate' | 'fxSource' | 'note'>>
  changedAt: string
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
  priceBasis?: PriceBasis
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
  /** Sales recorded for this token and how many of them have an incomplete result. Absent in older cached data. */
  soldCount?: number
  soldIncompleteCount?: number
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
  /** 'platform' = latest proven RupChain trade; otherwise how the user entered it. */
  source?: string
}

export interface PortfolioSummaryResponse {
  currency: Currency
  method: 'FIFO'
  fx: { usdtPkr: string | null }
  summary: PortfolioSummary
  /** Tokens that are still held, but whose cost or profit is partly unknown because a record has no exchange rate for this currency. */
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
  /** Logo of the RupChain token this one mirrors (platform-uploaded). Absent for tokens the user typed in. */
  logoUrl?: string | null
  /** Public catalog page of the RupChain token this one mirrors (approved tokens only). Used for the "view details" link. */
  catalogSlug?: string | null
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
  /** Trades you recorded by hand; they are not added a second time. */
  recordedManually?: number
  attention: Array<{ reason: AttentionReason; count: number }>
  hasImportedBefore: boolean
  preview: ImportPreviewItem[]
  skippedForLimit: number
}

/** A RupChain trade that was not added automatically, for the review list. */
export interface ExcludedTrade {
  tradeId: string
  tradeRef: string
  tokenName: string
  side: 'BUY' | 'SELL'
  quantity: string
  consideration: string | null
  quote: Currency
  date: string | null
  reason: AttentionReason
  /** You already recorded this trade by hand. */
  recorded: boolean
  /** It has finished and its amounts are usable, so you may record it yourself. */
  canRecord: boolean
}

export interface ExcludedTradesPage {
  total: number
  /** Trades across all pages that could be recorded now. Absent from older servers. */
  recordable?: number
  items: ExcludedTrade[]
}

/** Which left-out trades to record in one go. */
export type BatchSelection = { all: true } | { tradeIds: string[] }

export interface BatchReport {
  recorded: number
  alreadyRecorded: number
  skipped: number
  failed: number
  results: Array<{ tradeId: string; tradeRef: string; outcome: 'recorded' | 'already_recorded' | 'skipped' | 'failed'; message?: string }>
}

/** Filters for the all-transactions list. Empty/absent means "all". */
export interface EventListQuery {
  limit: number
  offset: number
  q?: string
  type?: PortfolioEventType
  source?: 'manual' | 'ctm' | 'p2p'
  status?: 'counted' | 'not_counted'
  assetId?: string
}

/** An entry with the name of the token it belongs to, for lists across tokens. */
export interface HistoryEvent extends PortfolioEvent {
  assetName: string
  assetSymbol: string | null
}

export interface EventsPage { total: number; items: HistoryEvent[] }
