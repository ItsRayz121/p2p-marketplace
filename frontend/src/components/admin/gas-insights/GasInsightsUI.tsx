'use client'
import { useState, type ReactNode } from 'react'
import { RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { chainDisplayName } from '@/lib/chainDisplayName'
import {
  CATEGORY_COLOR, CATEGORY_LABEL, GAS_RANGE_OPTIONS, fmtBucket, fmtDuration, fmtInt, fmtShare, fmtUpdated,
  type CategoryRow, type Change, type DemandItem, type GasRangeKey, type NetworkDelivery,
} from '@/lib/gasInsights'

// ─── Range picker ─────────────────────────────────────────────────────────────

export function GasRangePicker({
  range, customFrom, customTo, tz, label, onChange,
}: {
  range: GasRangeKey
  customFrom: string | null
  customTo: string | null
  tz: string
  label: string
  onChange: (r: GasRangeKey, custom?: { from: string; to: string }) => void
}) {
  const [from, setFrom] = useState(customFrom ?? '')
  const [to, setTo] = useState(customTo ?? '')
  const today = new Date().toISOString().slice(0, 10)
  const apply = (f: string, t: string) => { if (f && t && f <= t) onChange('custom', { from: f, to: t }) }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Date range">
        {GAS_RANGE_OPTIONS.map((o) => (
          <button
            key={o.key}
            type="button"
            aria-pressed={range === o.key}
            onClick={() => (o.key === 'custom' ? (from && to ? apply(from, to) : onChange('custom', { from: today, to: today })) : onChange(o.key))}
            className={cn(
              'px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
              range === o.key ? 'bg-primary text-white border-primary' : 'bg-surface text-text-secondary border-border hover:bg-surface-alt',
            )}
          >
            {o.label}
          </button>
        ))}
        {range === 'custom' && (
          <span className="flex items-center gap-1.5 text-xs text-text-muted">
            <input
              type="date" aria-label="From date" value={customFrom ?? from} max={today}
              onChange={(e) => { setFrom(e.target.value); apply(e.target.value, customTo ?? to) }}
              className="border border-border rounded-lg px-2 py-1 text-xs bg-surface text-text-primary"
            />
            –
            <input
              type="date" aria-label="To date" value={customTo ?? to} max={today}
              onChange={(e) => { setTo(e.target.value); apply(customFrom ?? from, e.target.value) }}
              className="border border-border rounded-lg px-2 py-1 text-xs bg-surface text-text-primary"
            />
          </span>
        )}
      </div>
      <p className="text-[11px] text-text-muted">{label} · {tz}</p>
    </div>
  )
}

// ─── Freshness ────────────────────────────────────────────────────────────────

export function DataFreshness({
  updatedAt, stale, error, refreshing, onRefresh,
}: { updatedAt: Date | null; stale: boolean; error: string | null; refreshing: boolean; onRefresh: () => void }) {
  return (
    <div className="flex items-center gap-2 text-[11px] text-text-muted" aria-live="polite">
      {stale && <span className="text-warning font-medium">Data may be stale{error ? ` — ${error}` : ''}</span>}
      <span>Last updated {updatedAt ? fmtUpdated(updatedAt.toISOString()) : '—'}</span>
      <button
        type="button" onClick={onRefresh} aria-label="Refresh data"
        className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-border bg-surface hover:bg-surface-alt text-text-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} aria-hidden />
        Refresh
      </button>
    </div>
  )
}

// ─── Change badge + stat card ─────────────────────────────────────────────────

type Polarity = 'up-good' | 'down-good' | 'neutral'

function tone(delta: number, polarity: Polarity): string {
  if (delta === 0 || polarity === 'neutral') return 'text-text-muted'
  const good = polarity === 'up-good' ? delta > 0 : delta < 0
  return good ? 'text-success' : 'text-danger'
}
const arrow = (d: number) => (d > 0 ? '▲' : d < 0 ? '▼' : '▬')

/** Arrow + number so the meaning never depends on colour alone. */
export function ChangeBadge({ change, polarity = 'up-good', hide }: { change: Change | null | undefined; polarity?: Polarity; hide?: boolean }) {
  if (hide || !change || change.kind === 'unavailable') return null
  if (change.kind === 'new') return <span className="text-[11px] font-medium text-text-secondary" title={`Previous period: 0`}>New · prev 0</span>
  if (change.kind === 'no_prior') return <span className="text-[11px] text-text-muted">No prior activity</span>
  const pct = change.pct ?? 0
  return (
    <span className={cn('text-[11px] font-medium tabular-nums', tone(pct, polarity))} title={`Previous period: ${fmtInt(change.previous)}`}>
      {arrow(pct)} {Math.abs(pct).toFixed(1)}% <span className="font-normal text-text-muted">vs prev</span>
    </span>
  )
}

/** Percentage-point change for rates. */
export function PointBadge({ value, polarity = 'up-good' }: { value: number | null | undefined; polarity?: Polarity }) {
  if (value === null || value === undefined) return null
  return (
    <span className={cn('text-[11px] font-medium tabular-nums', tone(value, polarity))}>
      {arrow(value)} {Math.abs(value).toFixed(1)} pp <span className="font-normal text-text-muted">vs prev</span>
    </span>
  )
}

function Spark({ values, color = '#2563eb' }: { values: number[]; color?: string }) {
  if (values.length < 2) return null
  const w = 80, h = 24, pad = 2
  const max = Math.max(...values, 1)
  const step = (w - pad * 2) / (values.length - 1)
  const pts = values.map((v, i) => `${(pad + i * step).toFixed(1)},${(h - pad - ((h - pad * 2) * v) / max).toFixed(1)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden className="shrink-0">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

export function StatCard({
  label, value, hint, children, spark, info, loading, className,
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  children?: ReactNode
  spark?: number[]
  info?: string
  loading?: boolean
  className?: string
}) {
  return (
    <div className={cn('bg-surface shadow-card border border-border rounded-xl p-4 min-w-0', className)} title={info}>
      <p className="text-xs text-text-muted font-medium">{label}</p>
      <div className="mt-1 flex items-end justify-between gap-2">
        {loading
          ? <span className="h-8 w-16 rounded bg-surface-alt animate-pulse" aria-label="Loading" />
          : <p className="text-3xl font-bold text-text-primary tabular-nums leading-none">{value}</p>}
        {!loading && spark && <Spark values={spark} />}
      </div>
      <div className="mt-2 min-h-[16px] flex flex-wrap items-center gap-x-2 text-[11px] text-text-muted">{!loading && children}{!loading && hint}</div>
    </div>
  )
}

export function ChartCard({ title, subtitle, actions, children, className }: { title: string; subtitle?: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('bg-surface shadow-card border border-border rounded-xl p-4 min-w-0', className)}>
      <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
        <div>
          <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
          {subtitle && <p className="text-[11px] text-text-muted mt-0.5">{subtitle}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  )
}

export function SegmentedToggle<T extends string>({ value, options, onChange, label }: { value: T; options: { key: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="inline-flex rounded-lg border border-border overflow-hidden" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.key} type="button" aria-pressed={value === o.key} onClick={() => onChange(o.key)}
          className={cn(
            'px-2.5 py-1 text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
            value === o.key ? 'bg-primary text-white' : 'bg-surface text-text-secondary hover:bg-surface-alt',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function ChartEmpty({ message = 'No activity in this range' }: { message?: string }) {
  return <div className="h-40 flex items-center justify-center text-sm text-text-muted">{message}</div>
}

// ─── XY chart (stacked bars or lines) ─────────────────────────────────────────

export interface XYSeries { name: string; color: string; values: number[] }

function niceMax(v: number): number {
  if (v <= 4) return 4
  const p = Math.pow(10, Math.floor(Math.log10(v)))
  const f = v / p
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p
}

export function XYChart({
  kind, keys, unit, series, prev, prevName = 'Previous period', height = 220, ariaLabel, valueNote,
}: {
  kind: 'stack' | 'line'
  keys: string[]
  unit: 'hour' | 'day' | 'week'
  series: XYSeries[]
  /** Previous-period totals per bucket (same index), drawn as a dashed line. */
  prev?: (number | null)[] | null
  prevName?: string
  height?: number
  ariaLabel: string
  valueNote?: string
}) {
  const [active, setActive] = useState<number | null>(null)
  const W = height < 200 ? 1100 : 720, H = height, L = 34, R = 8, T = 8, B = 24
  const n = keys.length
  const totals = keys.map((_, i) => (kind === 'stack' ? series.reduce((a, s) => a + (s.values[i] ?? 0), 0) : Math.max(...series.map((s) => s.values[i] ?? 0), 0)))
  const hasPrev = !!prev && prev.some((v) => v !== null)
  const max = niceMax(Math.max(...totals, ...(hasPrev ? (prev as (number | null)[]).map((v) => v ?? 0) : [0]), 1))
  const iw = W - L - R, ih = H - T - B
  const slot = iw / Math.max(n, 1)
  const x = (i: number) => L + slot * i + slot / 2
  const y = (v: number) => T + ih - (v / max) * ih
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(max * f))
  const labelEvery = Math.max(1, Math.ceil(n / 7))

  const move = (d: number) => setActive((a) => Math.min(n - 1, Math.max(0, (a ?? (d > 0 ? -1 : n)) + d)))
  const pct = active === null ? 0 : (x(active) / W) * 100

  return (
    <div className="relative">
      <div
        tabIndex={0}
        role="img"
        aria-label={`${ariaLabel}. Use left and right arrow keys to inspect each point.`}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') { e.preventDefault(); move(1) }
          else if (e.key === 'ArrowLeft') { e.preventDefault(); move(-1) }
          else if (e.key === 'Escape') setActive(null)
        }}
        onBlur={() => setActive(null)}
        className="rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" onMouseLeave={() => setActive(null)}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="currentColor" className="text-border" strokeWidth="1" />
              <text x={L - 5} y={y(t) + 3} textAnchor="end" fontSize="10" className="fill-text-muted">{t}</text>
            </g>
          ))}
          {kind === 'stack' && keys.map((k, i) => {
            const bw = Math.max(2, Math.min(28, slot * 0.7))
            let acc = 0
            return (
              <g key={k}>
                {series.map((s) => {
                  const v = s.values[i] ?? 0
                  if (!v) return null
                  const top = y(acc + v)
                  const h = y(acc) - top
                  acc += v
                  return <rect key={s.name} x={x(i) - bw / 2} y={top} width={bw} height={Math.max(h, 0)} fill={s.color} opacity={active === null || active === i ? 1 : 0.55} />
                })}
              </g>
            )
          })}
          {kind === 'line' && series.map((s) => (
            <g key={s.name}>
              <polyline fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"
                points={keys.map((_, i) => `${x(i).toFixed(1)},${y(s.values[i] ?? 0).toFixed(1)}`).join(' ')} />
              {n <= 45 && keys.map((_, i) => <circle key={i} cx={x(i)} cy={y(s.values[i] ?? 0)} r={active === i ? 4 : 2} fill={s.color} />)}
            </g>
          ))}
          {hasPrev && (
            <polyline fill="none" stroke="#64748b" strokeWidth="1.5" strokeDasharray="4 3"
              points={keys.map((_, i) => (prev![i] === null || prev![i] === undefined ? null : `${x(i).toFixed(1)},${y(prev![i] as number).toFixed(1)}`)).filter(Boolean).join(' ')} />
          )}
          {keys.map((k, i) => i % labelEvery === 0 && (
            <text key={k} x={x(i)} y={H - 7} textAnchor="middle" fontSize="10" className="fill-text-muted">{fmtBucket(k, unit)}</text>
          ))}
          {active !== null && <line x1={x(active)} x2={x(active)} y1={T} y2={T + ih} stroke="#94a3b8" strokeDasharray="2 2" />}
          {keys.map((k, i) => (
            <rect key={k} x={L + slot * i} y={T} width={slot} height={ih} fill="transparent" onMouseEnter={() => setActive(i)} />
          ))}
        </svg>
      </div>
      {active !== null && (
        <div
          className="pointer-events-none absolute top-1 z-10 min-w-[150px] rounded-lg border border-border bg-surface shadow-lg px-3 py-2 text-xs"
          style={{ left: `${Math.min(80, Math.max(20, pct))}%`, transform: 'translateX(-50%)' }}
          role="status"
        >
          <p className="font-semibold text-text-primary mb-1">{fmtBucket(keys[active]!, unit)}</p>
          {series.map((s) => {
            const v = s.values[active] ?? 0
            return (
              <p key={s.name} className="flex items-center justify-between gap-3 text-text-secondary">
                <span className="inline-flex items-center gap-1.5"><span className="inline-block w-2 h-2 rounded-sm" style={{ background: s.color }} />{s.name}</span>
                <span className="tabular-nums text-text-primary">{fmtInt(v)}{kind === 'stack' && totals[active] ? ` (${fmtShare(v / totals[active]!)})` : ''}</span>
              </p>
            )
          })}
          {kind === 'stack' && <p className="flex justify-between gap-3 mt-1 pt-1 border-t border-border text-text-secondary"><span>Total</span><span className="tabular-nums text-text-primary">{fmtInt(totals[active])}</span></p>}
          {hasPrev && <p className="flex justify-between gap-3 text-text-muted"><span>{prevName}</span><span className="tabular-nums">{prev![active] === null || prev![active] === undefined ? '—' : fmtInt(prev![active])}</span></p>}
          {valueNote && <p className="mt-1 text-[10px] text-text-muted">{valueNote}</p>}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-text-secondary">
        {series.map((s) => (
          <span key={s.name} className="inline-flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: s.color }} />{s.name}</span>
        ))}
        {hasPrev && <span className="inline-flex items-center gap-1.5"><span className="inline-block w-4 border-t-2 border-dashed border-slate-500" />{prevName}</span>}
      </div>
    </div>
  )
}

// ─── Donut ────────────────────────────────────────────────────────────────────

export function CategoryDonut({ rows, centerLabel = 'orders' }: { rows: CategoryRow[]; centerLabel?: string }) {
  const [hover, setHover] = useState<string | null>(null)
  const total = rows.reduce((a, r) => a + r.count, 0)
  const R = 60, C = 2 * Math.PI * R
  let offset = 0
  const visible = rows.filter((r) => r.count > 0 || r.category !== 'unknown')
  return (
    <div className="flex flex-col sm:flex-row items-center gap-5">
      <div className="relative shrink-0">
        <svg viewBox="0 0 160 160" width="160" height="160" role="img" aria-label={`Order mix: ${rows.map((r) => `${CATEGORY_LABEL[r.category]} ${r.count}`).join(', ')}`}>
          <circle cx="80" cy="80" r={R} fill="none" stroke="currentColor" className="text-surface-alt" strokeWidth="22" />
          {total > 0 && rows.map((r) => {
            const len = (r.count / total) * C
            const el = r.count > 0 && (
              <circle
                key={r.category} cx="80" cy="80" r={R} fill="none" stroke={CATEGORY_COLOR[r.category]}
                strokeWidth={hover === r.category ? 26 : 22}
                strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-offset} transform="rotate(-90 80 80)"
                onMouseEnter={() => setHover(r.category)} onMouseLeave={() => setHover(null)}
              />
            )
            offset += len
            return el
          })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span className="text-2xl font-bold text-text-primary tabular-nums">{fmtInt(total)}</span>
          <span className="text-[11px] text-text-muted">{centerLabel}</span>
        </div>
      </div>
      <ul className="flex-1 w-full space-y-2">
        {visible.map((r) => (
          <li
            key={r.category}
            onMouseEnter={() => setHover(r.category)} onMouseLeave={() => setHover(null)}
            className={cn('flex items-center justify-between gap-3 text-sm rounded-lg px-2 py-1', hover === r.category && 'bg-surface-alt')}
            title={`${r.delivered.toLocaleString()} delivered of ${r.count.toLocaleString()}`}
          >
            <span className="inline-flex items-center gap-2 text-text-secondary">
              <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: CATEGORY_COLOR[r.category] }} />
              {CATEGORY_LABEL[r.category]}
            </span>
            <span className="tabular-nums text-text-primary font-medium">
              {fmtInt(r.count)} <span className="text-text-muted font-normal">· {fmtShare(r.share)}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Category counts with percentage share, as compact chips (used on the page summary strips). */
export function CategoryChips({ rows }: { rows: CategoryRow[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-secondary">
      {rows.filter((r) => r.category !== 'unknown' || r.count > 0).map((r) => (
        <span key={r.category} className="inline-flex items-center gap-1.5" title={`${CATEGORY_LABEL[r.category]}: ${r.count.toLocaleString()} orders`}>
          <span className="inline-block w-2 h-2 rounded-sm" style={{ background: CATEGORY_COLOR[r.category] }} />
          {CATEGORY_LABEL[r.category]} <span className="tabular-nums text-text-primary font-medium">{fmtInt(r.count)}</span>
          <span className="text-text-muted">({fmtShare(r.share)})</span>
        </span>
      ))}
    </div>
  )
}

// ─── Demand bars ──────────────────────────────────────────────────────────────

export function DemandBars({ items, usersLabel }: { items: DemandItem[]; usersLabel: string }) {
  if (items.length === 0) return <ChartEmpty message="No delivered gas in this scope" />
  const top = items.slice(0, 8)
  const max = Math.max(...top.map((i) => i.delivered), 1)
  return (
    <ul className="space-y-2.5">
      {top.map((it) => (
        <li key={`${it.asset}|${it.chain}`} title={`${it.asset} on ${chainDisplayName(it.chain)} — ${it.delivered.toLocaleString()} delivered, ${it.uniqueUsers.toLocaleString()} distinct ${usersLabel}`}>
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="text-text-primary font-medium truncate">{it.asset} <span className="text-text-muted font-normal">on {chainDisplayName(it.chain)}</span></span>
            <span className="tabular-nums text-text-secondary shrink-0">
              <span className="text-text-primary font-medium">{fmtInt(it.delivered)}</span> · {fmtShare(it.share)} · {fmtInt(it.uniqueUsers)} {usersLabel}
            </span>
          </div>
          <div className="mt-1 h-2 rounded-full bg-surface-alt overflow-hidden">
            <div className="h-full rounded-full bg-primary" style={{ width: `${(it.delivered / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  )
}

// ─── Delivery by network ──────────────────────────────────────────────────────

export function NetworkBars({ rows }: { rows: NetworkDelivery[] }) {
  if (rows.length === 0) return <ChartEmpty message="No deliveries in this range" />
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => {
        const total = r.delivered + r.failed
        return (
          <li key={r.chain} title={`Success rate = ${r.delivered} delivered / (${r.delivered} delivered + ${r.failed} failed)${r.pending ? `; ${r.pending} still pending are excluded` : ''}`}>
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="text-text-primary font-medium">{chainDisplayName(r.chain)}</span>
              <span className="tabular-nums text-text-secondary">
                <span className="text-success">{fmtInt(r.delivered)} ✓</span> · <span className={r.failed ? 'text-danger font-medium' : ''}>{fmtInt(r.failed)} ✗</span>
                {r.pending > 0 && <> · {fmtInt(r.pending)} pending</>} · {fmtDuration(r.avgCompletionSec)} · <span className="text-text-primary font-medium">{r.successRate === null ? '—' : `${Math.round(r.successRate * 100)}%`}</span>
              </span>
            </div>
            <div className="mt-1 h-2 rounded-full bg-surface-alt overflow-hidden flex">
              {total > 0 && <div className="h-full bg-success" style={{ width: `${(r.delivered / total) * 100}%` }} />}
              {total > 0 && r.failed > 0 && <div className="h-full bg-danger" style={{ width: `${(r.failed / total) * 100}%` }} />}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
