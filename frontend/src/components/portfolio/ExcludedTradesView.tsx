'use client'

import { useCallback, useEffect, useState } from 'react'
import type { Currency, ExcludedTrade, ExcludedTradesPage, PortfolioEventInput } from '@/lib/portfolio/types'
import { ATTENTION_TEXT } from '@/lib/portfolio/importText'
import { formatDecimal, formatQuantity } from '@/lib/portfolio/format'
import { EventForm } from './EventForm'
import { Pager } from './Pager'

export const EXCLUDED_PAGE_SIZE = 25

interface Props {
  load: (limit: number, offset: number) => Promise<ExcludedTradesPage>
  /** Record one trade by hand. The server links the entry to the trade so it is never counted twice. */
  onRecord: (tradeId: string, input: PortfolioEventInput) => Promise<void>
  onBack: () => void
  backRef?: React.RefObject<HTMLButtonElement>
  /** The portfolio currency, used when a trade has no amount in its own currency. */
  currency: Currency
}

/**
 * RupChain trades that were not added to the tracker automatically. A trade status alone does not
 * prove both sides were settled, so nothing here is counted until the user confirms it. Recording a
 * trade only writes a note in the user's own tracker: the trade itself is never touched.
 */
export function ExcludedTradesView({ load, onRecord, onBack, backRef, currency }: Props) {
  const [offset, setOffset] = useState(0)
  const [page, setPage] = useState<ExcludedTradesPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [recording, setRecording] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setError(null)
    try { setPage(await load(EXCLUDED_PAGE_SIZE, offset)) }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load your trades.') }
  }, [load, offset])
  useEffect(() => { void reload() }, [reload])

  const target: ExcludedTrade | undefined = page?.items.find((t) => t.tradeId === recording)

  return (
    <div className="space-y-4">
      <button ref={backRef} type="button" onClick={onBack} className="text-sm font-medium text-primary hover:underline">← Back to portfolio</button>
      <h2 id="tracked-portfolio-heading" className="text-base font-semibold text-text-primary">RupChain trades not added automatically</h2>
      <p className="text-xs text-text-muted">
        A trade status alone does not prove that both sides were settled, so these trades are left out of your totals.
        If you really did buy or sell, you can record it yourself. That only adds a note to your own tracker. It does not change the trade, your wallet or any payment.
      </p>

      {error ? (
        <p role="alert" className="text-sm text-danger">{error} <button type="button" onClick={() => void reload()} className="font-medium text-primary hover:underline">Try again</button></p>
      ) : page === null ? (
        <p role="status" className="text-sm text-text-muted">Loading your trades…</p>
      ) : page.total === 0 ? (
        <p className="text-sm text-text-muted">Every one of your finished RupChain trades is already counted. Nothing was left out.</p>
      ) : (
        <>
          <div className="bg-surface shadow-card rounded-xl border border-border overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">RupChain trades that were left out of automatic tracking</caption>
              <thead>
                <tr className="text-left text-xs text-text-muted border-b border-border">
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
                          onClick={() => setRecording(t.tradeId)}
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
        <div className="bg-surface shadow-card rounded-xl border border-border p-5 space-y-3">
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
            onSubmit={async (input) => { await onRecord(target.tradeId, input); setRecording(null); await reload() }}
          />
        </div>
      )}
    </div>
  )
}
