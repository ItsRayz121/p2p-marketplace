'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type {
  BatchReport, BatchSelection, Currency, EventListQuery, EventRevision, EventsPage, ExcludedTradesPage, ImportReport, PerformanceResponse, PortfolioAsset, PortfolioEvent, PortfolioEventInput, PortfolioSummaryResponse,
} from '@/lib/portfolio/types'
import type { CustomAssetValue } from '@/lib/portfolio/customAsset'
import type { ExportData } from '@/lib/portfolio/exportFile'
import type { PortfolioApiLike } from '@/lib/portfolio/apiTypes'
import { CustomTokenForm } from './CustomTokenForm'
import { ExportMenu } from './ExportMenu'
import { ImportBackupDialog } from './ImportBackupDialog'
import { ExcludedTradesView } from './ExcludedTradesView'
import { ImportBanner } from './ImportBanner'
import { PerformanceSection } from './PerformanceSection'
import { PortfolioHeadline } from './PortfolioHeadline'
import { AllocationBar } from './AllocationBar'
import { ReviewCenter, buildReview, reviewCount } from './ReviewCenter'
import { TokenCard } from './TokenCard'
import { TokenDetail, type StartWith } from './TokenDetail'
import { TransactionHistory } from './TransactionHistory'

type View =
  | { name: 'overview' }
  | { name: 'add' }
  | { name: 'token'; assetId: string; start?: StartWith }
  | { name: 'history' }
  | { name: 'edit'; assetId: string }
  | { name: 'excluded' }
  | { name: 'review' }

interface Props {
  /** Existing custody wallet UI (spendable balance, deposit/withdraw, history). Rendered unchanged. */
  walletSection?: ReactNode
  /** Status shown above everything else (offline / waiting-to-sync). */
  notice?: ReactNode
  /** Tracked (analytical) assets. Never combined with custody balances. */
  assets?: PortfolioAsset[]
  summary?: PortfolioSummaryResponse | null
  /** Currency the portfolio is shown in. */
  currency?: Currency
  onCurrencyChange?: (c: Currency) => void
  loading?: boolean
  error?: string | null
  onRetry?: () => void
  onAddAsset?: (value: CustomAssetValue) => Promise<void> | void
  onEditAsset?: (id: string, value: CustomAssetValue) => Promise<void> | void
  loadEvents?: (assetId: string) => Promise<PortfolioEvent[]>
  onRecordEvent?: (assetId: string, input: PortfolioEventInput) => Promise<void>
  onDeleteEvent?: (assetId: string, eventId: string) => Promise<void>
  onUpdateEvent?: (assetId: string, eventId: string, input: PortfolioEventInput) => Promise<void>
  loadHistory?: (assetId: string, eventId: string) => Promise<EventRevision[]>
  onSetPrice?: (assetId: string, price: string, quote: Currency, source?: string) => Promise<void>
  loadPerformance?: (range: { currency: Currency; from?: string; to?: string }) => Promise<PerformanceResponse>
  onArchive?: (assetId: string) => Promise<void>
  onUnarchive?: (assetId: string) => Promise<void>
  onDeleteAsset?: (assetId: string) => Promise<void>
  /** Preview of RupChain trades that could be added (and those deliberately left out). */
  importReport?: ImportReport | null
  importBusy?: boolean
  importError?: string | null
  onImportTrades?: () => void
  /** RupChain trades that were left out of automatic tracking, and a way to record one by hand. */
  loadExcluded?: (limit: number, offset: number) => Promise<ExcludedTradesPage>
  /** Every entry across all tokens, with search, filters and paging. */
  loadAllEvents?: (query: EventListQuery) => Promise<EventsPage>
  onRecordExcluded?: (tradeId: string, input: PortfolioEventInput) => Promise<void>
  onRecordBatch?: (selection: BatchSelection) => Promise<BatchReport>
  onDismissImport?: () => void
  loadExport?: () => Promise<ExportData>
  onSuggestListing?: (assetId: string) => Promise<void>
  onWithdrawListing?: (assetId: string) => Promise<void>
  /** Account only: lets the user bring a backup file (e.g. from the local tracker) into this account. */
  backupImportApi?: Pick<PortfolioApiLike, 'addAsset' | 'addEvent' | 'listEvents'>
  onBackupImported?: () => void
  /** Offer the JSON backup download. Off for signed-in accounts, which keep their data on the server. */
  showBackupDownload?: boolean
}

const noEvents = async (): Promise<PortfolioEvent[]> => []
const noop = async () => {}

/**
 * Contents of the Portfolio tab of Wallet & Payment Methods. Overview, token detail, history and
 * entry forms all live here; the tab itself stays selected while views change.
 */
export function PortfolioTab({
  notice, walletSection, assets = [], summary = null, currency = 'PKR', onCurrencyChange, loading = false, error = null, onRetry,
  onAddAsset, onEditAsset, loadEvents = noEvents, onRecordEvent = noop, onDeleteEvent = noop, onUpdateEvent, loadHistory, onSetPrice = noop, onArchive, onUnarchive, onDeleteAsset, loadPerformance,
  importReport = null, importBusy = false, importError = null, onImportTrades, onDismissImport, loadExport, loadExcluded, onRecordExcluded, onRecordBatch, loadAllEvents,
  onSuggestListing, onWithdrawListing, backupImportApi, onBackupImported, showBackupDownload = true,
}: Props) {
  const [view, setView] = useState<View>({ name: 'overview' })
  const lastRowRef = useRef<string | null>(null)
  const backRef = useRef<HTMLButtonElement>(null)
  const addBtnRef = useRef<HTMLButtonElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const rowRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const first = useRef(true)
  const [showBackupImport, setShowBackupImport] = useState(false)
  const [showArchived, setShowArchived] = useState(false)

  // Move focus into a view when it opens, and back to where the user came from when it closes.
  useEffect(() => {
    if (first.current) { first.current = false; return }
    if (view.name === 'token' || view.name === 'excluded' || view.name === 'history' || view.name === 'review') backRef.current?.focus()
    else if (view.name === 'add' || view.name === 'edit') headingRef.current?.focus()
    else if (lastRowRef.current) rowRefs.current[lastRowRef.current]?.focus()
    else addBtnRef.current?.focus()
  }, [view])

  const activeAssets = useMemo(() => assets.filter((a) => !a.archivedAt), [assets])
  const archivedAssets = useMemo(() => assets.filter((a) => a.archivedAt), [assets])
  const listed = showArchived ? assets : activeAssets
  const positions = useMemo(
    () => new Map((summary?.summary.positions ?? []).map((p) => [p.assetId, p])),
    [summary],
  )
  // Tokens you currently hold according to your records (archived ones are not counted).
  const trackedHeld = activeAssets.filter((a) => /[1-9]/.test(positions.get(a.id)?.quantity ?? '0')).length
  // The first active token that lacks a price / a recorded cost, so an empty chart can offer a way to fix it.
  const firstToFix = useMemo(() => {
    const activeIds = new Set(activeAssets.map((x) => x.id))
    const first = (ids: string[] | undefined) => ids?.find((id) => activeIds.has(id))
    return { price: first(summary?.summary.unpricedAssets), cost: first(summary?.summary.unknownBasisAssets) }
  }, [summary, activeAssets])
  const canReviewTrades = Boolean(loadExcluded && onRecordExcluded)
  const reviewSections = useMemo(
    () => (summary ? buildReview(summary, assets, importReport, canReviewTrades) : []),
    [summary, assets, importReport, canReviewTrades],
  )
  const toReview = reviewCount(reviewSections)
  const waitingTrades = importReport?.attention.find((a) => a.reason === 'in_progress')?.count ?? 0
  // Labels follow the data on screen, not the switch: right after a click the numbers are still in the previous currency until the reply arrives.
  const shown: Currency = summary?.currency ?? currency
  const current = view.name === 'token' || view.name === 'edit' ? assets.find((a) => a.id === view.assetId) : undefined

  return (
    <div className="space-y-8">
      {notice}
      <section aria-labelledby="tracked-portfolio-heading">
        {view.name === 'add' && (
          <div className="space-y-4">
            <h2 id="tracked-portfolio-heading" ref={headingRef} tabIndex={-1} className="text-base font-semibold text-text-primary outline-none">Add custom token</h2>
            <div className="bg-surface shadow-card rounded-xl border border-border p-5">
              <CustomTokenForm
                onCancel={() => { lastRowRef.current = null; setView({ name: 'overview' }) }}
                onSubmit={async (v) => { await onAddAsset?.(v); lastRowRef.current = null; setView({ name: 'overview' }) }}
              />
            </div>
          </div>
        )}

        {view.name === 'excluded' && loadExcluded && onRecordExcluded && (
          <ExcludedTradesView
            load={loadExcluded}
            onRecord={onRecordExcluded}
            onRecordBatch={onRecordBatch}
            currency={shown}
            backRef={backRef}
            onBack={() => { lastRowRef.current = null; setView({ name: 'review' }) }}
          />
        )}

        {view.name === 'review' && (
          <ReviewCenter
            sections={reviewSections}
            waiting={waitingTrades}
            backRef={backRef}
            onBack={() => { lastRowRef.current = null; setView({ name: 'overview' }) }}
            onOpenToken={(assetId, action) => { lastRowRef.current = assetId; setView({ name: 'token', assetId, start: action }) }}
            onReviewTrades={canReviewTrades ? () => setView({ name: 'excluded' }) : undefined}
          />
        )}

        {view.name === 'history' && loadAllEvents && (
          <TransactionHistory
            load={loadAllEvents}
            backRef={backRef}
            onBack={() => { lastRowRef.current = null; setView({ name: 'overview' }) }}
            onOpenToken={(assetId) => { lastRowRef.current = assetId; setView({ name: 'token', assetId }) }}
          />
        )}

        {view.name === 'edit' && current && (
          <div className="space-y-4">
            <h2 id="tracked-portfolio-heading" ref={headingRef} tabIndex={-1} className="text-base font-semibold text-text-primary outline-none">Edit token details</h2>
            <p className="text-xs text-text-muted">Changing these details does not change your quantities, transactions, cost basis or profit and loss.</p>
            <div className="bg-surface shadow-card rounded-xl border border-border p-5">
              <CustomTokenForm
                initial={current}
                submitLabel="Save details"
                onCancel={() => setView({ name: 'token', assetId: current.id })}
                onSubmit={async (v) => { await onEditAsset?.(current.id, v); setView({ name: 'token', assetId: current.id }) }}
              />
            </div>
          </div>
        )}

        {view.name === 'token' && (
          current ? (
            <TokenDetail
              key={`${current.id}-${view.name === 'token' ? (view.start ?? 'view') : 'view'}`}
              startWith={view.name === 'token' ? view.start : undefined}
              asset={current}
              position={positions.get(current.id)}
              price={summary?.prices[current.id]}
              currency={shown}
              usdtPkr={summary?.fx.usdtPkr ?? null}
              fxUnavailable={summary?.fxUnavailableAssets.includes(current.id)}
              backRef={backRef}
              onBack={() => setView({ name: 'overview' })}
              onEdit={onEditAsset && !current.linkedToRupChainToken ? () => setView({ name: 'edit', assetId: current.id }) : undefined}
              loadEvents={loadEvents}
              onRecordEvent={onRecordEvent}
              onDeleteEvent={onDeleteEvent}
              onUpdateEvent={onUpdateEvent}
              loadHistory={loadHistory}
              onSetPrice={onSetPrice}
              onArchive={onArchive}
              onUnarchive={onUnarchive}
              onDeleteAsset={onDeleteAsset}
              onSuggestListing={onSuggestListing}
              onWithdrawListing={onWithdrawListing}
            />
          ) : (
            <div className="space-y-4">
              <button ref={backRef} type="button" onClick={() => setView({ name: 'overview' })} className="text-sm font-medium text-primary hover:underline">← Back to portfolio</button>
              <h2 id="tracked-portfolio-heading" className="text-base font-semibold text-text-primary">Token not found</h2>
            </div>
          )
        )}

        {view.name === 'overview' && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
              <h2 id="tracked-portfolio-heading" className="text-xl font-bold text-text-primary">Portfolio</h2>
              <span className="inline-flex flex-wrap items-center gap-2">
                {summary && (
                  <button type="button" onClick={() => setView({ name: 'review' })} className="relative inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-semibold text-text-primary hover:bg-surface-hover">
                    Review
                    {toReview > 0 && <span aria-label={`${toReview} to review`} className="rounded-full bg-amber-500 px-1.5 text-[11px] font-bold leading-4 text-white">{toReview}</span>}
                  </button>
                )}
                {loadAllEvents && assets.length > 0 && (
                  <button type="button" onClick={() => setView({ name: 'history' })} className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-semibold text-text-primary hover:bg-surface-hover whitespace-nowrap">
                    Transactions
                  </button>
                )}
                {onAddAsset && (
                  <button ref={addBtnRef} type="button" onClick={() => setView({ name: 'add' })} className="rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-white hover:opacity-90 whitespace-nowrap">
                    Add asset
                  </button>
                )}
              </span>
            </div>
            <p className="text-xs text-text-muted mb-3">
              A tracked estimate from the transactions you record. Separate from your RupChain wallet balance below; the two are never added together.
            </p>

            {importReport && onImportTrades && onDismissImport && (
              <div className="mb-4">
                <ImportBanner report={importReport} busy={importBusy} error={importError} onImport={onImportTrades} onDismiss={onDismissImport} />
              </div>
            )}

            {onCurrencyChange && (
              <div role="radiogroup" aria-label="Show amounts in" className="inline-flex rounded-lg border border-border overflow-hidden mb-3">
                {(['PKR', 'USDT'] as const).map((c) => (
                  <button
                    key={c} type="button" role="radio" aria-checked={currency === c}
                    onClick={() => onCurrencyChange(c)}
                    className={`px-3 py-1.5 text-xs font-semibold ${currency === c ? 'bg-primary text-white' : 'bg-surface text-text-secondary hover:bg-surface-hover'}`}
                  >
                    {c}
                  </button>
                ))}
              </div>
            )}

            {summary && (summary.summary.positions.length > 0 || summary.fxUnavailableAssets.length > 0) && (
              <div className="mb-4 space-y-6">
                <PortfolioHeadline data={summary} trackedHeld={trackedHeld} trackedTotal={activeAssets.length} />
                {loadPerformance && summary.summary.positions.length > 0 && (
                  <PerformanceSection
                    currency={shown}
                    load={loadPerformance}
                    refreshKey={summary.asOf}
                    onAddPrice={firstToFix.price ? () => { lastRowRef.current = firstToFix.price!; setView({ name: 'token', assetId: firstToFix.price!, start: 'price' }) } : undefined}
                    onFixCost={firstToFix.cost ? () => { lastRowRef.current = firstToFix.cost!; setView({ name: 'token', assetId: firstToFix.cost!, start: 'history' }) } : undefined}
                  />
                )}
                <AllocationBar positions={summary.summary.positions} assets={activeAssets} currency={shown} />
              </div>
            )}

            {listed.length > 0 && !loading && !error && <h3 className="text-sm font-semibold text-text-primary mb-2">Holdings</h3>}
            {loading ? (
              <div role="status" className="bg-surface shadow-card rounded-xl border border-border p-5 text-sm text-text-muted">
                Loading your tracked tokens…
              </div>
            ) : error ? (
              <div role="alert" className="bg-surface shadow-card rounded-xl border border-border p-5 text-sm text-danger">
                {error}
                {onRetry && (
                  <button type="button" onClick={onRetry} className="ml-2 font-medium text-primary hover:underline">Try again</button>
                )}
              </div>
            ) : assets.length === 0 ? (
              <div className="bg-surface shadow-card rounded-xl border border-border p-5 text-sm text-text-muted">
                No tracked tokens yet.
              </div>
            ) : listed.length === 0 ? (
              <div className="bg-surface shadow-card rounded-xl border border-border p-5 text-sm text-text-muted">
                All your tracked tokens are archived. Their history still counts in the totals above.
              </div>
            ) : (
              <ul className="grid grid-cols-1 gap-2.5">
                {listed.map((a) => (
                  <TokenCard
                    key={a.id}
                    asset={a}
                    position={positions.get(a.id)}
                    price={summary?.prices[a.id]}
                    shown={shown}
                    fxUnavailable={Boolean(summary?.fxUnavailableAssets.includes(a.id))}
                    buttonRef={(el) => { rowRefs.current[a.id] = el }}
                    onOpen={() => { lastRowRef.current = a.id; setView({ name: 'token', assetId: a.id }) }}
                  />
                ))}
              </ul>
            )}
            {!loading && !error && loadExport && assets.length > 0 && (
              <div className="mt-3"><ExportMenu load={loadExport} includeBackup={showBackupDownload} /></div>
            )}
            {!loading && !error && backupImportApi && (
              showBackupImport ? (
                <div className="mt-3">
                  <ImportBackupDialog api={backupImportApi} existing={assets} onClose={() => setShowBackupImport(false)} onDone={() => onBackupImported?.()} />
                </div>
              ) : (
                <button type="button" onClick={() => setShowBackupImport(true)} className="mt-3 block text-xs font-medium text-primary hover:underline">Import from a backup file</button>
              )
            )}
            {!loading && !error && archivedAssets.length > 0 && (
              <button
                type="button" aria-pressed={showArchived} onClick={() => setShowArchived((s) => !s)}
                className="mt-3 text-xs font-medium text-primary hover:underline"
              >
                {showArchived ? 'Hide archived tokens' : `Show archived tokens (${archivedAssets.length})`}
              </button>
            )}
          </>
        )}
      </section>

      {walletSection}
    </div>
  )
}
