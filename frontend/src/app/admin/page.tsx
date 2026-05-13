'use client'
import { useState, useCallback } from 'react'
import Link from 'next/link'
import { adminApi } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'

interface AdminStats {
  totalUsers: number
  totalTrades: number
  totalVolume: string
  pendingKyc: number
  openDisputes: number
  pendingWithdrawals?: number
  pendingInstantBuy?: number
  todayRevenuePkr?: string
}

interface StatCard {
  label: string
  value: string | number
  href: string
  color: string
  icon: React.ReactNode
}

export default function AdminDashboardPage() {
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchStats = useCallback(async () => {
    try {
      const data = await adminApi.getStats()
      setStats(data as AdminStats)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load stats')
    } finally {
      setLoading(false)
    }
  }, [])

  usePolling(fetchStats, 30_000)

  if (loading) return <LoadingState message="Loading dashboard..." />
  if (error && !stats) return <ErrorState title={error} onRetry={fetchStats} />

  const cards: StatCard[] = [
    {
      label: 'Pending KYC',
      value: stats?.pendingKyc ?? 0,
      href: '/admin/kyc',
      color: 'bg-warning/10 text-warning border-warning/20',
      icon: (
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V8a2 2 0 00-2-2h-5m-4 0V5a2 2 0 114 0v1m-4 0a2 2 0 104 0" />
        </svg>
      ),
    },
    {
      label: 'Open Disputes',
      value: stats?.openDisputes ?? 0,
      href: '/admin/disputes',
      color: 'bg-danger/10 text-danger border-danger/20',
      icon: (
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
      ),
    },
    {
      label: 'Pending Withdrawals',
      value: stats?.pendingWithdrawals ?? 0,
      href: '/admin/withdrawals',
      color: 'bg-primary/10 text-primary border-primary/20',
      icon: (
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z" />
        </svg>
      ),
    },
    {
      label: 'Instant Buy Review',
      value: stats?.pendingInstantBuy ?? 0,
      href: '/admin/instant-buy',
      color: 'bg-gold/10 text-gold border-gold/20',
      icon: (
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
      ),
    },
    {
      label: "Today's Revenue",
      value: stats?.todayRevenuePkr ? `PKR ${Number(stats.todayRevenuePkr).toLocaleString()}` : 'PKR 0',
      href: '/admin/analytics',
      color: 'bg-success/10 text-success border-success/20',
      icon: (
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ),
    },
  ]

  const summaryCards = [
    { label: 'Total Users', value: stats?.totalUsers?.toLocaleString() ?? '0' },
    { label: 'Total Trades', value: stats?.totalTrades?.toLocaleString() ?? '0' },
    { label: 'Total Volume', value: stats?.totalVolume ? `$${Number(stats.totalVolume).toLocaleString()}` : '$0' },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Dashboard</h1>
        <p className="text-text-muted text-sm mt-1">Platform overview â€” refreshes every 30 seconds</p>
      </div>

      {/* Summary row */}
      <div className="grid grid-cols-3 gap-4">
        {summaryCards.map((c) => (
          <div key={c.label} className="bg-white rounded-xl border border-border p-4">
            <p className="text-text-muted text-xs font-medium uppercase tracking-wide">{c.label}</p>
            <p className="text-2xl font-bold text-text-primary mt-1">{c.value}</p>
          </div>
        ))}
      </div>

      {/* Action cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {cards.map((card) => (
          <Link
            key={card.label}
            href={card.href}
            className={`flex items-center gap-4 p-5 rounded-xl border bg-white hover:shadow-md transition-shadow`}
          >
            <div className={`w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 ${card.color}`}>
              {card.icon}
            </div>
            <div>
              <p className="text-text-muted text-sm">{card.label}</p>
              <p className="text-2xl font-bold text-text-primary">{card.value}</p>
            </div>
          </Link>
        ))}
      </div>

      {/* Quick links */}
      <div className="bg-white rounded-xl border border-border p-5">
        <h2 className="text-base font-semibold text-text-primary mb-4">Quick Navigation</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Users', href: '/admin/users' },
            { label: 'Trades', href: '/admin/trades' },
            { label: 'Wallet', href: '/admin/wallet' },
            { label: 'Gas Fee', href: '/admin/gas' },
            { label: 'Analytics', href: '/admin/analytics' },
            { label: 'Audit Log', href: '/admin/audit-log' },
            { label: 'Merchant KYC', href: '/admin/merchant-kyc' },
            { label: 'Config', href: '/admin/config' },
          ].map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-center py-2.5 px-3 rounded-lg bg-surface hover:bg-gray-100 text-text-secondary text-sm font-medium transition-colors border border-border"
            >
              {link.label}
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}

