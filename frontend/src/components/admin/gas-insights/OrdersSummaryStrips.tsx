'use client'
import Link from 'next/link'
import { ErrorState } from '@/components/ui/ErrorState'
import {
  CATEGORY_COLOR, CATEGORY_LABEL, fmtInt, fmtShare, type PaymentsSummary, type TradesSummary,
} from '@/lib/gasInsights'
import { CategoryChips, ChangeBadge, ChartCard, ChartEmpty, StatCard, XYChart } from './GasInsightsUI'

function StripSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading summary">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-[92px] bg-surface rounded-xl border border-border animate-pulse" />)}
      </div>
      <div className="h-[200px] bg-surface rounded-xl border border-border animate-pulse" />
    </div>
  )
}

function AnalyticsLink({ href }: { href: string }) {
  return <Link href={href} className="text-xs font-medium text-primary hover:underline whitespace-nowrap">Full analytics →</Link>
}

/** Compact strip above the Gas Trades table: 4 cards + one small daily chart by category. */
export function TradesSummaryStrip({
  summary, error, onRetry, analyticsHref,
}: { summary: TradesSummary | null; error: string | null; onRetry: () => void; analyticsHref: string }) {
  if (error && !summary) return <ErrorState title="Couldn't load the summary" description={error} onRetry={onRetry} />
  if (!summary) return <StripSkeleton />
  const cmp = summary.meta.hasComparison
  const { cards, outcomes } = summary
  const unit = summary.meta.bucket
  const hasOrders = cards.orders.current !== 0
  const present = summary.categories.filter((c) => c.category !== 'unknown' || c.count > 0)
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Gas orders" value={fmtInt(cards.orders.current)} spark={summary.daily.map((p) => p.total)} info="Distinct gas orders created in the range that match the filters below, every status.">
          <ChangeBadge change={cards.orders} hide={!cmp} />
        </StatCard>
        <StatCard label="Delivered orders" value={fmtInt(cards.delivered.current)} info="Orders in this view with confirmed gas delivery.">
          <ChangeBadge change={cards.delivered} hide={!cmp} />
          {outcomes.pending > 0 && <span className="text-warning">{fmtInt(outcomes.pending)} pending</span>}
          {outcomes.failed > 0 && <span className="text-danger">{fmtInt(outcomes.failed)} failed</span>}
        </StatCard>
        <StatCard label="Unique recipients" value={fmtInt(cards.uniqueRecipients.current)} info="Distinct recipients of delivered orders in this view.">
          <ChangeBadge change={cards.uniqueRecipients} hide={!cmp} />
        </StatCard>
        <StatCard label="Free Gas delivered" value={fmtInt(cards.freeDelivered.current)} info="Free Gas grants delivered. Grants are platform-funded and are not paid purchases.">
          <ChangeBadge change={cards.freeDelivered} polarity="neutral" hide={!cmp} />
          {summary.freeGas.delivered > 0 && <span>subsidy ${summary.freeGas.subsidyUsd.toFixed(2)}</span>}
        </StatCard>
      </div>
      <ChartCard
        title="Daily gas orders by category"
        subtitle={`${unit === 'hour' ? 'Hourly' : unit === 'week' ? 'Weekly' : 'Daily'} · by order creation`}
        actions={<AnalyticsLink href={analyticsHref} />}
      >
        {hasOrders ? (
          <>
            <XYChart
              kind="stack" height={150} keys={summary.daily.map((p) => p.key)} unit={unit}
              series={present.map((c) => ({ name: CATEGORY_LABEL[c.category], color: CATEGORY_COLOR[c.category], values: summary.daily.map((p) => p[c.category]) }))}
              prev={cmp ? summary.daily.map((p) => p.prevTotal) : null}
              ariaLabel="Daily gas orders by category"
            />
            <div className="mt-2"><CategoryChips rows={summary.categories} /></div>
          </>
        ) : <ChartEmpty message="No gas orders match these filters" />}
      </ChartCard>
    </div>
  )
}

/** Compact strip above the Payment Orders list: settled payments by method. */
export function PaymentsSummaryStrip({
  summary, error, onRetry, analyticsHref,
}: { summary: PaymentsSummary | null; error: string | null; onRetry: () => void; analyticsHref: string }) {
  if (error && !summary) return <ErrorState title="Couldn't load the summary" description={error} onRetry={onRetry} />
  if (!summary) return <StripSkeleton />
  const cmp = summary.meta.hasComparison
  const { cards } = summary
  const unit = summary.meta.bucket
  const hasSettled = (cards.settled.current ?? 0) > 0
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Payment orders" value={fmtInt(cards.paymentOrders.current)} info="Customer-paid gas orders created in the range that match the filters. Free Gas grants are not payments.">
          <ChangeBadge change={cards.paymentOrders} hide={!cmp} />
          {summary.pendingPayment > 0 && <span className="text-warning">{fmtInt(summary.pendingPayment)} awaiting payment</span>}
        </StatCard>
        <StatCard label="Settled payments" value={fmtInt(cards.settled.current)} info="Payment orders whose payment was accepted (including ones later refunded).">
          <ChangeBadge change={cards.settled} hide={!cmp} />
        </StatCard>
        <StatCard label="Crypto settled" value={fmtInt(cards.settledCrypto.current)} info="Settled payments funded with crypto (including exchange transfers).">
          <ChangeBadge change={cards.settledCrypto} polarity="neutral" hide={!cmp} />
          <span>{fmtShare(summary.shares.crypto)} of settled</span>
        </StatCard>
        <StatCard label="PKR settled" value={fmtInt(cards.settledPkr.current)} info="Settled payments funded by PKR bank transfer.">
          <ChangeBadge change={cards.settledPkr} polarity="neutral" hide={!cmp} />
          <span>{fmtShare(summary.shares.pkr)} of settled</span>
        </StatCard>
      </div>
      <ChartCard
        title="Daily settled payments by method"
        subtitle={`${unit === 'hour' ? 'Hourly' : unit === 'week' ? 'Weekly' : 'Daily'} · by order creation`}
        actions={<AnalyticsLink href={analyticsHref} />}
      >
        {hasSettled ? (
          <XYChart
            kind="stack" height={150} keys={summary.daily.map((p) => p.key)} unit={unit}
            series={[
              { name: 'Crypto', color: CATEGORY_COLOR.crypto, values: summary.daily.map((p) => p.crypto) },
              { name: 'PKR', color: CATEGORY_COLOR.pkr, values: summary.daily.map((p) => p.pkr) },
            ]}
            prev={cmp ? summary.daily.map((p) => p.prevSettled) : null}
            ariaLabel="Daily settled payments by method"
          />
        ) : <ChartEmpty message="No settled payments match these filters" />}
      </ChartCard>
    </div>
  )
}
