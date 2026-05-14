'use client'
import { useState, useEffect, useCallback } from 'react'
import { leaderboardApi } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Badge } from '@/components/ui/Badge'
import { fmtNumber, fmtPkr } from '@/lib/fmt'

// ─── Types ────────────────────────────────────────────────────────────────────

interface LeaderboardEntry {
  rank: number
  userId: string
  username: string
  badge?: string | null
  badgeLabel?: string | null
  totalTrades?: number | null
  completedTrades?: number | null
  completionRate?: number | null
  avgRating?: number | null
  totalVolumePKR?: string | number | null
  trustScore?: number | null
}

type Period = 'daily' | 'weekly' | 'monthly' | 'all-time'

const PERIODS: { id: Period; label: string }[] = [
  { id: 'all-time', label: 'All Time' },
  { id: 'monthly', label: 'This Month' },
  { id: 'weekly', label: 'This Week' },
  { id: 'daily', label: 'Today' },
]

// Map frontend period labels to backend query params
const PERIOD_MAP: Record<Period, string> = {
  'all-time': 'all',
  monthly: 'month',
  weekly: 'week',
  daily: 'week', // backend has no daily; use week as closest fallback
}

function RankDisplay({ rank }: { rank: number }) {
  if (rank === 1) return <span className="text-lg">🥇</span>
  if (rank === 2) return <span className="text-lg">🥈</span>
  if (rank === 3) return <span className="text-lg">🥉</span>
  return <span className="text-sm font-bold text-text-muted w-6 text-center inline-block">{rank}</span>
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function LeaderboardPage() {
  const { user } = useAuth()
  const [period, setPeriod] = useState<Period>('all-time')
  const [entries, setEntries] = useState<LeaderboardEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await leaderboardApi.getTop({ period: PERIOD_MAP[period] as never, limit: 50 })
      setEntries((res.entries ?? []) as LeaderboardEntry[])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load leaderboard')
    } finally {
      setLoading(false)
    }
  }, [period])

  useEffect(() => { fetchData() }, [fetchData])

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 pb-24 lg:pb-6 space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Leaderboard</h1>
        <p className="text-sm text-text-muted">Top traders on PakSwap</p>
      </div>

      {/* Period Filter */}
      <div className="flex gap-1 bg-surface rounded-xl p-1 overflow-x-auto">
        {PERIODS.map((p) => (
          <button
            key={p.id}
            onClick={() => setPeriod(p.id)}
            className={`flex-1 min-w-max py-2 px-3 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
              period === p.id ? 'bg-white text-text-primary shadow-sm' : 'text-text-muted hover:text-text-primary'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Leaderboard Table */}
      {loading && <LoadingState message="Loading leaderboard..." />}
      {error && <ErrorState title={error} onRetry={fetchData} />}

      {!loading && !error && (
        <>
          {entries.length === 0 ? (
            <EmptyState title="No data" description="No traders found for this period yet." />
          ) : (
            <>
              {/* Desktop */}
              <div className="hidden md:block bg-white border border-border rounded-xl overflow-hidden">
                <table className="w-full">
                  <thead className="bg-surface border-b border-border">
                    <tr>
                      {['Rank', 'Trader', 'Badge', 'Completed Trades', 'Volume (PKR)', 'Rate'].map((h) => (
                        <th key={h} className="text-left text-xs font-semibold text-text-muted px-4 py-3">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {entries.map((entry) => {
                      const isMe = entry.userId === user?.id
                      return (
                        <tr key={entry.userId} className={`hover:bg-surface/50 transition-colors ${isMe ? 'bg-primary/5' : ''}`}>
                          <td className="px-4 py-3">
                            <RankDisplay rank={entry.rank} />
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <div className="w-7 h-7 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center uppercase">
                                {(entry.username ?? '?').slice(0, 2)}
                              </div>
                              <span className="text-sm font-medium text-text-primary">
                                {entry.username}
                                {isMe && <span className="ml-1 text-primary text-xs">(you)</span>}
                              </span>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            {entry.badge && <Badge variant="default" size="sm">{entry.badgeLabel ?? entry.badge}</Badge>}
                          </td>
                          <td className="px-4 py-3 text-sm text-text-primary">
                            {fmtNumber(entry.completedTrades)}
                          </td>
                          <td className="px-4 py-3 text-sm font-semibold text-text-primary">
                            {fmtNumber(entry.totalVolumePKR)}
                          </td>
                          <td className="px-4 py-3 text-sm text-text-muted">
                            {entry.completionRate != null ? `${Number(entry.completionRate).toFixed(1)}%` : '—'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {/* Mobile */}
              <div className="md:hidden space-y-2">
                {entries.map((entry) => {
                  const isMe = entry.userId === user?.id
                  return (
                    <div
                      key={entry.userId}
                      className={`bg-white border rounded-xl px-4 py-3 flex items-center gap-3 ${isMe ? 'border-primary/30 bg-primary/5' : 'border-border'}`}
                    >
                      <div className="flex-shrink-0 w-8 text-center">
                        <RankDisplay rank={entry.rank} />
                      </div>
                      <div className="w-8 h-8 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center flex-shrink-0 uppercase">
                        {(entry.username ?? '?').slice(0, 2)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-text-primary truncate">
                          {entry.username}
                          {isMe && <span className="ml-1 text-primary text-xs">(you)</span>}
                        </p>
                        <p className="text-xs text-text-muted">{fmtNumber(entry.completedTrades)} trades</p>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <p className="text-sm font-bold text-text-primary">
                          {fmtPkr(entry.totalVolumePKR)}
                        </p>
                        {entry.badge && <Badge variant="default" size="sm">{entry.badgeLabel ?? entry.badge}</Badge>}
                      </div>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
