'use client'

import { useEffect, useRef, useState } from 'react'
import type { Currency, PerformanceResponse } from '@/lib/portfolio/types'
import { PERIOD_LABEL, resolvePeriod, type PeriodPreset } from '@/lib/portfolio/periods'
import { formatDecimal, formatSigned } from '@/lib/portfolio/format'
import { InfoTip } from './InfoTip'
import { LineChart } from './LineChart'

const PRESETS: PeriodPreset[] = ['7d', '30d', '90d', '1y', 'all', 'custom']

interface Props {
  currency: Currency
  load: (range: { currency: Currency; from?: string; to?: string }) => Promise<PerformanceResponse>
  /** Changes whenever the underlying numbers change, so the section reloads. */
  refreshKey: string
  /** Ways to fix what an empty chart says is missing (shown only when there is something to fix). */
  onAddPrice?: () => void
  onFixCost?: () => void
}

const isZero = (s: string) => /^-?0+(\.0+)?$/.test(s)

function Card({ label, tip, value, note }: { label: string; tip: string; value: string; note?: string }) {
  return (
    <div className="bg-surface shadow-card rounded-xl border border-border p-4">
      <p className="text-xs text-text-muted">{label}<InfoTip text={tip} /></p>
      <p className="text-base font-bold text-text-primary mt-1 break-words">{value}</p>
      {note && <p className="text-xs text-text-muted mt-1">{note}</p>}
    </div>
  )
}

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

/** Period results and charts. Everything shown comes from the user's own entries and prices. */
export function PerformanceSection({ currency, load, refreshKey, onAddPrice, onFixCost }: Props) {
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

  // Say exactly what is missing when a chart has nothing to draw, instead of a generic message.
  const pts = data?.points ?? []
  const anyHeld = pts.some((q) => q.held > 0)
  const anyPriced = pts.some((q) => q.priced > 0)
  const valueEmpty = !anyHeld
    ? { message: 'You held nothing in this period, so there is no value to show.', action: null }
    : !anyPriced
      ? { message: 'No prices were recorded for what you held. Add a current price to start the value history. Dates without a price stay blank rather than being estimated.', action: 'Add a price' }
      : { message: 'On these dates at least one token you held had no price, so no total can be shown. Add the missing prices. Gaps are never estimated.', action: 'Add a price' }
  // The realized line is always known (zero before any sale), so a missing cost shows as a blank cost
  // line plus a note, rather than an empty chart.
  const costMissing = anyHeld && pts.every((q) => q.costBasis === null)

  return (
    <section aria-labelledby="performance-heading" className="space-y-3">
      <h3 id="performance-heading" className="text-sm font-semibold text-text-primary">Performance</h3>

      <div role="radiogroup" aria-label="Period" className="flex flex-wrap gap-1.5">
        {PRESETS.map((id) => (
          <button
            key={id} type="button" role="radio" aria-checked={preset === id} onClick={() => setPreset(id)}
            className={`px-3 py-1.5 text-xs font-semibold rounded-lg border ${preset === id ? 'bg-primary text-white border-primary' : 'bg-surface text-text-secondary border-border hover:bg-surface-hover'}`}
          >
            {id === 'all' && data?.tracking ? 'Since start' : PERIOD_LABEL[id]}
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
            {data.tracking ? <>Tracking began {day(data.tracking.startedAt)} · {day(data.from)} to {day(data.to)}</> : <>{day(data.from)} to {day(data.to)}</>}
            <InfoTip text={data.tracking
              ? "Shown in your device's time zone. The chart starts on the day tracking began; nothing earlier is drawn or estimated. Entries on the start day count in the starting position."
              : "Shown in your device's time zone. Entries on the start day count in the starting position; entries after it count in this period."} />
          </p>

          {data.tracking && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Card
                label="Change Since Start"
                tip="How much the value of what you hold changed, after taking out money you put in and took out. It starts from the market value on the day tracking began, which is not what you paid. Needs a price for everything you hold at both ends."
                value={p.gain === null ? 'Unavailable' : `${cur} ${formatSigned(p.gain)}`}
                note={p.gain === null ? (p.gainUnavailableReason ?? undefined) : `Value ${formatDecimal(p.valueStart ?? '0')} to ${formatDecimal(p.valueEnd ?? '0')}`}
              />
              <Card
                label="Return Since Start"
                tip="An approximate return that weights money added or removed by how long it was invested (Modified Dietz). Not a time-weighted return and not tax advice."
                value={p.returnPct === null ? 'Unavailable' : `${p.returnPct}%`}
                note={p.returnPct === null ? 'Needs a starting value and money invested.' : 'Approximate (Modified Dietz)'}
              />
            </div>
          )}

          <LineChart
            title="Portfolio Value Over Time"
            description={data.tracking
              ? 'Value of what you hold, recorded since tracking began. A date is blank when a held token had no price at that time. The latest point is the value in the summary above.'
              : "Value of what you held, only on dates when every token you held had a price: one you entered, or a proven RupChain trade price that was current then. The latest point uses today's price."}
            currency={cur}
            emptyMessage={data.tracking && pts.length === 0 ? 'No values were recorded in this range. Pick a longer range.' : valueEmpty.message}
            emptyAction={!(data.tracking && pts.length === 0) && valueEmpty.action && onAddPrice ? { label: valueEmpty.action, onClick: onAddPrice } : undefined}
            singleNote={data.tracking ? (data.tracking.startedToday ? 'Tracking started today. The chart fills in as new values are recorded; nothing is estimated for earlier days.' : 'Only one value has been recorded so far. The chart fills in as new values are recorded.') : undefined}
            series={[{ name: 'Marked value', marker: 'circle', className: 'stroke-primary fill-primary', points: data.points.map((q) => ({ t: q.t, v: q.value })) }]}
          />
          <details className="group rounded-xl border border-border bg-surface">
            <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-text-primary">Period details</summary>
            <div className="space-y-3 px-4 pb-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <Card
              label="Known Realized Profit / Loss"
              tip="Profit or loss on units you sold during this period, using FIFO. Sales whose cost is not recorded are left out."
              value={!p.realizedComplete && isZero(p.realized) ? 'Not known yet' : `${cur} ${formatSigned(p.realized)}`}
              note={p.realizedComplete ? 'From sales you recorded in this period (FIFO)' : 'Leaves out sales of units whose cost is not recorded'}
            />
            <Card
              label="Buy Costs + Fees"
              tip="Everything you paid for purchases in this period, including their fees."
              value={`${cur} ${formatDecimal(p.moneyIn)}`}
            />
            <Card
              label="Sales Proceeds After Fees"
              tip="What you received from sales in this period, after their fees."
              value={`${cur} ${formatDecimal(p.moneyOut)}`}
            />
            {!data.tracking && <Card
              label="Portfolio Value Change After Cash Flows"
              tip="How much the value of what you hold changed, after taking out the money you put in and took out. Needs a price at the start and the end of the period."
              value={p.gain === null ? 'Unavailable' : `${cur} ${formatSigned(p.gain)}`}
              note={p.gain === null ? (p.gainUnavailableReason ?? undefined) : `Value ${formatDecimal(p.valueStart ?? '0')} to ${formatDecimal(p.valueEnd ?? '0')}`}
            />}
            {!data.tracking && <Card
              label="Percentage Return"
              tip="An approximate return that weights money added or removed during the period by how long it was invested (Modified Dietz). Not a time-weighted return and not tax advice."
              value={p.returnPct === null ? 'Return unavailable' : `${p.returnPct}%`}
              note={p.returnPct === null
                ? 'Needs a price at the start and end of the period and money invested during it. A simple growth figure is never shown as a return.'
                : 'Approximate (Modified Dietz)'}
            />}
          </div>

          <LineChart
            title="Cost and Realized Profit Over Time"
            description="Remaining cost of what you held, and cumulative realized profit or loss, on each sampled date."
            currency={cur}
            emptyMessage="Record a buy or an opening holding to see this chart."
            series={[
              { name: 'Remaining cost', marker: 'circle', className: 'stroke-primary fill-primary', points: data.points.map((q) => ({ t: q.t, v: q.costBasis })) },
              { name: 'Realized profit/loss', marker: 'square', dash: '6 4', className: 'stroke-text-secondary fill-text-secondary', points: data.points.map((q) => ({ t: q.t, v: q.realized })) },
            ]}
          />
          {costMissing && (
            <p className="text-xs text-text-muted">
              The remaining-cost line is blank because the cost of what you held is not recorded. Add the cost to the opening holding or the missing purchase.
              {onFixCost && <> <button type="button" onClick={onFixCost} className="font-semibold text-primary hover:underline">Review history</button></>}
            </p>
          )}
            </div>
          </details>
        </div>
      ) : null}
    </section>
  )
}
