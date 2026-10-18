'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { EventListQuery, EventsPage, HistoryEvent, PortfolioEventType } from '@/lib/portfolio/types'
import { D } from '@/lib/portfolio/engine/decimal'
import { formatDecimal, formatQuantity, isZeroAmount } from '@/lib/portfolio/format'
import { VOID_TEXT } from '@/lib/portfolio/importText'
import { Pager } from './Pager'

export const HISTORY_PAGE_SIZE = 25
const SEARCH_DELAY_MS = 300

const TYPE_LABEL: Record<PortfolioEventType, string> = { BUY: 'Buy', SELL: 'Sell', OPENING: 'Opening holding' }

/** Price per token for a buy or sell, from the recorded totals (exact decimal; never for an opening holding). */
export function unitPrice(e: Pick<HistoryEvent, 'type' | 'quantity' | 'consideration'>): string | null {
  if (e.type === 'OPENING' || e.consideration === null || isZeroAmount(e.quantity)) return null
  return formatQuantity(new D(e.consideration).div(e.quantity).toDecimalPlaces(8).toFixed())
}

/** What the entry moved: paid including the fee for a buy, received after the fee for a sell. */
export function totalValue(e: Pick<HistoryEvent, 'type' | 'consideration' | 'fee' | 'basis' | 'zeroCost'>): string | null {
  if (e.type === 'OPENING') return e.zeroCost ? '0' : e.basis
  if (e.consideration === null) return null
  const fee = new D(e.fee ?? '0')
  return (e.type === 'BUY' ? new D(e.consideration).plus(fee) : new D(e.consideration).minus(fee)).toFixed()
}

const selectCls = 'rounded-lg border border-border bg-surface text-text-primary text-sm px-2.5 py-2 focus:outline-none focus:ring-2 focus:ring-primary/30'

/**
 * Every entry across all tokens in one searchable, filterable, paged table. Entries you typed in are
 * kept apart from those read from RupChain trades, and an entry that is shown but not counted says why.
 */
export function TransactionHistory({
  load, onBack, onOpenToken, backRef,
}: {
  load: (query: EventListQuery) => Promise<EventsPage>
  onBack: () => void
  onOpenToken: (assetId: string) => void
  backRef?: React.RefObject<HTMLButtonElement>
}) {
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  const [type, setType] = useState<'' | PortfolioEventType>('')
  const [source, setSource] = useState<'' | 'manual' | 'ctm' | 'p2p'>('')
  const [status, setStatus] = useState<'' | 'counted' | 'not_counted'>('')
  const [offset, setOffset] = useState(0)
  const [page, setPage] = useState<EventsPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)

  // Typing waits a moment before searching, and a new search starts from the first page.
  useEffect(() => {
    const id = setTimeout(() => { setQ(search.trim()); setOffset(0) }, SEARCH_DELAY_MS)
    return () => clearTimeout(id)
  }, [search])

  const reload = useCallback(async () => {
    setError(null)
    const query: EventListQuery = { limit: HISTORY_PAGE_SIZE, offset }
    if (q) query.q = q
    if (type) query.type = type
    if (source) query.source = source
    if (status) query.status = status
    // Only the newest request may update the screen, so a slow older search cannot overwrite a newer one.
    const mine = ++seq.current
    try { const r = await load(query); if (mine === seq.current) setPage(r) }
    catch (e) { if (mine === seq.current) setError(e instanceof Error ? e.message : 'Could not load your transactions.') }
  }, [load, offset, q, type, source, status])
  useEffect(() => { void reload() }, [reload])

  const filtered = Boolean(q || type || source || status)
  const change = <T,>(set: (v: T) => void) => (v: T) => { set(v); setOffset(0) }

  return (
    <div className="space-y-4">
      <button ref={backRef} type="button" onClick={onBack} className="text-sm font-medium text-primary hover:underline">← Back to portfolio</button>
      <h2 id="tracked-portfolio-heading" className="text-base font-semibold text-text-primary">All transactions</h2>

      <div className="flex flex-wrap gap-2" role="search" aria-label="Filter transactions">
        <label className="sr-only" htmlFor="tx-search">Search by token or note</label>
        <input
          id="tx-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search token or note" maxLength={60}
          className="min-w-[10rem] flex-1 rounded-lg border border-border bg-surface text-text-primary text-sm px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
        <label className="sr-only" htmlFor="tx-type">Type</label>
        <select id="tx-type" className={selectCls} value={type} onChange={(e) => change(setType)(e.target.value as typeof type)}>
          <option value="">All types</option><option value="BUY">Buys</option><option value="SELL">Sells</option><option value="OPENING">Opening holdings</option>
        </select>
        <label className="sr-only" htmlFor="tx-source">Source</label>
        <select id="tx-source" className={selectCls} value={source} onChange={(e) => change(setSource)(e.target.value as typeof source)}>
          <option value="">All sources</option><option value="manual">Entered by me</option><option value="ctm">RupChain trades</option>
        </select>
        <label className="sr-only" htmlFor="tx-status">Status</label>
        <select id="tx-status" className={selectCls} value={status} onChange={(e) => change(setStatus)(e.target.value as typeof status)}>
          <option value="">Counted and not counted</option><option value="counted">Counted</option><option value="not_counted">Not counted</option>
        </select>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger">{error} <button type="button" onClick={() => void reload()} className="font-medium text-primary hover:underline">Try again</button></p>
      ) : page === null ? (
        <p role="status" className="text-sm text-text-muted">Loading your transactions…</p>
      ) : page.total === 0 ? (
        <p className="text-sm text-text-muted">{filtered ? 'Nothing matches these filters.' : 'No transactions yet.'}</p>
      ) : (
        <>
          <div className="bg-surface shadow-card rounded-xl border border-border overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Your recorded transactions across all tokens</caption>
              <thead>
                <tr className="text-left text-xs text-text-muted border-b border-border">
                  <th scope="col" className="px-3 py-2 font-medium">Date</th>
                  <th scope="col" className="px-3 py-2 font-medium">Token</th>
                  <th scope="col" className="px-3 py-2 font-medium">Type</th>
                  <th scope="col" className="px-3 py-2 font-medium text-right">Quantity</th>
                  <th scope="col" className="px-3 py-2 font-medium text-right">Unit price</th>
                  <th scope="col" className="px-3 py-2 font-medium text-right">Fee</th>
                  <th scope="col" className="px-3 py-2 font-medium text-right">Total</th>
                  <th scope="col" className="px-3 py-2 font-medium">Source</th>
                  <th scope="col" className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {page.items.map((e) => {
                  const unit = unitPrice(e)
                  const total = totalValue(e)
                  return (
                    <tr key={e.id}>
                      <td className="px-3 py-2 whitespace-nowrap">{new Date(e.occurredAt).toLocaleDateString()}</td>
                      <td className="px-3 py-2 break-words max-w-[10rem]">
                        <button type="button" className="text-primary hover:underline text-left" onClick={() => onOpenToken(e.assetId)}>{e.assetName}</button>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">{TYPE_LABEL[e.type]}</td>
                      <td className="px-3 py-2 text-right">{formatQuantity(e.quantity)}</td>
                      <td className="px-3 py-2 text-right">{unit === null ? '—' : `${unit} ${e.quote}`}</td>
                      <td className="px-3 py-2 text-right">{e.fee && !isZeroAmount(e.fee) ? `${formatDecimal(e.fee)} ${e.quote}` : '—'}</td>
                      <td className="px-3 py-2 text-right">
                        {total === null ? <span className="text-text-muted">Cost not recorded</span> : `${formatDecimal(total)} ${e.quote}`}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {e.source !== 'manual' ? 'RupChain trade' : 'Entered by me'}
                        {e.priceBasis && <span className="block text-xs text-text-muted">{e.priceBasis === 'platform' ? 'RupChain price' : 'Price I got'}</span>}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {e.voided
                          ? <span className="text-amber-800">Not counted: {VOID_TEXT[e.voidReason ?? ''] ?? 'it no longer qualifies'}</span>
                          : e.archived
                            ? <span className="text-text-secondary" title="From before tracking started. Kept for the record; what you held then is carried forward as your opening holdings.">Earlier history</span>
                            : <span className="text-text-secondary">Counted</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <Pager offset={offset} pageSize={HISTORY_PAGE_SIZE} total={page.total} onChange={setOffset} />
        </>
      )}
    </div>
  )
}
