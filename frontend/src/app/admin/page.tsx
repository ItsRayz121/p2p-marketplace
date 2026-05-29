'use client'
import { useState, useCallback } from 'react'
import Link from 'next/link'
import { adminApi, type AdminNotifCategory } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { cn } from '@/lib/utils'

type Stats = Awaited<ReturnType<typeof adminApi.getStats>>

const CATEGORY_COLORS: Record<AdminNotifCategory, string> = {
  KYC:     'bg-blue-100 text-blue-700',
  TRADE:   'bg-purple-100 text-purple-700',
  GAS:     'bg-orange-100 text-orange-700',
  DISPUTE: 'bg-red-100 text-red-700',
  CTM:     'bg-teal-100 text-teal-700',
  SYSTEM:  'bg-gray-100 text-gray-600',
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

  const fetchStats = useCallback(async () => {
    try {
      const data = await adminApi.getStats()
      setStats(data)
      setError(null)
      setLastRefresh(new Date())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load stats')
    } finally {
      setLoading(false)
    }
  }, [])

  usePolling(fetchStats, 30_000)

  if (loading) return <LoadingState message="Loading dashboard…" />
  if (error && !stats) return <ErrorState title={error} onRetry={fetchStats} />

  const actionCards = [
    {
      label: 'Pending KYC',
      value: stats?.pendingKyc ?? 0,
      href: '/admin/kyc',
      urgent: (stats?.pendingKyc ?? 0) > 0,
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V8a2 2 0 00-2-2h-5m-4 0V5a2 2 0 114 0v1m-4 0a2 2 0 104 0" />
        </svg>
      ),
    },
    {
      label: 'Open Disputes',
      value: stats?.openDisputes ?? 0,
      href: '/admin/disputes',
      urgent: (stats?.openDisputes ?? 0) > 0,
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
      ),
    },
    {
      label: 'Pending Withdrawals',
      value: stats?.pendingWithdrawals ?? 0,
      href: '/admin/withdrawals',
      urgent: (stats?.pendingWithdrawals ?? 0) > 0,
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z" />
        </svg>
      ),
    },
    {
      label: 'Instant Buy Review',
      value: stats?.pendingInstantBuy ?? 0,
      href: '/admin/instant-buy',
      urgent: (stats?.pendingInstantBuy ?? 0) > 0,
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
      ),
    },
    {
      label: 'Gas Orders Active',
      value: stats?.pendingGasOrders ?? 0,
      href: '/admin/gas',
      urgent: (stats?.pendingGasOrders ?? 0) > 0,
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
      ),
    },
    {
      label: 'PKR Proofs Pending',
      value: stats?.pkrGasProofsPending ?? 0,
      href: '/admin/gas',
      urgent: (stats?.pkrGasProofsPending ?? 0) > 0,
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
      ),
    },
  ]

  const todayCards = [
    {
      label: "Today's Revenue",
      value: `PKR ${fmt(stats?.todayRevenuePkr ?? 0)}`,
      sub: 'from completed trades',
      color: 'text-success',
      icon: (
        <svg className="w-5 h-5 text-success" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ),
    },
    {
      label: "Today's Trades",
      value: fmt(stats?.todayTrades ?? 0),
      sub: 'trades started today',
      color: 'text-primary',
      icon: (
        <svg className="w-5 h-5 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
        </svg>
      ),
    },
    {
      label: 'New Users Today',
      value: fmt(stats?.newUsersToday ?? 0),
      sub: 'registered today',
      color: 'text-purple-600',
      icon: (
        <svg className="w-5 h-5 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
        </svg>
      ),
    },
    {
      label: "Today's Gas Orders",
      value: fmt(stats?.todayGasOrders ?? 0),
      sub: 'gas fee orders today',
      color: 'text-orange-600',
      icon: (
        <svg className="w-5 h-5 text-orange-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
      ),
    },
    {
      label: "Today's Gas Revenue",
      value: `$${stats?.todayGasRevenueUsdt ?? '0.00'} USDT`,
      sub: 'from delivered gas orders',
      color: 'text-orange-600',
      icon: (
        <svg className="w-5 h-5 text-orange-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ),
    },
    {
      label: "Today's Withdrawals Sent",
      value: fmt((stats as any)?.todaySentWithdrawals ?? 0),
      sub: 'withdrawals completed today',
      color: 'text-primary',
      icon: (
        <svg className="w-5 h-5 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z" />
        </svg>
      ),
    },
    {
      label: "Today's Withdrawal Fees",
      value: `${(stats as any)?.todayWithdrawalFeesUsdt ?? '0.000000'} USDT`,
      sub: 'fees collected from withdrawals',
      color: 'text-success',
      icon: (
        <svg className="w-5 h-5 text-success" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ),
    },
  ]

  const totalCards = [
    { label: 'Total Users',              value: fmt(stats?.totalUsers ?? 0) },
    { label: 'Total Trades',             value: fmt(stats?.totalTrades ?? 0) },
    { label: 'Total Volume PKR',          value: `PKR ${fmt(stats?.totalVolumePkr ?? 0)}` },
    { label: 'Total Gas Orders',          value: fmt(stats?.totalGasOrders ?? 0) },
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
    { label: 'Instant Buy',   href: '/admin/instant-buy' },
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
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {actionCards.map((card) => (
            <Link
              key={card.label}
              href={card.href}
              className={cn(
                'flex items-center gap-3 p-4 rounded-xl border bg-white hover:shadow-md transition-all',
                card.urgent ? 'border-danger/30 shadow-sm' : 'border-border',
              )}
            >
              <div className={cn(
                'w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0',
                card.urgent ? 'bg-danger/10 text-danger' : 'bg-surface text-text-muted',
              )}>
                {card.icon}
              </div>
              <div className="min-w-0">
                <p className="text-xs text-text-muted truncate">{card.label}</p>
                <p className={cn(
                  'text-2xl font-bold leading-tight',
                  card.urgent ? 'text-danger' : 'text-text-primary',
                )}>
                  {card.value}
                </p>
              </div>
            </Link>
          ))}
        </div>
      </section>

      {/* Today at a Glance */}
      <section>
        <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">Today</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7 gap-3">
          {todayCards.map((card) => (
            <div key={card.label} className="bg-surface shadow-card rounded-xl border border-border p-4">
              <div className="flex items-center gap-2 mb-2">
                {card.icon}
                <p className="text-xs font-medium text-text-muted">{card.label}</p>
              </div>
              <p className={cn('text-2xl font-bold', card.color)}>{card.value}</p>
              <p className="text-[11px] text-text-muted mt-0.5">{card.sub}</p>
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
                <span className="px-1.5 py-0.5 rounded-full bg-red-100 text-red-600 text-xs font-bold">
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
                      !n.isRead ? 'bg-blue-50/30' : 'hover:bg-surface',
                    )}
                  >
                    {!n.isRead && <div className="mt-1.5 w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0" />}
                    {n.isRead  && <div className="mt-1.5 w-1.5 h-1.5 rounded-full bg-gray-200 flex-shrink-0" />}
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
                  payment_detected: 'text-blue-600',
                  payment_pending:  'text-amber-600',
                  payment_uploaded: 'text-amber-600',
                  sending:          'text-blue-600',
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
                      hasDeposit ? 'bg-blue-50' : 'bg-orange-50',
                    )}>
                      {hasDeposit && hasDelivery ? (
                        <svg className="w-3.5 h-3.5 text-success" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                        </svg>
                      ) : hasDeposit ? (
                        <svg className="w-3.5 h-3.5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-100 text-orange-700 font-bold">{tx.chain}</span>
                        <span className={cn('text-[10px] font-semibold', statusColors[tx.status] ?? 'text-text-muted')}>
                          {statusLabels[tx.status] ?? tx.status}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                        {hasDeposit && (
                          <span className="text-[11px] text-blue-600 font-medium">
                            ↓ {parseFloat(tx.paymentAmount).toFixed(2)} {tx.paymentCoin ?? 'USDT'} ({tx.paymentNetwork})
                            <span className="ml-1 font-mono text-text-muted">{shortHash(tx.paymentTxHash!)}</span>
                          </span>
                        )}
                        {hasDelivery && (
                          <span className="text-[11px] text-orange-600 font-medium">
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
              className="text-center py-2.5 px-3 rounded-lg bg-white border border-border hover:bg-surface hover:border-primary/30 text-text-secondary text-xs font-medium transition-colors"
            >
              {link.label}
            </Link>
          ))}
        </div>
      </section>
    </div>
  )
}
