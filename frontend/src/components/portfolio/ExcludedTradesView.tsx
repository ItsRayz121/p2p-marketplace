'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { BatchReport, BatchSelection, Currency, ExcludedTrade, ExcludedTradesPage, PortfolioEventInput } from '@/lib/portfolio/types'
import { ATTENTION_TEXT } from '@/lib/portfolio/importText'
import { formatDecimal, formatQuantity } from '@/lib/portfolio/format'
import { EventForm } from './EventForm'
import { Pager } from './Pager'

export const EXCLUDED_PAGE_SIZE = 25

interface Props {
  load: (limit: number, offset: number) => Promise<ExcludedTradesPage>
  /** Record one trade by hand. The server links the entry to the trade so it is never counted twice. */
  onRecord: (tradeId: string, input: PortfolioEventInput) => Promise<void>
  /** Record many trades at once with the amounts RupChain holds for them. Safe to repeat. */
  onRecordBatch?: (selection: BatchSelection) => Promise<BatchReport>
  onBack: () => void
  backRef?: React.RefObject<HTMLButtonElement>
  /** The portfolio currency, used when a trade has no amount in its own currency. */
  currency: Currency
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * RupChain trades that were not added to the tracker automatically. A trade status alone does not
 * prove both sides were settled, so nothing here is counted until the user confirms it. Recording a
 * trade only writes a note in the user's own tracker: the trade itself is never touched.
 */
export function ExcludedTradesView({ load, onRecord, onRecordBatch, onBack, backRef, currency }: Props) {
  const [offset, setOffset] = useState(0)
  const [page, setPage] = useState<ExcludedTradesPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [recording, setRecording] = useState<string | null>(null)
  const seq = useRef(0)
  const formRef = useRef<HTMLDivElement>(null)
  const confirmRef = useRef<HTMLDivElement>(null)
  const [done, setDone] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirming, setConfirming] = useState<BatchSelection | null>(null)
  const [sure, setSure] = useState(false)
  const [busy, setBusy] = useState(false)
  const [batchError, setBatchError] = useState<string | null>(null)
  const [report, setReport] = useState<BatchReport | null>(null)

  const reload = useCallback(async () => {
    setError(null)
    const mine = ++seq.current
    try { const r = await load(EXCLUDED_PAGE_SIZE, offset); if (mine === seq.current) setPage(r) }
    catch (e) { if (mine === seq.current) setError(e instanceof Error ? e.message : 'Could not load your trades.') }
  }, [load, offset])
  useEffect(() => { void reload() }, [reload])

  const target: ExcludedTrade | undefined = page?.items.find((t) => t.tradeId === recording)
  // The form sits below the list, so bring it into view when a trade is picked.
  useEffect(() => {
    if (target) formRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
  }, [target?.tradeId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (confirming) confirmRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
  }, [confirming])

  const recordable = page?.items.filter((t) => t.canRecord && !t.recorded) ?? []
  const recordableTotal = page ? (page.recordable ?? recordable.length) : 0
  const allOnPageSelected = recordable.length > 0 && recordable.every((t) => selected.has(t.tradeId))
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const togglePage = () => setSelected((s) => {
    const n = new Set(s)
    if (allOnPageSelected) recordable.forEach((t) => n.delete(t.tradeId))
    else recordable.forEach((t) => n.add(t.tradeId))
    return n
  })

  const askConfirm = (sel: BatchSelection) => { setReport(null); setBatchError(null); setDone(null); setSure(false); setConfirming(sel) }
  const confirmCount = !confirming ? 0 : 'all' in confirming ? recordableTotal : confirming.tradeIds.length

  async function runBatch() {
    if (!confirming || !onRecordBatch || busy || !sure) return
    setBusy(true)
    setBatchError(null)
    try {
      const r = await onRecordBatch(confirming)
      setReport(r)
      setConfirming(null)
      setSelected(new Set())
      await reload()
      window.scrollTo?.({ top: 0, behavior: 'smooth' })
    } catch (e) {
      setBatchError(e instanceof Error ? e.message : 'Could not record these trades. Nothing was lost; please try again.')
    } finally {
      setBusy(false)
    }
  }

  const problems = report?.results.filter((r) => r.outcome === 'failed' || r.outcome === 'skipped') ?? []
  const failedIds = report?.results.filter((r) => r.outcome === 'failed').map((r) => r.tradeId) ?? []

  return (
    <div className="space-y-4">
      <button ref={backRef} type="button" onClick={onBack} className="text-sm font-medium text-primary hover:underline">← Back to review</button>
      <h2 id="tracked-portfolio-heading" className="text-lg font-semibold text-text-primary">Trades to review</h2>
      <p className="text-xs text-text-muted">
        A trade status alone does not prove both sides were settled, so these trades are left out of your totals.
        If you really did buy or sell, record it. That only adds a note to your own tracker. It does not change the trade, your wallet or any payment.
      </p>

      {done && <p role="status" className="text-sm text-success bg-success/10 border border-success/30 rounded-lg px-3 py-2">{done}</p>}

      {report && (
        <div role="status" className="rounded-xl border border-border bg-surface px-4 py-3 space-y-2 text-sm">
          <p className="font-semibold text-text-primary">Recorded {plural(report.recorded, 'trade', 'trades')}</p>
          <p className="text-xs text-text-secondary">
            {[
              report.alreadyRecorded > 0 && `${report.alreadyRecorded} already recorded`,
              report.skipped > 0 && `${report.skipped} skipped`,
              report.failed > 0 && `${report.failed} could not be saved`,
            ].filter(Boolean).join(' · ') || 'Everything went through.'}
          </p>
          {problems.length > 0 && (
            <ul className="text-xs text-text-muted list-disc pl-5">
              {problems.map((r) => <li key={r.tradeId}>{r.tradeRef}: {r.message ?? (r.outcome === 'skipped' ? 'Skipped' : 'Failed')}</li>)}
            </ul>
          )}
          {failedIds.length > 0 && onRecordBatch && (
            <button type="button" onClick={() => askConfirm({ tradeIds: failedIds })} className="text-xs font-semibold text-primary hover:underline">Try the failed ones again</button>
          )}
        </div>
      )}

      {error ? (
        <p role="alert" className="text-sm text-danger">{error} <button type="button" onClick={() => void reload()} className="font-medium text-primary hover:underline">Try again</button></p>
      ) : page === null ? (
        <p role="status" className="text-sm text-text-muted">Loading your trades…</p>
      ) : page.total === 0 ? (
        <p className="text-sm text-text-muted">Every one of your finished RupChain trades is already counted. Nothing was left out.</p>
      ) : (
        <>
          {onRecordBatch && recordableTotal > 0 && (
            <div className="flex flex-wrap items-center gap-3">
              {selected.size > 0 ? (
                <button type="button" onClick={() => askConfirm({ tradeIds: [...selected] })} className="rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-white hover:opacity-90">
                  Record selected ({selected.size})
                </button>
              ) : (
                <button type="button" onClick={() => askConfirm({ all: true })} className="rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-white hover:opacity-90">
                  Record all ({recordableTotal})
                </button>
              )}
              {selected.size > 0 && <button type="button" onClick={() => setSelected(new Set())} className="text-xs font-medium text-text-secondary hover:underline">Clear selection</button>}
            </div>
          )}

          {confirming && (
            <div ref={confirmRef} role="region" aria-label="Confirm recording" className="rounded-xl border border-border bg-surface p-4 space-y-3 shadow-card">
              <h3 className="text-sm font-semibold text-text-primary">Record {plural(confirmCount, 'trade', 'trades')} in your portfolio?</h3>
              <p className="text-xs text-text-secondary">
                Each one is recorded as a buy or a sell, with the amounts RupChain holds for it. Trades in or after a dispute, or closed automatically,
                are not proof that both sides were settled. Record only trades you really made. Trades you already recorded are never added twice.
              </p>
              <label className="flex items-start gap-2 text-sm text-text-primary">
                <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} className="mt-1" />
                <span>I really made these trades and want them counted in my portfolio.</span>
              </label>
              {batchError && <p role="alert" className="text-sm text-danger">{batchError}</p>}
              <div className="flex gap-2 justify-end">
                <button type="button" onClick={() => setConfirming(null)} disabled={busy} className="px-4 py-2 text-sm font-semibold rounded-lg border border-border text-text-secondary hover:bg-surface-hover disabled:opacity-60">Cancel</button>
                <button type="button" onClick={() => void runBatch()} disabled={!sure || busy} className="px-4 py-2 text-sm font-semibold rounded-lg bg-primary text-white disabled:opacity-60">
                  {busy ? 'Recording…' : `Record ${plural(confirmCount, 'trade', 'trades')}`}
                </button>
              </div>
            </div>
          )}

          <div className="bg-surface shadow-card rounded-xl border border-border overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">RupChain trades that were left out of automatic tracking</caption>
              <thead>
                <tr className="text-left text-xs text-text-muted border-b border-border">
                  {onRecordBatch && (
                    <th scope="col" className="pl-3 py-2 w-8">
                      <input type="checkbox" aria-label="Select all trades on this page" checked={allOnPageSelected} disabled={recordable.length === 0} onChange={togglePage} />
                    </th>
                  )}
                  <th scope="col" className="px-3 py-2 font-medium">Trade</th>
                  <th scope="col" className="px-3 py-2 font-medium">Token</th>
                  <th scope="col" className="px-3 py-2 font-medium">You</th>
                  <th scope="col" className="px-3 py-2 font-medium text-right">Quantity</th>
                  <th scope="col" className="px-3 py-2 font-medium text-right">Amount</th>
                  <th scope="col" className="px-3 py-2 font-medium">Date</th>
                  <th scope="col" className="px-3 py-2 font-medium">Why it was left out</th>
                  <th scope="col" className="px-3 py-2 font-medium"><span className="sr-only">Action</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {page.items.map((t) => (
                  <tr key={t.tradeId}>
                    {onRecordBatch && (
                      <td className="pl-3 py-2">
                        {t.canRecord && !t.recorded && (
                          <input type="checkbox" aria-label={`Select trade ${t.tradeRef}`} checked={selected.has(t.tradeId)} onChange={() => toggle(t.tradeId)} />
                        )}
                      </td>
                    )}
                    <td className="px-3 py-2 whitespace-nowrap">{t.tradeRef}</td>
                    <td className="px-3 py-2 break-words max-w-[10rem]">{t.tokenName}</td>
                    <td className="px-3 py-2">{t.side === 'BUY' ? 'Bought' : 'Sold'}</td>
                    <td className="px-3 py-2 text-right">{formatQuantity(t.quantity)}</td>
                    <td className="px-3 py-2 text-right">{t.consideration === null ? 'Not shown' : `${formatDecimal(t.consideration)} ${t.quote ?? currency}`}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{t.date ? new Date(t.date).toLocaleDateString() : '—'}</td>
                    <td className="px-3 py-2 text-xs text-text-secondary max-w-[14rem]">{ATTENTION_TEXT[t.reason]}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-right">
                      {t.recorded ? (
                        <span className="text-xs text-text-muted">Recorded by you</span>
                      ) : t.canRecord ? (
                        <button
                          type="button" className="text-primary font-medium hover:underline"
                          onClick={() => { setDone(null); setReport(null); setConfirming(null); setRecording(t.tradeId) }}
                          aria-label={`Record trade ${t.tradeRef} by hand`}
                        >
                          Record it
                        </button>
                      ) : (
                        <span className="text-xs text-text-muted">{t.reason === 'in_progress' ? 'Not finished yet' : 'Cannot be recorded'}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Pager offset={offset} pageSize={EXCLUDED_PAGE_SIZE} total={page.total} onChange={(o) => { setRecording(null); setOffset(o) }} />
        </>
      )}

      {target && (
        <div ref={formRef} className="bg-surface shadow-card rounded-xl border border-border p-5 space-y-3">
          <h3 className="text-sm font-semibold text-text-primary">Record trade {target.tradeRef}</h3>
          <EventForm
            assetName={target.tokenName}
            lockType
            prefill={{
              type: target.side,
              quantity: target.quantity,
              ...(target.consideration !== null ? { consideration: target.consideration } : {}),
              quote: target.quote,
              ...(target.date ? { occurredAt: target.date } : {}),
            }}
            extraNotice="Check these values against what really happened and change them if you paid or received something different. This trade can be recorded once."
            onCancel={() => setRecording(null)}
            onSubmit={async (input) => {
              await onRecord(target.tradeId, input)
              setDone(`Recorded trade ${target.tradeRef} in your portfolio.`)
              setRecording(null)
              await reload()
              window.scrollTo?.({ top: 0, behavior: 'smooth' })
            }}
          />
        </div>
      )}
    </div>
  )
}
