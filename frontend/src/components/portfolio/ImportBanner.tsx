'use client'

import { useState } from 'react'
import type { ImportReport } from '@/lib/portfolio/types'
import { formatDecimal, formatQuantity } from '@/lib/portfolio/format'

interface Props {
  /** Preview of what would change (from a dry run). */
  report: ImportReport
  busy: boolean
  error: string | null
  onImport: () => void
  onDismiss: () => void
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * Shown when there are RupChain trades to add (first time: needs an explicit yes). Trades that were
 * deliberately NOT added are handled in the Review center. Nothing here changes a trade, a wallet or a payout.
 */
export function ImportBanner({ report, busy, error, onImport, onDismiss }: Props) {
  const [open, setOpen] = useState(false)
  const toAdd = report.created + report.restored
  if (toAdd === 0 && report.skippedForLimit === 0) return null

  return (
    <section aria-label="RupChain trades" className="rounded-xl border border-border bg-surface p-4 space-y-3">
      {toAdd > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-semibold text-text-primary">
            {plural(toAdd, 'completed RupChain trade is', 'completed RupChain trades are')} ready to add to your tracker
          </p>
          <p className="text-xs text-text-muted">
            Only trades that finished normally are listed: confirmed by the buyer, with a verified token transfer where the trade was on-chain.
            This copies a record into your private tracker. It does not change the trade, your wallet or any payment.
          </p>
          {report.preview.length > 0 && (
            <>
              <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="text-xs font-medium text-primary hover:underline">
                {open ? 'Hide the trades' : 'Review the trades'}
              </button>
              {open && (
                <ul className="text-xs text-text-secondary divide-y divide-border rounded-lg border border-border">
                  {report.preview.map((p) => (
                    <li key={p.tradeRef} className="px-3 py-2 flex flex-wrap justify-between gap-2">
                      <span className="break-words">{p.type === 'BUY' ? 'Bought' : 'Sold'} {formatQuantity(p.quantity)} {p.tokenName}</span>
                      <span>{formatDecimal(p.consideration)} {p.quote} · {new Date(p.date).toLocaleDateString()} · {p.tradeRef}</span>
                    </li>
                  ))}
                  {report.created > report.preview.length && (
                    <li className="px-3 py-2 text-text-muted">and {report.created - report.preview.length} more</li>
                  )}
                </ul>
              )}
            </>
          )}
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <div className="flex gap-2">
            <button type="button" disabled={busy} onClick={onImport} className="px-3 py-2 text-sm font-semibold rounded-lg bg-primary text-white disabled:opacity-60">
              {busy ? 'Adding…' : 'Add these trades'}
            </button>
            <button type="button" disabled={busy} onClick={onDismiss} className="px-3 py-2 text-sm font-semibold rounded-lg border border-border text-text-secondary hover:bg-surface-hover">
              Not now
            </button>
          </div>
        </div>
      )}

      {report.skippedForLimit > 0 && (
        <p role="alert" className="text-xs text-amber-800">
          {plural(report.skippedForLimit, 'trade was', 'trades were')} skipped because you reached the tracker limit.
        </p>
      )}
    </section>
  )
}
