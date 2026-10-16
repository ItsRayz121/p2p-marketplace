import type { PortfolioAssetDto, PortfolioAssetInput } from '@/lib/api'
import type { ExportData } from './exportFile'
import type {
  Currency, ImportReport, PerformanceResponse, PortfolioEvent, PortfolioEventInput, PortfolioSummaryResponse,
} from './types'

/**
 * Everything the Portfolio screens need from a backend. The signed-in tracker implements it over
 * the server API; the local-only guest tracker implements it over browser storage. The screens
 * cannot tell the difference, so both modes behave and look the same.
 *
 * Optional members are features that only exist for signed-in accounts (they involve RupChain's
 * own records); when absent the matching buttons are simply not shown.
 */
export interface PortfolioApiLike {
  listAssets(includeArchived?: boolean): Promise<PortfolioAssetDto[]>
  addAsset(data: PortfolioAssetInput): Promise<PortfolioAssetDto>
  updateAsset(id: string, data: PortfolioAssetInput): Promise<PortfolioAssetDto>
  archiveAsset(id: string): Promise<void>
  unarchiveAsset(id: string): Promise<void>
  deleteAsset(id: string): Promise<void>
  listEvents(assetId: string): Promise<PortfolioEvent[]>
  addEvent(assetId: string, data: PortfolioEventInput): Promise<PortfolioEvent>
  deleteEvent(assetId: string, eventId: string): Promise<void>
  setPrice(assetId: string, price: string, quote?: Currency): Promise<{ price: string; quote: Currency; observedAt: string }>
  summary(currency?: Currency): Promise<PortfolioSummaryResponse>
  performance(opts: { currency: Currency; from?: string; to?: string }): Promise<PerformanceResponse>
  exportAll(): Promise<ExportData>
  /** Signed-in only: copy settled RupChain trades into the tracker. */
  importCtm?(dryRun: boolean): Promise<ImportReport>
  /** Signed-in only: optional, withdrawable listing suggestion. */
  suggestListing?(id: string): Promise<{ listingInterest: boolean }>
  withdrawListingSuggestion?(id: string): Promise<{ listingInterest: boolean }>
}
