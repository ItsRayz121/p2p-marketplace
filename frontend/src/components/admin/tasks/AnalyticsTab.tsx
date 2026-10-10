'use client'
import { useEffect, useMemo, useState } from 'react'
import { adminPlatformTaskApi, type Analytics } from '@/lib/platformTasks'
import { TrendBars } from '@/components/admin/charts/TrendBars'
import { HBars } from '@/components/admin/charts/HBars'
import { RANGES, rangeOf } from './shared'

const pct = (n: number | null) => (n == null ? 'No decisions yet' : `${Math.round(n * 100)}%`)
const hours = (h: number | null) => (h == null ? 'No reviews yet' : h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} d`)

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4 shadow-card">
      <p className="text-xs font-semibold text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums text-text-primary">{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-text-muted">{sub}</p>}
    </div>
  )
}

export function AnalyticsTab({ range, setRange }: { range: string; setRange: (r: string) => void }) {
  const [data, setData] = useState<Analytics | null>(null)
  const [error, setError] = useState<string | null>(null)
  const period = useMemo(() => rangeOf(range), [range])

  useEffect(() => {
    let off = false
    setData(null)
    adminPlatformTaskApi.analytics(period).then((d) => { if (!off) { setData(d); setError(null) } }).catch((e) => { if (!off) setError(e instanceof Error ? e.message : 'Could not load analytics') })
    return () => { off = true }
  }, [period])

  const label = RANGES.find((r) => r.key === range)?.label ?? `${range} days`
  const daily = useMemo(() => (data?.daily ?? []).map((d) => ({ date: d.day.slice(5), submitted: d.submitted, approved: d.approved, rejected: d.rejected, needs_changes: d.needs_changes })), [data])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1.5" role="group" aria-label="Period">
          {RANGES.map((r) => (
            <button key={r.key} type="button" aria-pressed={range === r.key} onClick={() => setRange(r.key)}
              className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${range === r.key ? 'border-primary bg-primary text-white' : 'border-border bg-surface text-text-secondary hover:bg-surface-alt'}`}>{r.label}</button>
          ))}
        </div>
        <p className="text-xs text-text-muted">All figures cover the last {label}. Current backlog and unpaid balances are on the summary row and Rewards tab, not here.</p>
      </div>

      {error && <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
      {!data && !error && <div className="grid gap-3 sm:grid-cols-3">{[0, 1, 2].map((i) => <div key={i} className="h-24 animate-pulse rounded-xl border border-border bg-surface" />)}</div>}

      {data && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Kpi label="Submissions" value={data.totals.submitted.toLocaleString()} sub="Including resubmissions" />
            <Kpi label="Approved" value={data.totals.approved.toLocaleString()} sub="Decisions made in the period" />
            <Kpi label="Approval rate" value={pct(data.totals.approvalRate)} sub={`Approved ÷ (approved + rejected). ${data.totals.rejected} rejected, ${data.totals.needsChanges} sent back.`} />
            <Kpi label="Median review time" value={hours(data.medianReviewHours)} sub={`Manual reviews decided in the period (${data.reviewedCount})`} />
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <Kpi label="Points credited" value={data.rewards.pointsCredited.toLocaleString()} sub="Claims approved in the period" />
            <Kpi label="USDT approved, unpaid" value={`$${data.rewards.usdtApprovedAwaitingPayment.toFixed(2)}`} sub="Approved in the period, payment still pending" />
            <Kpi label="USDT paid or credited" value={`$${data.rewards.usdtSettled.toFixed(2)}`} sub="Approved in the period and settled" />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-xl border border-border bg-surface p-4 shadow-card">
              <h3 className="text-sm font-semibold text-text-primary">Submissions per day</h3>
              <p className="mb-2 text-xs text-text-muted">New and re-submitted evidence.</p>
              {data.totals.submitted === 0 ? <p className="py-8 text-center text-sm text-text-muted">No submissions in this period.</p>
                : <TrendBars data={daily} series={[{ key: 'submitted', label: 'Submitted', className: 'fill-primary' }]} unit="submissions" />}
            </section>
            <section className="rounded-xl border border-border bg-surface p-4 shadow-card">
              <h3 className="text-sm font-semibold text-text-primary">Decisions per day</h3>
              <p className="mb-2 text-xs text-text-muted">By the day the decision was made.</p>
              {data.totals.approved + data.totals.rejected + data.totals.needsChanges === 0 ? <p className="py-8 text-center text-sm text-text-muted">No decisions in this period.</p>
                : <TrendBars data={daily} series={[
                  { key: 'approved', label: 'Approved', className: 'fill-success' },
                  { key: 'needs_changes', label: 'Changes requested', className: 'fill-info' },
                  { key: 'rejected', label: 'Rejected', className: 'fill-danger' },
                ]} unit="decisions" />}
            </section>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-xl border border-border bg-surface p-4 shadow-card">
              <h3 className="text-sm font-semibold text-text-primary">Claims by platform</h3>
              <p className="mb-3 text-xs text-text-muted">New claims in the period.</p>
              <HBars data={data.byPlatform.map((p) => ({ id: p.platform, label: p.platform, value: p.claims }))} format={(n) => String(n ?? 0)} emptyText="No claims in this period." />
            </section>
            <section className="rounded-xl border border-border bg-surface p-4 shadow-card">
              <h3 className="text-sm font-semibold text-text-primary">Most-claimed tasks</h3>
              <p className="mb-3 text-xs text-text-muted">New claims in the period.</p>
              <HBars data={data.perTask.slice(0, 6).map((t) => ({ id: t.id, label: t.title, sublabel: `${t.approved} approved · ${t.pending} open`, value: t.claims }))} format={(n) => String(n ?? 0)} emptyText="No claims in this period." />
            </section>
          </div>

          <section className="overflow-hidden rounded-xl border border-border bg-surface shadow-card">
            <div className="border-b border-border px-4 py-3"><h3 className="text-sm font-semibold text-text-primary">Task performance</h3><p className="text-xs text-text-muted">Claims created in the period, by outcome so far.</p></div>
            {data.perTask.length === 0 ? <p className="p-8 text-center text-sm text-text-muted">No claims in this period.</p> : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs font-semibold text-text-secondary"><tr><th className="px-4 py-2.5">Task</th><th className="px-3 py-2.5 text-right">Claims</th><th className="px-3 py-2.5 text-right">Approved</th><th className="px-3 py-2.5 text-right">Rejected</th><th className="px-3 py-2.5 text-right">Open</th><th className="px-3 py-2.5 text-right">Approval rate</th></tr></thead>
                  <tbody className="divide-y divide-border">
                    {data.perTask.map((t) => (
                      <tr key={t.id}><td className="px-4 py-2.5 font-medium text-text-primary">{t.title}</td><td className="px-3 py-2.5 text-right tabular-nums">{t.claims}</td><td className="px-3 py-2.5 text-right tabular-nums">{t.approved}</td><td className="px-3 py-2.5 text-right tabular-nums">{t.rejected}</td><td className="px-3 py-2.5 text-right tabular-nums">{t.pending}</td><td className="px-3 py-2.5 text-right tabular-nums">{t.approvalRate == null ? '—' : `${Math.round(t.approvalRate * 100)}%`}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}
