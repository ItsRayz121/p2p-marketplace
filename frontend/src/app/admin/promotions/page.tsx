'use client'
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Info } from 'lucide-react'
import { adminApi, type PromoCampaignRow, type PromoProgramKey, type PromoProgramSummary, type PromotionsOverview } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Badge, type BadgeVariant } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { PromotionsNav } from '@/components/admin/promotions/PromotionsNav'
import { TrendBars } from '@/components/admin/charts/TrendBars'
import { HBars } from '@/components/admin/charts/HBars'
import { BudgetBar } from '@/components/admin/charts/BudgetBar'
import { cn } from '@/lib/utils'

const RANGES = [
  { v: '7', label: '7 days' },
  { v: '30', label: '30 days' },
  { v: '90', label: '90 days' },
  { v: 'all', label: 'All time' },
] as const
type RangeV = (typeof RANGES)[number]['v']

const PROGRAM_PAGE: Record<PromoProgramKey, string> = {
  promo_code: '/admin/gas/promo-codes',
  free_code: '/admin/gas/free-codes',
  giveaway: '/admin/gas/giveaways',
  community_giveaway: '/admin/promo-giveaways',
  direct_free_gas: '/admin/gas/free-gas',
  share_reward: '/admin/gas/share-rewards',
}
const PROGRAM_LABEL: Record<PromoProgramKey, string> = {
  promo_code: 'Promo code', free_code: 'Free-gas code', giveaway: 'Gas giveaway',
  community_giveaway: 'Community giveaway', direct_free_gas: 'Direct free gas', share_reward: 'Share & Earn',
}

const usd = (n: number | null | undefined, digits = 2) => (n == null ? 'Not tracked' : `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`)
const statusVariant = (s: string): BadgeVariant => (s === 'active' || s === 'open' ? 'success' : s === 'expired' ? 'warning' : s === 'drawn' || s === 'closed' ? 'default' : 'danger')

export default function PromotionsOverviewPage() {
  return (
    <Suspense fallback={<LoadingState message="Loading promotions..." />}>
      <Inner />
    </Suspense>
  )
}

function Inner() {
  const router = useRouter()
  const params = useSearchParams()
  const range = (RANGES.find((r) => r.v === params.get('days'))?.v ?? '30') as RangeV
  const program = (params.get('program') as PromoProgramKey | null) ?? null
  const sort = params.get('sort') === 'redemptions' ? 'redemptions' : 'net'

  const [data, setData] = useState<PromotionsOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<PromoCampaignRow | null>(null)

  const setParam = useCallback((k: string, v: string | null) => {
    const q = new URLSearchParams(params.toString())
    if (v == null || v === '' || (k === 'days' && v === '30')) q.delete(k)
    else q.set(k, v)
    const qs = q.toString()
    router.replace(qs ? `/admin/promotions?${qs}` : '/admin/promotions', { scroll: false })
  }, [params, router])

  const load = useCallback(async () => {
    try {
      setData(await adminApi.getPromotionsOverview(range === 'all' ? 'all' : (Number(range) as 7 | 30 | 90)))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load promotions')
    }
  }, [range])
  usePolling(load, 60_000)
  useEffect(() => { void load() }, [load])

  const rangeLabel = RANGES.find((r) => r.v === range)!.label

  const visible = useMemo(() => {
    const rows = (data?.campaigns ?? []).filter((c) => !program || c.program === program)
    return rows
  }, [data, program])

  const ranked = useMemo(() => {
    const eligible = visible.filter((c) => !c.insufficientData && (sort === 'net' ? c.netContributionUsdt != null : true))
    const key = (c: PromoCampaignRow) => (sort === 'net' ? (c.netContributionUsdt ?? 0) : c.redemptions)
    const sorted = [...eligible].sort((a, b) => key(b) - key(a))
    return { sorted, top: sorted.slice(0, 5), bottom: sorted.length > 5 ? sorted.slice(-3).reverse() : [] }
  }, [visible, sort])

  if (error && !data) return <ErrorState title={error} onRetry={load} />
  if (!data) return <LoadingState message="Loading promotions..." />

  const p = data.programs
  const allPrograms = Object.values(p)
  const activeCampaigns = allPrograms.reduce((s, x) => s + x.active, 0)
  const expiredCampaigns = allPrograms.reduce((s, x) => s + x.expired, 0)
  const disabledCampaigns = allPrograms.reduce((s, x) => s + x.disabled, 0)

  const kpis: Array<{ label: string; value: string; sub: string; href: string; tone?: string }> = [
    { label: 'Campaigns & codes', value: String(data.totals.campaigns), sub: `${activeCampaigns} active · ${expiredCampaigns} expired · ${disabledCampaigns} disabled`, href: '#campaigns' },
    { label: 'Redemptions', value: String(data.totals.redemptions), sub: `${rangeLabel} · promo ${p.promo_code.redemptions}, free ${p.free_code.redemptions + p.direct_free_gas.redemptions + p.giveaway.redemptions}`, href: '#trend' },
    { label: 'Attributable completed orders', value: String(data.totals.completedOrders), sub: `${data.totals.refundedOrders} refunded/reversed — excluded from margin`, href: '/admin/payment-orders?status=delivered' },
    { label: 'Actual reward cost', value: usd(data.totals.rewardCostUsdt), sub: 'Delivered orders only · not the committed budget', href: '#spend', tone: 'text-warning' },
    { label: 'Attributable gross margin', value: usd(data.totals.grossMarginUsdt), sub: 'Platform margin before discounts · payment volume excluded', href: '#programs' },
    { label: 'Net contribution (tracked)', value: usd(data.totals.netTrackedContributionUsdt), sub: `Promo codes + Share & Earn · after ${usd(data.totals.freeProgramCostUsdt)} free-program cost: ${usd(data.totals.netAfterFreeProgramsUsdt)}`, href: '#programs', tone: data.totals.netTrackedContributionUsdt < 0 ? 'text-danger' : 'text-success' },
  ]

  const spendRows = [
    { id: 'promo_code', label: 'Promo codes', spent: p.promo_code.spentUsdt, budget: p.promo_code.budgetUsdt },
    { id: 'free_code', label: 'Free-gas codes', spent: p.free_code.spentUsdt, budget: p.free_code.budgetUsdt },
    { id: 'giveaway', label: 'Gas giveaways', spent: p.giveaway.spentUsdt, budget: null },
    { id: 'direct_free_gas', label: 'Direct free gas', spent: p.direct_free_gas.spentUsdt, budget: null },
    { id: 'share_reward', label: 'Share & Earn', spent: p.share_reward.spentUsdt, budget: null },
  ]

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Promotions</h1>
          <p className="mt-0.5 text-sm text-text-muted">Every reward program in one place — what it cost, what it redeemed, and what it contributed.</p>
        </div>
        <div role="group" aria-label="Date range" className="inline-flex rounded-xl border border-border bg-surface p-1">
          {RANGES.map((r) => (
            <button
              key={r.v}
              type="button"
              aria-pressed={range === r.v}
              onClick={() => setParam('days', r.v)}
              className={cn('rounded-lg px-3 py-1.5 text-sm font-medium transition-colors', range === r.v ? 'bg-primary text-white shadow-sm' : 'text-text-secondary hover:bg-surface-alt')}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <PromotionsNav active="overview" />

      {/* KPI cards — each opens the relevant records */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        {kpis.map((k) => (
          <Link
            key={k.label}
            href={k.href.startsWith('#') ? `/admin/promotions${params.toString() ? `?${params.toString()}` : ''}${k.href}` : k.href}
            className="rounded-xl border border-border bg-surface p-4 shadow-card transition-all hover:border-primary/40 hover:shadow-card-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <p className="text-[11px] font-medium uppercase tracking-wide text-text-muted">{k.label}</p>
            <p className={cn('mt-1 text-2xl font-bold tabular-nums text-text-primary', k.tone)}>{k.value}</p>
            <p className="mt-1 text-[11px] leading-snug text-text-muted">{k.sub}</p>
          </Link>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section id="trend" className="scroll-mt-4 rounded-xl border border-border bg-surface p-4 shadow-card">
          <h2 className="text-sm font-semibold text-text-primary">Redemption trend</h2>
          <p className="mb-3 text-xs text-text-muted">Daily redemptions, last {data.trend.length} days (UTC)</p>
          <TrendBars
            data={data.trend}
            series={[
              { key: 'promo', label: 'Promo codes', className: 'fill-primary' },
              { key: 'free', label: 'Free-gas codes', className: 'fill-success' },
              { key: 'freeGrants', label: 'Direct / giveaway free gas', className: 'fill-warning' },
              { key: 'shareReward', label: 'Share & Earn used', className: 'fill-info' },
            ]}
          />
        </section>

        <section id="spend" className="scroll-mt-4 rounded-xl border border-border bg-surface p-4 shadow-card">
          <h2 className="text-sm font-semibold text-text-primary">Actual spend vs budget</h2>
          <p className="mb-3 text-xs text-text-muted">Spent = reserved against the cap so far. Committed budget is the cap, not money spent.</p>
          <ul className="space-y-3">
            {spendRows.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-4">
                <Link href={PROGRAM_PAGE[r.id as PromoProgramKey]} className="text-sm font-medium text-text-primary hover:text-primary hover:underline">{r.label}</Link>
                <BudgetBar spent={r.spent} budget={r.budget} />
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section id="programs" className="scroll-mt-4 overflow-hidden rounded-xl border border-border bg-surface shadow-card">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-text-primary">Programs</h2>
          <p className="text-xs text-text-muted">Different programs fund rewards differently — they are separate on purpose and only compared on cost and contribution here.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs font-medium text-text-muted">
              <tr>
                <th className="px-4 py-2.5">Program</th><th className="px-4 py-2.5">Funding</th><th className="px-4 py-2.5 text-right">Active / total</th>
                <th className="px-4 py-2.5 text-right">Redemptions</th><th className="px-4 py-2.5 text-right">Completed orders</th>
                <th className="px-4 py-2.5 text-right">Reward cost</th><th className="px-4 py-2.5 text-right">Net contribution</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {allPrograms.map((x: PromoProgramSummary) => (
                <tr key={x.key} className="hover:bg-surface-alt/40">
                  <td className="px-4 py-2.5"><Link href={PROGRAM_PAGE[x.key]} className="font-medium text-primary hover:underline">{x.label}</Link></td>
                  <td className="px-4 py-2.5 text-xs text-text-secondary">{x.funding}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{x.active} / {x.total}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{x.redemptions}{x.uniqueRedeemers != null && <span className="text-xs text-text-muted"> ({x.uniqueRedeemers} unique)</span>}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{x.completedOrders}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{usd(x.rewardCostUsdt)}</td>
                  <td className={cn('px-4 py-2.5 text-right tabular-nums', (x.netContributionUsdt ?? 0) < 0 && 'text-danger')}>{usd(x.netContributionUsdt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-border bg-surface p-4 shadow-card">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-text-primary">{sort === 'net' ? 'Campaign contribution' : 'Campaign redemptions'}</h2>
              <p className="text-xs text-text-muted">Ranked by <strong>{sort === 'net' ? 'net contribution (USD)' : 'redemptions'}</strong> · {rangeLabel} · campaigns with fewer than {data.minSample} redemptions are not ranked</p>
            </div>
            <div role="group" aria-label="Ranking metric" className="inline-flex rounded-lg border border-border p-0.5 text-xs">
              {(['net', 'redemptions'] as const).map((m) => (
                <button key={m} type="button" aria-pressed={sort === m} onClick={() => setParam('sort', m === 'net' ? null : m)}
                  className={cn('rounded-md px-2.5 py-1 font-medium', sort === m ? 'bg-primary text-white' : 'text-text-secondary hover:bg-surface-alt')}>
                  {m === 'net' ? 'Net contribution' : 'Redemptions'}
                </button>
              ))}
            </div>
          </div>
          <HBars
            data={ranked.sorted.slice(0, 8).map((c) => ({
              id: `${c.program}:${c.id}`, label: c.name, sublabel: PROGRAM_LABEL[c.program],
              value: sort === 'net' ? c.netContributionUsdt : c.redemptions,
            }))}
            format={sort === 'net' ? (n) => usd(n) : (n) => String(n)}
            onSelect={(id) => setSelected(visible.find((c) => `${c.program}:${c.id}` === id) ?? null)}
            emptyText="Not enough data yet — no campaign has reached the minimum sample in this range."
          />
        </section>

        <section className="rounded-xl border border-border bg-surface p-4 shadow-card">
          <h2 className="text-sm font-semibold text-text-primary">Best and lowest performers</h2>
          <p className="mb-3 text-xs text-text-muted">By {sort === 'net' ? 'net contribution' : 'redemptions'} · {rangeLabel}. Newer campaigns with little data are never shown as poor performers.</p>
          {ranked.sorted.length === 0 ? (
            <p className="py-6 text-center text-sm text-text-muted">Insufficient data: no campaign has {data.minSample}+ redemptions in this range.</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-success">Best</p>
                <ol className="space-y-1.5 text-sm">
                  {ranked.top.map((c, i) => (
                    <li key={`${c.program}:${c.id}`}><button type="button" onClick={() => setSelected(c)} className="flex w-full items-center justify-between gap-2 rounded-md px-1.5 py-1 text-left hover:bg-surface-alt/60">
                      <span className="truncate"><span className="mr-1 text-text-muted">{i + 1}.</span>{c.name}</span>
                      <span className="tabular-nums text-text-secondary">{sort === 'net' ? usd(c.netContributionUsdt) : c.redemptions}</span>
                    </button></li>
                  ))}
                </ol>
              </div>
              <div>
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-danger">Lowest</p>
                {ranked.bottom.length === 0 ? <p className="text-xs text-text-muted">Not enough campaigns to compare.</p> : (
                  <ol className="space-y-1.5 text-sm">
                    {ranked.bottom.map((c) => (
                      <li key={`${c.program}:${c.id}`}><button type="button" onClick={() => setSelected(c)} className="flex w-full items-center justify-between gap-2 rounded-md px-1.5 py-1 text-left hover:bg-surface-alt/60">
                        <span className="truncate">{c.name}</span>
                        <span className="tabular-nums text-text-secondary">{sort === 'net' ? usd(c.netContributionUsdt) : c.redemptions}</span>
                      </button></li>
                    ))}
                  </ol>
                )}
              </div>
            </div>
          )}
        </section>
      </div>

      <section id="campaigns" className="scroll-mt-4 overflow-hidden rounded-xl border border-border bg-surface shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-text-primary">All campaigns &amp; codes <span className="font-normal text-text-muted">({visible.length})</span></h2>
          <label className="text-xs text-text-muted">
            <span className="sr-only">Filter by program</span>
            <select
              value={program ?? ''}
              onChange={(e) => setParam('program', e.target.value || null)}
              className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <option value="">All programs</option>
              {(['promo_code', 'free_code', 'giveaway', 'community_giveaway'] as const).map((k) => <option key={k} value={k}>{PROGRAM_LABEL[k]}</option>)}
            </select>
          </label>
        </div>
        {visible.length === 0 ? (
          <p className="py-10 text-center text-sm text-text-muted">No campaigns yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs font-medium text-text-muted">
                <tr>
                  <th className="px-4 py-2.5">Campaign</th><th className="px-4 py-2.5">Program</th><th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5 text-right">Redemptions</th><th className="px-4 py-2.5 text-right">Reward cost</th>
                  <th className="px-4 py-2.5 text-right">Net</th><th className="px-4 py-2.5">Budget</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {visible.map((c) => (
                  <tr key={`${c.program}:${c.id}`} tabIndex={0} onClick={() => setSelected(c)} onKeyDown={(e) => { if (e.key === 'Enter') setSelected(c) }}
                    className="cursor-pointer hover:bg-surface-alt/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary">
                    <td className="px-4 py-2.5"><p className="font-mono text-xs font-semibold text-text-primary">{c.name}</p>{c.label && <p className="text-[11px] text-text-muted">{c.label}</p>}</td>
                    <td className="px-4 py-2.5 text-xs text-text-secondary">{PROGRAM_LABEL[c.program]}</td>
                    <td className="px-4 py-2.5"><Badge variant={statusVariant(c.status)} size="sm">{c.status}</Badge></td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{c.redemptions}{c.insufficientData && <span className="ml-1 text-[10px] text-text-muted" title={`Fewer than ${data.minSample} redemptions`}>low data</span>}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{usd(c.rewardCostUsdt)}</td>
                    <td className={cn('px-4 py-2.5 text-right tabular-nums', (c.netContributionUsdt ?? 0) < 0 && 'text-danger')}>{usd(c.netContributionUsdt)}</td>
                    <td className="px-4 py-2.5"><BudgetBar spent={c.spentUsdt} budget={c.budgetUsdt} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <details className="rounded-xl border border-border bg-surface p-4 text-sm text-text-secondary shadow-card">
        <summary className="flex cursor-pointer items-center gap-2 font-semibold text-text-primary"><Info className="h-4 w-4 text-primary" aria-hidden /> How these numbers are calculated, and what is not tracked</summary>
        <dl className="mt-3 space-y-2 text-xs leading-relaxed">
          <div><dt className="inline font-semibold text-text-primary">Reward cost — </dt><dd className="inline">only delivered orders count. Promo codes and Share &amp; Earn: the margin discount given. Free-gas codes, giveaways and direct free gas: the gas value delivered.</dd></div>
          <div><dt className="inline font-semibold text-text-primary">Gross margin — </dt><dd className="inline">the platform margin recorded on delivered orders before any discount. Customer payment volume (which includes the pass-through gas cost) is never counted as revenue.</dd></div>
          <div><dt className="inline font-semibold text-text-primary">Net contribution — </dt><dd className="inline">gross margin − reward cost − affiliate commission accrued on the same orders. Each is subtracted once; commissions and discounts both come out of margin, never the base gas cost.</dd></div>
          <div><dt className="inline font-semibold text-text-primary">Committed vs spent — </dt><dd className="inline">a budget is a cap an admin set. &quot;Spent&quot; is what the system has reserved against that cap, which can exceed delivered cost while orders are in flight.</dd></div>
          <div><dt className="inline font-semibold text-text-primary">Attribution — </dt><dd className="inline">an order is attributed when it used the code. That shows association, not that the code caused the sale, so no sales uplift is claimed.</dd></div>
          <div><dt className="inline font-semibold text-text-primary">Not tracked — </dt><dd className="inline">free-gas codes, giveaways and direct free gas have no attributable revenue recorded; gas giveaway budgets are set as winners × native amount, not in USD; community giveaways move no platform funds. These show &quot;Not tracked&quot; rather than a guess.</dd></div>
          <div><dt className="inline font-semibold text-text-primary">Low data — </dt><dd className="inline">campaigns under {data.minSample} redemptions are listed but not ranked as best or lowest.</dd></div>
        </dl>
      </details>

      <Modal isOpen={!!selected} onClose={() => setSelected(null)} title={selected ? `${PROGRAM_LABEL[selected.program]} — ${selected.name}` : ''} size="md">
        {selected && (
          <div className="space-y-4">
            {selected.label && <p className="text-sm text-text-secondary">{selected.label}</p>}
            <dl className="grid grid-cols-2 gap-3 text-sm">
              {([
                ['Status', selected.status],
                ['Redemptions', `${selected.redemptions}${selected.uniqueRedeemers ? ` (${selected.uniqueRedeemers} unique)` : ''}`],
                ['Completed orders', String(selected.completedOrders)],
                ['Refunded / reversed orders', String(selected.refundedOrders)],
                ['Gross margin', usd(selected.grossMarginUsdt)],
                ['Reward cost', usd(selected.rewardCostUsdt)],
                ['Affiliate commission', usd(selected.commissionUsdt)],
                ['Net contribution', usd(selected.netContributionUsdt)],
              ] as const).map(([k, v]) => (
                <div key={k} className="rounded-lg bg-surface-alt/60 p-2.5"><dt className="text-[11px] text-text-muted">{k}</dt><dd className="font-semibold text-text-primary tabular-nums">{v}</dd></div>
              ))}
            </dl>
            <div><p className="mb-1 text-xs text-text-muted">Budget</p><BudgetBar spent={selected.spentUsdt} budget={selected.budgetUsdt} /></div>
            {selected.insufficientData && <p className="rounded-lg border border-warning/30 bg-warning/10 p-2.5 text-xs text-warning">Insufficient data: fewer than {data.minSample} redemptions in {rangeLabel.toLowerCase()}, so averages and rankings would be misleading.</p>}
            <Link href={PROGRAM_PAGE[selected.program]} className="inline-block text-sm font-medium text-primary hover:underline">Manage in {PROGRAM_LABEL[selected.program]} →</Link>
          </div>
        )}
      </Modal>
    </div>
  )
}
