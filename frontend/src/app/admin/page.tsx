'use client'
import { useState, useCallback } from 'react'
import Link from 'next/link'
import { adminApi, type AdminNotifCategory } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { cn } from '@/lib/utils'
import {
  ShieldCheck, AlertTriangle, Wallet, Fuel, FileText,
  TrendingUp, BarChart2, Users, PackageCheck, DollarSign, ArrowDownToLine,
} from 'lucide-react'

type Stats = Awaited<ReturnType<typeof adminApi.getStats>>
type StatsRange = 'today' | '7d' | '30d' | '1y' | 'all'

// Time-frame tabs for the period KPIs. `label` is the tab text; `prefix` is
// woven into each card title so "Today's Trade Volume" becomes "7-Day Trade
// Volume" etc. when the range changes.
const RANGE_TABS: { value: StatsRange; label: string; prefix: string }[] = [
  { value: 'today', label: 'Today',    prefix: "Today's" },
  { value: '7d',    label: '7 Days',   prefix: '7-Day' },
  { value: '30d',   label: '1 Month',  prefix: '30-Day' },
  { value: '1y',    label: '1 Year',   prefix: '1-Year' },
  { value: 'all',   label: 'All Time', prefix: 'All-Time' },
]

const CATEGORY_COLORS: Record<AdminNotifCategory, string> = {
  KYC:        'bg-blue-500/15 text-blue-700 dark:text-blue-300',
  TRADE:      'bg-purple-500/15 text-purple-700 dark:text-purple-300',
  GAS:        'bg-orange-500/15 text-orange-700 dark:text-orange-300',
  DISPUTE:    'bg-red-500/15 text-red-700 dark:text-red-300',
  CTM:        'bg-teal-500/15 text-teal-700 dark:text-teal-300',
  SYSTEM:     'bg-surface-alt text-text-secondary',
  DEPOSIT:    'bg-green-500/15 text-green-700 dark:text-green-300',
  WITHDRAWAL: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
}

function greeting() {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

function fmt(n: string | number) {
  return Number(n).toLocaleString('en-PK')
}

export default function AdminDashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [error, setError]   = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const [range, setRange] = useState<StatsRange>('today')

  const fetchStats = useCallback(async (r: StatsRange = range) => {
    try {
      const data = await adminApi.getStats(r)
      setStats(data)
      setError(null)
      setLastRefresh(new Date())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load stats')
    } finally {
      setLoading(false)
    }
  }, [range])

  usePolling(fetchStats, 30_000)

  const changeRange = (r: StatsRange) => {
    if (r === range) return
    setRange(r)
    fetchStats(r)
  }

  const rangePrefix = RANGE_TABS.find((t) => t.value === range)?.prefix ?? "Today's"

  if (loading) return <LoadingState message="Loading dashboard…" />
  if (error && !stats) return <ErrorState title={error} onRetry={fetchStats} />

  const actionCards = [
    { label: 'Pending KYC',        value: stats?.pendingKyc ?? 0,          href: '/admin/kyc',        urgent: (stats?.pendingKyc ?? 0) > 0,          icon: <ShieldCheck className="w-4 h-4" /> },
    { label: 'Open Disputes',      value: stats?.openDisputes ?? 0,        href: '/admin/disputes',   urgent: (stats?.openDisputes ?? 0) > 0,        icon: <AlertTriangle className="w-4 h-4" /> },
    { label: 'Pending Withdrawals',value: stats?.pendingWithdrawals ?? 0,  href: '/admin/withdrawals',urgent: (stats?.pendingWithdrawals ?? 0) > 0,  icon: <Wallet className="w-4 h-4" /> },
    { label: 'Gas Orders Active',  value: stats?.pendingGasOrders ?? 0,    href: '/admin/gas',        urgent: (stats?.pendingGasOrders ?? 0) > 0,    icon: <Fuel className="w-4 h-4" /> },
    { label: 'PKR Proofs Pending', value: stats?.pkrGasProofsPending ?? 0, href: '/admin/gas',        urgent: (stats?.pkrGasProofsPending ?? 0) > 0, icon: <FileText className="w-4 h-4" /> },
  ]

  const todayCards = [
    { label: `${rangePrefix} Trade Volume`,     value: `PKR ${fmt(stats?.todayVolumePkr ?? 0)}`,                       sub: 'PKR settled in completed trades', color: 'text-text-primary',  icon: <BarChart2 className="w-5 h-5 text-text-muted" /> },
    { label: `${rangePrefix} Trades`,           value: fmt(stats?.todayTrades ?? 0),                                   sub: 'trades started',         color: 'text-primary',       icon: <BarChart2 className="w-5 h-5 text-primary" /> },
    { label: `${rangePrefix} New Users`,        value: fmt(stats?.newUsersToday ?? 0),                                  sub: 'users registered',             color: 'text-violet-600 dark:text-violet-400',    icon: <Users className="w-5 h-5 text-violet-600 dark:text-violet-400" /> },
    { label: `${rangePrefix} Gas Orders`,       value: fmt(stats?.todayGasOrders ?? 0),                                 sub: 'gas fee orders',         color: 'text-orange-600 dark:text-orange-400',    icon: <Fuel className="w-5 h-5 text-orange-500" /> },
    { label: `${rangePrefix} Gas Volume`,       value: `$${stats?.todayGasVolumeUsdt ?? '0.00'} USDT`,                 sub: 'gross paid by users (cost + fee)', color: 'text-orange-600 dark:text-orange-400',  icon: <Fuel className="w-5 h-5 text-orange-500" /> },
    { label: `${rangePrefix} Gas Revenue`,      value: `$${stats?.todayGasRevenueUsdt ?? '0.00'} USDT`,                sub: 'platform margin (fee only)',   color: 'text-success',       icon: <TrendingUp className="w-5 h-5 text-success" /> },
    { label: `${rangePrefix} Withdrawals Sent`, value: fmt((stats as any)?.todaySentWithdrawals ?? 0),                  sub: 'withdrawals completed',  color: 'text-primary',       icon: <PackageCheck className="w-5 h-5 text-primary" /> },
    { label: `${rangePrefix} Withdrawal Fees`,  value: `${(stats as any)?.todayWithdrawalFeesUsdt ?? '0.000000'} USDT`,sub: 'fee revenue from withdrawals', color: 'text-success',       icon: <ArrowDownToLine className="w-5 h-5 text-success" /> },
  ]

  const totalCards = [
    { label: 'Total Users',              value: fmt(stats?.totalUsers ?? 0) },
    { label: 'Total Trades',             value: fmt(stats?.totalTrades ?? 0) },
    { label: 'Total Volume PKR',          value: `PKR ${fmt(stats?.totalVolumePkr ?? 0)}` },
    { label: 'Total Gas Orders',          value: fmt(stats?.totalGasOrders ?? 0) },
    { label: 'Total Gas Volume',          value: `$${stats?.totalGasVolumeUsdt ?? '0.00'} USDT` },
    { label: 'Total Gas Revenue',         value: `$${stats?.totalGasRevenueUsdt ?? '0.00'} USDT` },
    { label: 'Total Withdrawals Sent',    value: fmt((stats as any)?.totalSentWithdrawals ?? 0) },
    { label: 'Total Withdrawal Fees',     value: `${(stats as any)?.totalWithdrawalFeesUsdt ?? '0.000000'} USDT` },
  ]

  const quickLinks = [
    { label: 'Users',         href: '/admin/users' },
    { label: 'Trades',        href: '/admin/trades' },
    { label: 'Disputes',      href: '/admin/disputes' },
    { label: 'KYC Queue',     href: '/admin/kyc' },
    { label: 'Merchant KYC',  href: '/admin/merchant-kyc' },
    { label: 'Withdrawals',   href: '/admin/withdrawals' },
    { label: 'Ratings',      href: '/admin/ratings' },
    { label: 'Wallet',        href: '/admin/wallet' },
    { label: 'Gas Fee',       href: '/admin/gas' },
    { label: 'CTM',           href: '/admin/ctm' },
    { label: 'Analytics',     href: '/admin/analytics' },
    { label: 'Audit Log',     href: '/admin/audit-log' },
    { label: 'Config',        href: '/admin/config' },
    { label: 'Notifications', href: '/admin/notifications' },
  ]

  const urgentCount = actionCards.filter((c) => c.urgent).length

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">{greeting()}</h1>
          <p className="text-text-muted text-sm mt-0.5">
            {urgentCount > 0
              ? `${urgentCount} area${urgentCount > 1 ? 's' : ''} need your attention`
              : 'Everything looks good — no pending actions'}
          </p>
        </div>
        {lastRefresh && (
          <p className="text-[11px] text-text-muted self-end">
            Last updated {lastRefresh.toLocaleTimeString('en-US', { timeStyle: 'short' })} · auto-refreshes every 30s
          </p>
        )}
      </div>

      {/* Action Required */}
      <section>
        <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">Action Required</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          {actionCards.map((card) => (
            <Link
              key={card.label}
              href={card.href}
              className={cn(
                'flex items-center gap-2 p-3 rounded-lg border bg-surface shadow-card hover:shadow-card-md transition-all',
                card.urgent ? 'border-danger/30 shadow-sm' : 'border-border',
              )}
            >
              <div className={cn(
                'w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0',
                card.urgent ? 'bg-danger/10 text-danger' : 'bg-surface text-text-muted',
              )}>
                {card.icon}
              </div>
              <div className="min-w-0">
                <p className="text-[11px] text-text-muted truncate leading-tight">{card.label}</p>
                <p className={cn(
                  'text-lg font-bold leading-tight',
                  card.urgent ? 'text-danger' : 'text-text-primary',
                )}>
                  {card.value}
                </p>
              </div>
            </Link>
          ))}
        </div>
      </section>

      {/* Period KPIs — time-frame selectable */}
      <section>
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider">At a Glance</h2>
          <div className="inline-flex rounded-lg border border-border bg-surface p-0.5">
            {RANGE_TABS.map((tab) => (
              <button
                key={tab.value}
                onClick={() => changeRange(tab.value)}
                className={cn(
                  'px-2.5 py-1 text-xs font-medium rounded-md transition-colors',
                  range === tab.value
                    ? 'bg-primary text-white shadow-sm'
                    : 'text-text-muted hover:text-text-primary',
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {todayCards.map((card) => (
            <div key={card.label} className="bg-surface shadow-card rounded-lg border border-border p-3">
              <div className="flex items-center gap-1.5 mb-1">
                {card.icon}
                <p className="text-[11px] font-medium text-text-muted leading-tight">{card.label}</p>
              </div>
              <p className={cn('text-base font-bold leading-tight', card.color)}>{card.value}</p>
              <p className="text-[10px] text-text-muted mt-0.5">{card.sub}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Platform Totals + Recent Notifications — side by side on wide screens */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Platform Totals */}
        <section className="lg:col-span-1">
          <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">All Time</h2>
          <div className="bg-surface shadow-card rounded-xl border border-border divide-y divide-border">
            {totalCards.map((card) => (
              <div key={card.label} className="flex items-center justify-between px-4 py-3">
                <p className="text-sm text-text-muted">{card.label}</p>
                <p className="text-sm font-bold text-text-primary">{card.value}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Recent Notifications */}
        <section className="lg:col-span-2">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider">Recent Notifications</h2>
            <div className="flex items-center gap-2">
              {(stats?.unreadNotifCount ?? 0) > 0 && (
                <span className="px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-600 dark:text-red-400 text-xs font-bold">
                  {stats!.unreadNotifCount} unread
                </span>
              )}
              <Link href="/admin/notifications" className="text-xs text-primary hover:underline font-medium">
                View all →
              </Link>
            </div>
          </div>
          <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
            {(stats?.recentNotifications ?? []).length === 0 ? (
              <div className="flex items-center justify-center py-8 text-text-muted text-sm gap-2">
                <svg className="w-5 h-5 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                </svg>
                No notifications yet
              </div>
            ) : (
              <div className="divide-y divide-border">
                {stats!.recentNotifications.map((n) => (
                  <div
                    key={n.id}
                    className={cn(
                      'flex items-start gap-3 px-4 py-3',
                      !n.isRead ? 'bg-blue-500/10' : 'hover:bg-surface',
                    )}
                  >
                    {!n.isRead && <div className="mt-1.5 w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0" />}
                    {n.isRead  && <div className="mt-1.5 w-1.5 h-1.5 rounded-full bg-surface-alt flex-shrink-0" />}
                    <span className={cn('mt-0.5 shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide', CATEGORY_COLORS[n.category])}>
                      {n.category}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-text-primary truncate">{n.title}</p>
                      <p className="text-xs text-text-muted truncate">{n.body}</p>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <p className="text-[10px] text-text-muted whitespace-nowrap">
                        {new Date(n.createdAt).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })}
                      </p>
                      {n.href && (
                        <Link
                          href={n.href}
                          className="ml-1 p-1 rounded hover:bg-primary/10 text-primary transition-colors"
                          title="Go"
                        >
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                          </svg>
                        </Link>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>

      {/* Gas Wallet Activity */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider">Gas Wallet Activity</h2>
          <Link href="/admin/gas/wallet-activity" className="text-xs text-primary hover:underline font-medium">View all →</Link>
        </div>
        <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
          {(stats?.recentGasActivity ?? []).length === 0 ? (
            <div className="flex items-center justify-center py-8 text-text-muted text-sm gap-2">
              <svg className="w-5 h-5 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              No gas transactions yet
            </div>
          ) : (
            <div className="divide-y divide-border">
              {stats!.recentGasActivity.map((tx) => {
                const hasDeposit  = !!tx.paymentTxHash
                const hasDelivery = !!tx.deliveryTxHash
                const shortHash   = (h: string) => `${h.slice(0, 8)}…${h.slice(-6)}`
                const statusColors: Record<string, string> = {
                  delivered:        'text-success',
                  payment_detected: 'text-blue-600 dark:text-blue-400',
                  payment_pending:  'text-amber-600 dark:text-amber-400',
                  payment_uploaded: 'text-amber-600 dark:text-amber-400',
                  sending:          'text-blue-600 dark:text-blue-400',
                  failed:           'text-danger',
                  expired:          'text-text-muted',
                  refunded:         'text-warning',
                }
                const statusLabels: Record<string, string> = {
                  delivered:        'Delivered',
                  payment_detected: 'Confirmed',
                  payment_pending:  'Awaiting',
                  payment_uploaded: 'Proof Submitted',
                  sending:          'Sending…',
                  failed:           'Failed',
                  expired:          'Expired',
                  refunded:         'Refunded',
                }
                return (
                  <Link
                    key={tx.id}
                    href={`/admin/gas/orders/${tx.orderRef}`}
                    className="flex items-start gap-3 px-4 py-3 hover:bg-surface transition-colors"
                  >
                    {/* Direction icon */}
                    <div className={cn(
                      'mt-0.5 w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0',
                      hasDeposit && hasDelivery ? 'bg-success/10' :
                      hasDeposit ? 'bg-blue-500/10' : 'bg-orange-500/10',
                    )}>
                      {hasDeposit && hasDelivery ? (
                        <svg className="w-3.5 h-3.5 text-success" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                        </svg>
                      ) : hasDeposit ? (
                        <svg className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                        </svg>
                      ) : (
                        <svg className="w-3.5 h-3.5 text-orange-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
                        </svg>
                      )}
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-semibold text-text-primary font-mono">{tx.orderRef}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-500/15 text-orange-700 dark:text-orange-300 font-bold">{tx.chain}</span>
                        <span className={cn('text-[10px] font-semibold', statusColors[tx.status] ?? 'text-text-muted')}>
                          {statusLabels[tx.status] ?? tx.status}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                        {hasDeposit && (
                          <span className="text-[11px] text-blue-600 dark:text-blue-400 font-medium">
                            ↓ {parseFloat(tx.paymentAmount).toFixed(2)} {tx.paymentCoin ?? 'USDT'} ({tx.paymentNetwork})
                            <span className="ml-1 font-mono text-text-muted">{shortHash(tx.paymentTxHash!)}</span>
                          </span>
                        )}
                        {hasDelivery && (
                          <span className="text-[11px] text-orange-600 dark:text-orange-400 font-medium">
                            ↑ {parseFloat(tx.gasAmountNative).toFixed(6)} {tx.chain}
                            <span className="ml-1 font-mono text-text-muted">{shortHash(tx.deliveryTxHash!)}</span>
                          </span>
                        )}
                      </div>
                    </div>

                    <p className="text-[10px] text-text-muted whitespace-nowrap flex-shrink-0 mt-1">
                      {new Date(tx.updatedAt).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })}
                    </p>
                  </Link>
                )
              })}
            </div>
          )}
        </div>
      </section>

      {/* Quick Navigation */}
      <section>
        <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">Quick Navigation</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
          {quickLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-center py-2.5 px-3 rounded-lg bg-surface border border-border hover:bg-surface hover:border-primary/30 text-text-secondary text-xs font-medium transition-colors"
            >
              {link.label}
            </Link>
          ))}
        </div>
      </section>
    </div>
  )
}
