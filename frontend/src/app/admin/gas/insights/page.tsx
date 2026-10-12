'use client'
import { Suspense, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { adminApi } from '@/lib/api'
import { useLiveData } from '@/hooks/useLiveData'
import { useGasRange } from '@/hooks/useGasRange'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import {
  CATEGORY_COLOR, CATEGORY_LABEL, fmtDuration, fmtInt, fmtRate, type GasCategory, type GasInsights,
} from '@/lib/gasInsights'
import {
  CategoryDonut, ChangeBadge, ChartCard, ChartEmpty, DataFreshness, DemandBars, GasRangePicker, NetworkBars,
  PointBadge, SegmentedToggle, StatCard, XYChart,
} from '@/components/admin/gas-insights/GasInsightsUI'
import { GasFinancialKpis } from '@/components/admin/gas-insights/GasFinancialKpis'

type DemandScope = 'paid' | 'free' | 'all'
type UserView = 'gas' | 'registered'

const DEMAND_OPTIONS: { key: DemandScope; label: string }[] = [
  { key: 'paid', label: 'Paid' },
  { key: 'free', label: 'Free' },
  { key: 'all', label: 'All' },
]
const DEMAND_NOTE: Record<DemandScope, { subtitle: string; users: string }> = {
  paid: { subtitle: 'Paid, delivered purchases · token + network · orders created in range', users: 'buyers' },
  free: { subtitle: 'Free Gas grants delivered · token + network · orders created in range', users: 'recipients' },
  all: { subtitle: 'All delivered gas, paid and free · token + network · orders created in range', users: 'recipients' },
}

const CATEGORY_ORDER: GasCategory[] = ['crypto', 'pkr', 'free', 'unknown']

function AnalyticsInner() {
  const r = useGasRange()
  const [demandScope, setDemandScope] = useState<DemandScope>('paid')
  const [userView, setUserView] = useState<UserView>('gas')

  const q = useLiveData<GasInsights>(() => {
    const w = r.resolve()
    return adminApi.getGasInsights({ ...(w.from ? { from: w.from } : {}), to: w.to, tz: r.tz })
  }, `insights|${r.key}`)

  const resolved = r.resolve()
  const d = q.data
  const unit = d?.meta.bucket ?? 'day'
  const comparing = d?.meta.hasComparison ?? false

  const dailyKeys = useMemo(() => d?.daily.map((p) => p.key) ?? [], [d])
  const activitySeries = useMemo(() => {
    if (!d) return []
    const present = CATEGORY_ORDER.filter((c) => c !== 'unknown' || d.daily.some((p) => p.unknown > 0))
    return present.map((c) => ({ name: CATEGORY_LABEL[c], color: CATEGORY_COLOR[c], values: d.daily.map((p) => p[c]) }))
  }, [d])

  const hasActivity = !!d && d.headline.totalOrders.current !== 0
  const demandItems = d ? d.demand[demandScope] : []
  const registered = d?.users.registered ?? null

  return (
    <div className="space-y-5">
      {/* Title + compact controls */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-3">
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Analytics</h1>
            <Link href="/admin/gas" className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline">
              <ArrowLeft size={12} aria-hidden /> Back to Gas Operations
            </Link>
          </div>
        </div>
        <div className="flex flex-col gap-2 lg:items-end">
          <GasRangePicker
            range={r.range} customFrom={r.customFrom} customTo={r.customTo} tz={r.tz} label={resolved.label} onChange={r.setRange}
          />
          <DataFreshness updatedAt={q.updatedAt} stale={q.stale} error={q.error} refreshing={q.refreshing} onRefresh={() => { void q.refresh() }} />
        </div>
      </div>

      {q.error && !d && <ErrorState title={q.error} description="Analytics could not be loaded. This is not zero activity." onRetry={() => { void q.refresh() }} />}
      {q.loading && !d && !q.error && <LoadingState message="Loading analytics..." />}

      {d && (
        <>
          {d.meta.truncated && (
            <p className="px-4 py-2 bg-warning/10 border border-warning/20 rounded-xl text-warning text-xs">
              This range contains more orders than the analytics limit; figures cover the most recent portion only.
            </p>
          )}

          {/* Headline cards */}
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
            <StatCard label="Gas orders" value={fmtInt(d.headline.totalOrders.current)} spark={d.daily.map((p) => p.total)} info="Distinct gas orders created in the range, every status. A retried or re-attempted order counts once.">
              <ChangeBadge change={d.headline.totalOrders} hide={!comparing} />
            </StatCard>
            <StatCard label="Delivered orders" value={fmtInt(d.headline.deliveredOrders.current)} info="Orders created in the range whose gas delivery is confirmed.">
              <ChangeBadge change={d.headline.deliveredOrders} hide={!comparing} />
              {d.outcomes.pending > 0 && <span className="text-warning">{fmtInt(d.outcomes.pending)} pending</span>}
            </StatCard>
            <StatCard label="Paid purchases" value={fmtInt(d.headline.paidPurchases.current)} info="Delivered Crypto or PKR orders with confirmed settlement. Free Gas grants are excluded.">
              <ChangeBadge change={d.headline.paidPurchases} hide={!comparing} />
            </StatCard>
            <StatCard label="Unique gas users" value={fmtInt(d.headline.uniqueUsers.current)} info="Distinct recipients of deliveries confirmed in the range (delivery date basis). Not a sum of daily users.">
              <ChangeBadge change={d.headline.uniqueUsers} hide={!comparing} />
            </StatCard>
            <StatCard label="New gas users" value={fmtInt(d.headline.newUsers.current)} spark={d.users.daily.map((p) => p.newUsers)} info="Recipients whose first-ever gas delivery was confirmed in the range (delivery date basis).">
              <ChangeBadge change={d.headline.newUsers} hide={!comparing} />
            </StatCard>
            <StatCard
              label="Delivery success"
              value={fmtRate(d.headline.deliverySuccess.rate)}
              info={`Delivered ÷ (delivered + terminal delivery failures) = ${d.headline.deliverySuccess.delivered} ÷ ${d.headline.deliverySuccess.denominator}. Pending deliveries and payment failures before delivery are excluded.`}
              hint={d.headline.deliverySuccess.denominator > 0 ? <span>{fmtInt(d.headline.deliverySuccess.delivered)} of {fmtInt(d.headline.deliverySuccess.denominator)}</span> : <span>No completed deliveries</span>}
            >
              {comparing && <PointBadge value={d.headline.deliverySuccess.pointChange} />}
            </StatCard>
          </div>

          {/* Demand + growth charts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <ChartCard title="Daily activity" subtitle={`Gas orders by category · by order creation ${unit}`}>
              {hasActivity ? (
                <XYChart
                  kind="stack" keys={dailyKeys} unit={unit} series={activitySeries}
                  prev={comparing ? d.daily.map((p) => p.prevTotal) : null}
                  ariaLabel="Stacked daily gas orders by category"
                />
              ) : <ChartEmpty />}
            </ChartCard>

            <ChartCard title="Order mix" subtitle="Share of all gas orders in range · Crypto, PKR and Free Gas are mutually exclusive">
              {hasActivity ? <CategoryDonut rows={d.categories} /> : <ChartEmpty />}
              {d.freeGas.delivered > 0 && (
                <p className="mt-3 text-[11px] text-text-muted">
                  Free Gas: {fmtInt(d.freeGas.delivered)} delivered to {fmtInt(d.freeGas.uniqueRecipients)} recipients · recorded subsidy ${d.freeGas.subsidyUsd.toFixed(2)}
                </p>
              )}
            </ChartCard>

            <ChartCard
              title="Gas demand"
              subtitle={DEMAND_NOTE[demandScope].subtitle}
              actions={<SegmentedToggle label="Demand scope" value={demandScope} options={DEMAND_OPTIONS} onChange={setDemandScope} />}
            >
              <DemandBars items={demandItems} usersLabel={DEMAND_NOTE[demandScope].users} />
            </ChartCard>

            <ChartCard
              title="User growth"
              subtitle={userView === 'gas' ? `Gas users per ${unit} · by confirmed delivery date` : `Registered accounts per ${unit} · account creation, not purchases`}
              actions={
                <SegmentedToggle
                  label="User growth view" value={userView} onChange={setUserView}
                  options={[{ key: 'gas', label: 'Gas users' }, { key: 'registered', label: 'Registered' }]}
                />
              }
            >
              {userView === 'gas' ? (
                d.users.daily.some((p) => p.newUsers + p.returningUsers > 0) ? (
                  <XYChart
                    kind="line" keys={d.users.daily.map((p) => p.key)} unit={unit} ariaLabel="New and returning gas users"
                    series={[
                      { name: 'New users', color: '#2563eb', values: d.users.daily.map((p) => p.newUsers) },
                      { name: 'Returning users', color: '#7c3aed', values: d.users.daily.map((p) => p.returningUsers) },
                    ]}
                    valueNote="Distinct recipients per bucket; not additive across buckets."
                  />
                ) : <ChartEmpty message="No confirmed deliveries in this range" />
              ) : registered === null ? (
                <ChartEmpty message="Registered-user history is unavailable" />
              ) : registered.some((p) => p.count > 0) ? (
                <XYChart
                  kind="line" keys={registered.map((p) => p.key)} unit={unit} ariaLabel="New registered users"
                  series={[{ name: 'New registrations', color: '#0891b2', values: registered.map((p) => p.count) }]}
                />
              ) : <ChartEmpty message="No new registrations in this range" />}
            </ChartCard>
          </div>

          {/* Delivery performance */}
          <ChartCard title="Delivery performance" subtitle="Orders created in range · success = delivered ÷ (delivered + terminal failures); pending excluded">
            <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
              <div className="lg:col-span-2 grid grid-cols-2 gap-4 content-start">
                <div>
                  <p className="text-xs text-text-muted">Delivered</p>
                  <p className="text-2xl font-bold text-success tabular-nums">{fmtInt(d.delivery.delivered)}</p>
                </div>
                <div>
                  <p className="text-xs text-text-muted">Failed</p>
                  <p className={`text-2xl font-bold tabular-nums ${d.delivery.failed > 0 ? 'text-danger' : 'text-text-primary'}`}>{fmtInt(d.delivery.failed)}</p>
                  {comparing && <ChangeBadge change={d.delivery.failedChange} polarity="down-good" />}
                </div>
                <div>
                  <p className="text-xs text-text-muted">Success rate</p>
                  <p className="text-2xl font-bold text-text-primary tabular-nums">{fmtRate(d.delivery.successRate)}</p>
                  {comparing && <PointBadge value={d.headline.deliverySuccess.pointChange} />}
                </div>
                <div title="Order creation to confirmed delivery, for delivered orders">
                  <p className="text-xs text-text-muted">Avg completion</p>
                  <p className="text-2xl font-bold text-text-primary tabular-nums">{fmtDuration(d.delivery.avgCompletionSec)}</p>
                  {comparing && <ChangeBadge change={d.delivery.avgCompletionChange} polarity="down-good" />}
                </div>
                {d.delivery.pending > 0 && <p className="col-span-2 text-[11px] text-warning">{fmtInt(d.delivery.pending)} deliveries still in progress (not counted as failures)</p>}
              </div>
              <div className="lg:col-span-3">
                <p className="text-xs font-medium text-text-secondary mb-2">By network</p>
                <NetworkBars rows={d.delivery.byNetwork} />
              </div>
            </div>
          </ChartCard>

          {/* Money, on the same range as everything above */}
          <section aria-label="Financials" className="space-y-2">
            <h2 className="text-sm font-semibold text-text-primary">Financials <span className="text-xs font-normal text-text-muted">· same range · recorded values</span></h2>
            <GasFinancialKpis from={resolved.from} to={resolved.to} rangeKey={r.key} />
          </section>
        </>
      )}
    </div>
  )
}

export default function GasAnalyticsPage() {
  return (
    <Suspense fallback={<LoadingState message="Loading analytics..." />}>
      <AnalyticsInner />
    </Suspense>
  )
}
