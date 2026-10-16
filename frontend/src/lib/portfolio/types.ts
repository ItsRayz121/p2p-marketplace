export type PortfolioEventType = 'BUY' | 'SELL' | 'OPENING'

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
  note: string | null
}

export interface PortfolioEventInput {
  type: PortfolioEventType
  occurredAt: string
  quantity: string
  consideration?: string
  fee?: string
  basis?: string
  zeroCost?: boolean
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

export interface PortfolioSummaryResponse {
  currency: 'PKR'
  method: 'FIFO'
  summary: PortfolioSummary
  prices: Record<string, { price: string; observedAt: string }>
  asOf: string
}

/** A user-scoped, manually tracked asset. Identity is `id`; name/symbol/URL are display metadata only. */
export interface PortfolioAsset {
  id: string
  name: string
  symbol?: string | null
  sourceUrl?: string | null
  network?: string | null
  contractAddress?: string | null
}
