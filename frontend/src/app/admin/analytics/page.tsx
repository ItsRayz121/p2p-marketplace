'use client'
import { useState, useCallback, useEffect } from 'react'
import Link from 'next/link'
import { adminApi, apiRequest } from '@/lib/api'
import { fmtNumber } from '@/lib/fmt'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Button } from '@/components/ui/Button'
import { RefreshCw } from 'lucide-react'

interface TradeSummary { allTime: number; period: number }

interface AnalyticsData {
  userGrowth?: Array<{ date: string; newUsers: number }>
  tradeVolume?: Array<{ date: string; volume: string; count: number }>
  badgeDistribution?: Record<string, number>
  topTraders?: Array<{
    userId?: string
    username: string
    badge?: string
    volume: string
    completionRate: number
    tradeCount: number
  }>
  summary?: {
    p2p: TradeSummary
    ctm: TradeSummary
    gas: TradeSummary
    total: TradeSummary
  }
}

type Period = '7d' | '30d' | '90d'
type ChartTab = 'growth' | 'badges'

/** Compact vertical bar chart. Bars scroll horizontally when there are many. */
function VerticalBarChart({
  bars,
  valueSuffix = '',
}: {
  bars: Array<{ label: string; value: number; color: string }>
  valueSuffix?: string
}) {
  const max = Math.max(...bars.map((b) => b.value), 1)
  return (
    <div className="overflow-x-auto pb-1">
      <div className="flex items-end gap-2 h-44 min-w-full pt-6">
        {bars.map((b, i) => {
          const pct = Math.round((b.value / max) * 100)
          return (
            <div
              key={`${b.label}-${i}`}
              className="group flex flex-1 min-w-[2.25rem] flex-col items-center gap-2"
            >
              <div className="relative flex w-full flex-1 items-end justify-center">
                <span className="absolute -top-5 text-[11px] font-semibold text-text-secondary opacity-0 transition-opacity group-hover:opacity-100">
                  {b.value.toLocaleString()}
                  {valueSuffix}
                </span>
                <div
                  className={`w-full max-w-[2.25rem] rounded-t-md transition-all duration-500 ${b.color}`}
                  style={{ height: `${Math.max(pct, 2)}%` }}
                  title={`${b.label}: ${b.value.toLocaleString()}${valueSuffix}`}
                />
              </div>
              <span className="max-w-[3.5rem] truncate text-center text-[10px] leading-tight text-text-muted">
                {b.label}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [period, setPeriod] = useState<Period>('30d')
  const [chartTab, setChartTab] = useState<ChartTab>('growth')
  const [recalculating, setRecalculating] = useState(false)
  const [recalcMsg, setRecalcMsg] = useState<string | null>(null)

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

  async function handleRecalculate() {
    setRecalculating(true)
    setRecalcMsg(null)
    try {
      await apiRequest('/admin/stats/recalculate', { method: 'POST', body: JSON.stringify({}) })
      setRecalcMsg('Stats recalculation queued for all users. Refresh in a minute.')
      setTimeout(fetchAnalytics, 3000)
    } catch (e) {
      setRecalcMsg(e instanceof Error ? e.message : 'Recalculation failed')
    } finally {
      setRecalculating(false)
    }
  }

  const maxVolume = data?.tradeVolume
    ? Math.max(...data.tradeVolume.map((d) => parseFloat(d.volume) || 0), 1)
    : 1

  const badgeTotals = data?.badgeDistribution
    ? Object.values(data.badgeDistribution).reduce((a, b) => a + (b || 0), 0)
    : 0

  const badgeColors: Record<string, string> = {
    new: 'bg-primary',
    active: 'bg-success',
    trusted: 'bg-warning',
    top: 'bg-gold',
    elite: 'bg-danger',
  }
  // Stable display order for badge tiers (lowest → highest trust)
  const badgeOrder = ['new', 'active', 'trusted', 'top', 'elite']

  function fmtDay(date: string) {
    return date
      ? new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : '—'
  }

  const growthBars = (data?.userGrowth ?? []).map((d) => ({
    label: fmtDay(d.date),
    value: d.newUsers,
    color: 'bg-primary',
  }))

  const badgeBars = data?.badgeDistribution
    ? Object.entries(data.badgeDistribution)
        .sort(([a], [b]) => {
          const ia = badgeOrder.indexOf(a)
          const ib = badgeOrder.indexOf(b)
          return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
        })
        .map(([badge, count]) => ({
          label: badge.charAt(0).toUpperCase() + badge.slice(1),
          value: count || 0,
          color: badgeColors[badge] || 'bg-primary',
        }))
    : []

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Analytics</h1>
          <p className="text-text-muted text-sm mt-0.5">Platform performance metrics</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {(['7d', '30d', '90d'] as Period[]).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors border ${
                period === p
                  ? 'bg-primary text-white border-primary'
                  : 'bg-surface text-text-secondary border-border hover:bg-surface-alt'
              }`}
            >
              {p}
            </button>
          ))}
          <Button
            size="sm"
            variant="secondary"
            loading={recalculating}
            onClick={handleRecalculate}
            title="Re-compute badges, completion rates, and volume for all users"
          >
            <RefreshCw size={13} className="mr-1.5" />
            Recalculate Stats
          </Button>
        </div>
        {recalcMsg && (
          <p className={`w-full text-xs mt-1 ${recalcMsg.includes('failed') ? 'text-danger' : 'text-success'}`}>{recalcMsg}</p>
        )}
      </div>

      {/* Summary cards */}
      {data?.summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {([
            { label: 'P2P Trades', key: 'p2p', color: 'text-primary' },
            { label: 'CTM Trades', key: 'ctm', color: 'text-success' },
            { label: 'Gas Orders', key: 'gas', color: 'text-warning' },
            { label: 'All Completed', key: 'total', color: 'text-text-primary' },
          ] as const).map(({ label, key, color }) => {
            const s = data.summary![key]
            return (
              <div key={key} className="bg-surface shadow-card rounded-xl border border-border p-4">
                <p className="text-xs text-text-muted">{label}</p>
                <p className={`text-2xl font-bold mt-1 ${color}`}>{s.allTime.toLocaleString()}</p>
                <p className="text-xs text-text-muted mt-0.5">+{s.period} this period</p>
              </div>
            )
          })}
        </div>
      )}

      {loading ? (
        <LoadingState message="Loading analytics..." />
      ) : error ? (
        <ErrorState title={error} onRetry={fetchAnalytics} />
      ) : (
        <div className="space-y-6">
          {/* Tabbed compact chart: User Growth / Badge Distribution */}
          <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
            <div className="flex items-center gap-1 border-b border-border px-3 pt-3">
              {([
                { key: 'growth', label: 'User Growth' },
                { key: 'badges', label: 'Badge Distribution' },
              ] as const).map((t) => (
                <button
                  key={t.key}
                  onClick={() => setChartTab(t.key)}
                  className={`rounded-t-lg px-4 py-2 text-sm font-medium transition-colors ${
                    chartTab === t.key
                      ? 'bg-primary/10 text-primary border-b-2 border-primary'
                      : 'text-text-muted hover:text-text-secondary'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {chartTab === 'growth' ? (
              <div className="p-5">
                <p className="mb-4 text-xs text-text-muted">
                  Number of new users who registered each day over the selected range ({period}).
                </p>
                {growthBars.length > 0 ? (
                  <VerticalBarChart bars={growthBars} valueSuffix=" new" />
                ) : (
                  <div className="py-10 text-center text-sm text-text-muted">
                    No new users registered in the last {period}.
                  </div>
                )}
              </div>
            ) : (
              <div className="p-5">
                <p className="mb-4 text-xs text-text-muted">
                  How all {badgeTotals.toLocaleString()} users are distributed across trust badge tiers.
                  This reflects all users and is not affected by the {period} range.
                </p>
                {badgeBars.length > 0 ? (
                  <>
                    <VerticalBarChart bars={badgeBars} />
                    <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
                      {badgeBars.map((b) => (
                        <div
                          key={b.label}
                          className="rounded-lg border border-border bg-surface-alt px-3 py-2 text-center"
                        >
                          <p className="text-xs font-medium capitalize text-text-secondary">{b.label}</p>
                          <p className="text-lg font-bold text-text-primary">{b.value.toLocaleString()}</p>
                          <p className="text-[11px] text-text-muted">
                            {badgeTotals > 0 ? Math.round((b.value / badgeTotals) * 100) : 0}%
                          </p>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="py-10 text-center text-sm text-text-muted">
                    No badge data available yet.
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Trade Volume */}
          {data?.tradeVolume && data.tradeVolume.length > 0 && (
            <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
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
                          <div className="h-2 bg-surface-alt rounded-full overflow-hidden">
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

          {/* Top Traders */}
          {data?.topTraders && data.topTraders.length > 0 && (
            <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
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
                        <td className="px-4 py-3 font-medium">
                          {t.userId ? (
                            <Link href={`/admin/users/${t.userId}`} className="text-text-primary hover:text-primary hover:underline">{t.username}</Link>
                          ) : (
                            <span className="text-text-primary">{t.username}</span>
                          )}
                        </td>
                        <td className="px-4 py-3 capitalize text-text-secondary">{t.badge ?? 'new'}</td>
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
            <div className="bg-surface shadow-card rounded-xl border border-border p-12 text-center text-text-muted">
              No analytics data available for the selected period.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

