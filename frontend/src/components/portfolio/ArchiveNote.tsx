'use client'

import { useEffect, useState } from 'react'
import type { ArchiveResponse, Currency } from '@/lib/portfolio/types'
import { formatSigned } from '@/lib/portfolio/format'

const MAX_SHOWN = 8
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

/**
 * What stayed behind when tracking started. The earlier entries are kept (read-only) and are not part of the current
 * numbers; this explains what was reconciled and what could not be, in plain facts, and shows the earlier results
 * as partial wherever the records were. Loaded only when opened.
 */
export function ArchiveNote({ currency, load, onOpenHistory }: { currency: Currency; load: (c: Currency) => Promise<ArchiveResponse>; onOpenHistory?: () => void }) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<ArchiveResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let live = true
    setError(null)
    load(currency).then((d) => { if (live) setData(d) }).catch((e) => { if (live) setError(e instanceof Error ? e.message : 'Could not load the earlier history.') })
    return () => { live = false }
  }, [open, currency, load])

  const items = data?.discrepancies ?? []
  return (
    <section aria-labelledby="archive-heading" className="mt-3 rounded-2xl border border-border bg-surface shadow-card">
      <button
        type="button" id="archive-heading" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-sm font-semibold text-text-primary"
      >
        Earlier history
        <span aria-hidden className="text-text-muted">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-border px-4 py-3 text-sm">
          {error ? <p role="alert" className="text-danger">{error}</p>
            : !data ? <p role="status" className="text-text-muted">Loading…</p>
            : !data.period ? <p className="text-text-muted">Tracking has not started a new period for this portfolio yet.</p>
            : (
              <>
                <p className="text-text-secondary">
                  Tracking started {day(data.period.startedAt)}. {data.archivedEntries ? `${data.archivedEntries} earlier ${data.archivedEntries === 1 ? 'entry is' : 'entries are'} kept as read-only history` : 'No earlier entries'}; what you held then is carried forward with its recorded cost.
                </p>
                {data.lifetime && data.lifetime.sales > 0 && (
                  <p className="tabular-nums text-text-secondary">
                    Results from all entries, earlier and current: {data.lifetime.currency} <span className="font-semibold text-text-primary">{formatSigned(data.lifetime.knownRealized)}</span> from sales with a recorded cost
                    {data.lifetime.partial ? ` (${data.lifetime.sales - data.lifetime.salesWithUnknownResult} of ${data.lifetime.sales} sales; the rest have no complete record, so this is not your exact result)` : ''}.
                  </p>
                )}
                {items.length > 0 && (
                  <div>
                    <p className="mb-1 font-medium text-text-primary">What could not be reconciled</p>
                    <ul className="list-disc space-y-1 pl-5 text-xs text-text-secondary">
                      {items.slice(0, MAX_SHOWN).map((d, i) => <li key={i}>{d.detail}</li>)}
                    </ul>
                    {items.length > MAX_SHOWN && <p className="mt-1 text-xs text-text-muted">and {items.length - MAX_SHOWN} more.</p>}
                  </div>
                )}
                {onOpenHistory && <button type="button" onClick={onOpenHistory} className="text-xs font-semibold text-primary hover:underline">View all transactions</button>}
              </>
            )}
        </div>
      )}
    </section>
  )
}
