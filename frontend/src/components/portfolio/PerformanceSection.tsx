'use client'

import { useEffect, useRef, useState } from 'react'
import type { Currency, PerformanceResponse } from '@/lib/portfolio/types'
import { PERIOD_LABEL, resolvePeriod, type PeriodPreset } from '@/lib/portfolio/periods'
import { formatDecimal, formatSigned } from '@/lib/portfolio/format'
import { LineChart } from './LineChart'

const PRESETS: PeriodPreset[] = ['month', '7d', '30d', '90d', 'all', 'custom']

interface Props {
  currency: Currency
  load: (range: { currency: Currency; from?: string; to?: string }) => Promise<PerformanceResponse>
  /** Changes whenever the underlying numbers change, so the section reloads. */
  refreshKey: string
}

function Card({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="bg-surface shadow-card rounded-xl border border-border p-4">
      <p className="text-xs text-text-muted">{label}</p>
      <p className="text-base font-bold text-text-primary mt-1 break-words">{value}</p>
      {note && <p className="text-xs text-text-muted mt-1">{note}</p>}
    </div>
  )
}

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

/** Period results and charts. Everything shown comes from the user's own entries and prices. */
export function PerformanceSection({ currency, load, refreshKey }: Props) {
  const [preset, setPreset] = useState<PeriodPreset>('all')
  const [custom, setCustom] = useState({ from: '', to: '' })
  const [data, setData] = useState<PerformanceResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const seq = useRef(0)

  const resolved = resolvePeriod(preset, new Date(), custom)
  const rangeError = 'error' in resolved ? resolved.error : null
  const fromIso = 'error' in resolved ? undefined : resolved.from?.toISOString()
  const toIso = 'error' in resolved ? undefined : resolved.to.toISOString()

  useEffect(() => {
    if (rangeError) { setLoading(false); return }
    const mine = ++seq.current
    setLoading(true)
    setError(null)
    load({ currency, from: fromIso, to: toIso })
      .then((d) => { if (mine === seq.current) setData(d) })
      .catch((e) => { if (mine === seq.current) setError(e instanceof Error ? e.message : 'Could not load results for this period.') })
      .finally(() => { if (mine === seq.current) setLoading(false) })
    // `to` is "now" for presets and changes every render, so depend on the preset/custom inputs instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, custom.from, custom.to, currency, refreshKey])

  const cur = data?.currency ?? currency
  const p = data?.period

  return (
    <section aria-labelledby="performance-heading" className="space-y-3">
      <h3 id="performance-heading" className="text-sm font-semibold text-text-primary">Results over time</h3>

      <div role="radiogroup" aria-label="Period" className="flex flex-wrap gap-1.5">
        {PRESETS.map((id) => (
          <button
            key={id} type="button" role="radio" aria-checked={preset === id} onClick={() => setPreset(id)}
            className={`px-3 py-1.5 text-xs font-semibold rounded-lg border ${preset === id ? 'bg-primary text-white border-primary' : 'bg-surface text-text-secondary border-border hover:bg-surface-hover'}`}
          >
            {PERIOD_LABEL[id]}
          </button>
        ))}
      </div>

      {preset === 'custom' && (
        <div className="flex flex-wrap gap-3 items-end">
          <label className="text-xs text-text-secondary flex flex-col gap-1">
            From
            <input type="date" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-text-primary" />
          </label>
          <label className="text-xs text-text-secondary flex flex-col gap-1">
            To
            <input type="date" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-text-primary" />
          </label>
        </div>
      )}

      {rangeError ? (
        <p role="alert" className="text-sm text-danger">{rangeError}</p>
      ) : error ? (
        <p role="alert" className="text-sm text-danger">{error}</p>
      ) : loading && !data ? (
        <p role="status" className="text-sm text-text-muted">Loading results…</p>
      ) : data && p ? (
        <div className="space-y-3" aria-busy={loading}>
          <p className="text-xs text-text-muted">
            {day(data.from)} to {day(data.to)} in your device&apos;s time zone. Entries on the start day count in the starting position; entries after it count in this period.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <Card
              label="Realized in this period" value={`${cur} ${formatSigned(p.realized)}`}
              note={p.realizedComplete ? 'From sales you recorded (FIFO)' : 'Excludes sales from units with unknown cost'}
            />
            <Card label="Put in (buys and fees)" value={`${cur} ${formatDecimal(p.moneyIn)}`} />
            <Card label="Taken out (sales after fees)" value={`${cur} ${formatDecimal(p.moneyOut)}`} />
            <Card
              label="Change in value after money in/out"
              value={p.gain === null ? 'Unavailable' : `${cur} ${formatSigned(p.gain)}`}
              note={p.gain === null ? (p.gainUnavailableReason ?? undefined) : `Value ${formatDecimal(p.valueStart ?? '0')} to ${formatDecimal(p.valueEnd ?? '0')}`}
            />
          </div>

          <p className="text-xs text-text-muted">
            {p.returnPct === null
              ? 'Percentage return: unavailable. It needs a price at the start and end of the period and money invested during it, so a simple growth figure is never shown as a return.'
              : `Approximate return: ${p.returnPct}% (Modified Dietz: money added or removed during the period is weighted by how long it was invested). Not a time-weighted return or tax advice.`}
          </p>

          <LineChart
            title="Cost and realized profit over time"
            description="Remaining cost of what you held, and cumulative realized profit or loss, on each sampled date."
            currency={cur}
            emptyMessage="Record a buy or an opening holding to see this chart."
            series={[
              { name: 'Remaining cost', marker: 'circle', className: 'stroke-primary fill-primary', points: data.points.map((q) => ({ t: q.t, v: q.costBasis })) },
              { name: 'Realized profit/loss', marker: 'square', dash: '6 4', className: 'stroke-text-secondary fill-text-secondary', points: data.points.map((q) => ({ t: q.t, v: q.realized })) },
            ]}
          />
          <LineChart
            title="Marked value over time"
            description="Value of what you held, only on dates when every token you held had a price you entered."
            currency={cur}
            emptyMessage="Enter a current price on a token to see its value over time. Dates without a price stay blank rather than being estimated."
            series={[{ name: 'Marked value', marker: 'circle', className: 'stroke-primary fill-primary', points: data.points.map((q) => ({ t: q.t, v: q.value })) }]}
          />
        </div>
      ) : null}
    </section>
  )
}
