'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type {
  PortfolioAsset, PortfolioEvent, PortfolioEventInput, PortfolioSummaryResponse,
} from '@/lib/portfolio/types'
import type { CustomAssetValue } from '@/lib/portfolio/customAsset'
import { formatDecimal, formatQuantity, formatSigned } from '@/lib/portfolio/format'
import { CustomTokenForm } from './CustomTokenForm'
import { PortfolioHeadline } from './PortfolioHeadline'
import { TokenDetail } from './TokenDetail'
import { TokenMonogram } from './TokenMonogram'

type View =
  | { name: 'overview' }
  | { name: 'add' }
  | { name: 'token'; assetId: string }
  | { name: 'edit'; assetId: string }

interface Props {
  /** Existing custody wallet UI (spendable balance, deposit/withdraw, history). Rendered unchanged. */
  walletSection?: ReactNode
  /** Tracked (analytical) assets. Never combined with custody balances. */
  assets?: PortfolioAsset[]
  summary?: PortfolioSummaryResponse | null
  loading?: boolean
  error?: string | null
  onRetry?: () => void
  onAddAsset?: (value: CustomAssetValue) => Promise<void> | void
  onEditAsset?: (id: string, value: CustomAssetValue) => Promise<void> | void
  loadEvents?: (assetId: string) => Promise<PortfolioEvent[]>
  onRecordEvent?: (assetId: string, input: PortfolioEventInput) => Promise<void>
  onDeleteEvent?: (assetId: string, eventId: string) => Promise<void>
  onSetPrice?: (assetId: string, price: string) => Promise<void>
}

const noEvents = async (): Promise<PortfolioEvent[]> => []
const noop = async () => {}

/**
 * Contents of the Portfolio tab of Wallet & Payment Methods. Overview, token detail, history and
 * entry forms all live here; the tab itself stays selected while views change.
 */
export function PortfolioTab({
  walletSection, assets = [], summary = null, loading = false, error = null, onRetry,
  onAddAsset, onEditAsset, loadEvents = noEvents, onRecordEvent = noop, onDeleteEvent = noop, onSetPrice = noop,
}: Props) {
  const [view, setView] = useState<View>({ name: 'overview' })
  const lastRowRef = useRef<string | null>(null)
  const backRef = useRef<HTMLButtonElement>(null)
  const addBtnRef = useRef<HTMLButtonElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const rowRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const first = useRef(true)

  // Move focus into a view when it opens, and back to where the user came from when it closes.
  useEffect(() => {
    if (first.current) { first.current = false; return }
    if (view.name === 'token') backRef.current?.focus()
    else if (view.name === 'add' || view.name === 'edit') headingRef.current?.focus()
    else if (lastRowRef.current) rowRefs.current[lastRowRef.current]?.focus()
    else addBtnRef.current?.focus()
  }, [view])

  const names = useMemo(() => Object.fromEntries(assets.map((a) => [a.id, a.name])), [assets])
  const positions = useMemo(
    () => new Map((summary?.summary.positions ?? []).map((p) => [p.assetId, p])),
    [summary],
  )
  const current = view.name === 'token' || view.name === 'edit' ? assets.find((a) => a.id === view.assetId) : undefined

  return (
    <div className="space-y-8">
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
              asset={current}
              position={positions.get(current.id)}
              price={summary?.prices[current.id]}
              backRef={backRef}
              onBack={() => setView({ name: 'overview' })}
              onEdit={onEditAsset ? () => setView({ name: 'edit', assetId: current.id }) : undefined}
              loadEvents={loadEvents}
              onRecordEvent={onRecordEvent}
              onDeleteEvent={onDeleteEvent}
              onSetPrice={onSetPrice}
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
            <div className="flex items-start justify-between gap-3 mb-1">
              <h2 id="tracked-portfolio-heading" className="text-base font-semibold text-text-primary">Tracked portfolio</h2>
              {onAddAsset && (
                <button ref={addBtnRef} type="button" onClick={() => setView({ name: 'add' })} className="text-sm font-semibold text-primary hover:underline whitespace-nowrap">
                  Add custom token
                </button>
              )}
            </div>
            <p className="text-xs text-text-muted mb-3">
              Estimates based on transactions you record. Separate from your RupChain wallet balance below; the two are never added together.
            </p>

            {summary && summary.summary.positions.length > 0 && (
              <div className="mb-4"><PortfolioHeadline data={summary} names={names} /></div>
            )}

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
            ) : (
              <ul className="bg-surface shadow-card rounded-xl border border-border divide-y divide-border">
                {assets.map((a) => {
                  const pos = positions.get(a.id)
                  return (
                    <li key={a.id}>
                      <button
                        ref={(el) => { rowRefs.current[a.id] = el }}
                        type="button"
                        onClick={() => { lastRowRef.current = a.id; setView({ name: 'token', assetId: a.id }) }}
                        className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-surface-hover"
                      >
                        <TokenMonogram name={a.name} size="md" />
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium text-text-primary break-words">{a.name}</span>
                          {a.symbol && <span className="block text-xs text-text-muted break-words">{a.symbol}</span>}
                        </span>
                        {pos && (
                          <span className="text-right text-xs text-text-muted flex-shrink-0">
                            <span className="block text-text-primary">{formatQuantity(pos.quantity)} held</span>
                            <span className="block">{pos.value === null ? 'No price' : `PKR ${formatDecimal(pos.value)}`}</span>
                            {pos.unrealized !== null && <span className="block">P/L {formatSigned(pos.unrealized)}</span>}
                          </span>
                        )}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </>
        )}
      </section>

      {walletSection}
    </div>
  )
}
