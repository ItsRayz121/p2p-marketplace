'use client'
import { useState, useCallback, useEffect } from 'react'
import { adminApi } from '@/lib/api'
import { fmtNumber } from '@/lib/fmt'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'

interface AnalyticsData {
  userGrowth?: Array<{ date: string; newUsers: number; totalUsers?: number }>
  tradeVolume?: Array<{ date: string; volume: string; count: number }>
  badgeDistribution?: {
    new?: number
    active?: number
    trusted?: number
    top?: number
    elite?: number
  }
  topTraders?: Array<{
    username: string
    badge?: string
    volume: string
    completionRate: number
    tradeCount: number
  }>
  revenueByDay?: Array<{ date: string; revenue: string }>
}

type Period = '7d' | '30d' | '90d'

function SimpleBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 h-4 bg-surface rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-sm text-text-secondary w-12 text-right">{value.toLocaleString()}</span>
    </div>
  )
}

export default function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [period, setPeriod] = useState<Period>('30d')

  const fetchAnalytics = useCallback(async () => {
    setLoading(true)
    try {
      const result = await adminApi.getAnalytics({ period }) as AnalyticsData
      setData(result)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load analytics')
    } finally {
      setLoading(false)
    }
  }, [period])

  useEffect(() => {
    fetchAnalytics()
  }, [fetchAnalytics])

  const maxVolume = data?.tradeVolume
    ? Math.max(...data.tradeVolume.map((d) => parseFloat(d.volume) || 0), 1)
    : 1
  const maxUsers = data?.userGrowth
    ? Math.max(...data.userGrowth.map((d) => d.newUsers), 1)
    : 1

  const badgeTotals = data?.badgeDistribution
    ? Object.values(data.badgeDistribution).reduce((a, b) => a + (b || 0), 0)
    : 0

  const badgeColors: Record<string, string> = {
    new: 'bg-primary/70',
    active: 'bg-success/70',
    trusted: 'bg-warning/70',
    top: 'bg-gold/70',
    elite: 'bg-danger/70',
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Analytics</h1>
          <p className="text-text-muted text-sm mt-0.5">Platform performance metrics</p>
        </div>
        <div className="flex gap-2">
          {(['7d', '30d', '90d'] as Period[]).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors border ${
                period === p
                  ? 'bg-primary text-white border-primary'
                  : 'bg-white text-text-secondary border-border hover:bg-surface'
              }`}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <LoadingState message="Loading analytics..." />
      ) : error ? (
        <ErrorState title={error} onRetry={fetchAnalytics} />
      ) : (
        <div className="space-y-6">
          {/* User Growth */}
          {data?.userGrowth && data.userGrowth.length > 0 && (
            <div className="bg-white rounded-xl border border-border overflow-hidden">
              <div className="px-5 py-4 border-b border-border">
                <h2 className="font-semibold text-text-primary">User Growth</h2>
              </div>
              <div className="p-5 space-y-2">
                {data.userGrowth.map((d) => (
                  <div key={d.date} className="flex items-center gap-4 text-sm">
                    <span className="text-text-muted w-24 flex-shrink-0">
                      {d.date ? new Date(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}
                    </span>
                    <div className="flex-1">
                      <SimpleBar value={d.newUsers} max={maxUsers} color="bg-primary" />
                    </div>
                    <span className="text-text-muted text-xs w-16 text-right">+{d.newUsers} new</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Trade Volume */}
          {data?.tradeVolume && data.tradeVolume.length > 0 && (
            <div className="bg-white rounded-xl border border-border overflow-hidden">
              <div className="px-5 py-4 border-b border-border">
                <h2 className="font-semibold text-text-primary">Trade Volume</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-surface border-b border-border">
                    <tr>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Date</th>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Volume (USD)</th>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Trades</th>
                      <th className="px-4 py-3 w-40" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {data.tradeVolume.map((d) => (
                      <tr key={d.date} className="hover:bg-surface/50">
                        <td className="px-4 py-2.5 text-text-secondary">
                          {d.date ? new Date(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}
                        </td>
                        <td className="px-4 py-2.5 font-medium text-text-primary">
                          ${fmtNumber(d.volume)}
                        </td>
                        <td className="px-4 py-2.5 text-text-secondary">{d.count}</td>
                        <td className="px-4 py-2.5">
                          <div className="h-2 bg-surface rounded-full overflow-hidden">
                            <div
                              className="h-full bg-success rounded-full"
                              style={{ width: `${Math.round((parseFloat(d.volume) / maxVolume) * 100)}%` }}
                            />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Badge Distribution */}
          {data?.badgeDistribution && badgeTotals > 0 && (
            <div className="bg-white rounded-xl border border-border overflow-hidden">
              <div className="px-5 py-4 border-b border-border">
                <h2 className="font-semibold text-text-primary">Badge Distribution</h2>
                <p className="text-text-muted text-sm">{badgeTotals.toLocaleString()} total users</p>
              </div>
              <div className="p-5 space-y-4">
                {Object.entries(data.badgeDistribution).map(([badge, count]) => (
                  <div key={badge}>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="capitalize font-medium text-text-primary">{badge}</span>
                      <span className="text-text-muted">
                        {count?.toLocaleString()} ({badgeTotals > 0 ? Math.round(((count || 0) / badgeTotals) * 100) : 0}%)
                      </span>
                    </div>
                    <SimpleBar value={count || 0} max={badgeTotals} color={badgeColors[badge] || 'bg-primary/60'} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Top Traders */}
          {data?.topTraders && data.topTraders.length > 0 && (
            <div className="bg-white rounded-xl border border-border overflow-hidden">
              <div className="px-5 py-4 border-b border-border">
                <h2 className="font-semibold text-text-primary">Top Traders</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-surface border-b border-border">
                    <tr>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">#</th>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Username</th>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Badge</th>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Volume</th>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Trades</th>
                      <th className="text-left px-4 py-3 font-medium text-text-muted">Completion</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {data.topTraders.map((t, i) => (
                      <tr key={t.username} className="hover:bg-surface/50">
                        <td className="px-4 py-3 text-text-muted font-medium">{i + 1}</td>
                        <td className="px-4 py-3 font-medium text-text-primary">{t.username}</td>
                        <td className="px-4 py-3 capitalize text-text-secondary">{t.badge || 'â€”'}</td>
                        <td className="px-4 py-3 font-medium text-text-primary">${fmtNumber(t.volume)}</td>
                        <td className="px-4 py-3 text-text-secondary">{t.tradeCount}</td>
                        <td className="px-4 py-3">
                          <span className={`font-medium ${(t.completionRate ?? 0) >= 90 ? 'text-success' : (t.completionRate ?? 0) >= 70 ? 'text-warning' : 'text-danger'}`}>
                            {t.completionRate ?? 0}%
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {!data?.userGrowth?.length && !data?.tradeVolume?.length && !data?.topTraders?.length && (
            <div className="bg-white rounded-xl border border-border p-12 text-center text-text-muted">
              No analytics data available for the selected period.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

