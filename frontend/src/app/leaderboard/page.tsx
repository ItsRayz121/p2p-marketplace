'use client'
import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { leaderboardApi } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Badge } from '@/components/ui/Badge'
import { Trophy, ArrowLeft } from 'lucide-react'
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
type TradeType = 'all' | 'usdt' | 'ctm' | 'gas'

const PERIODS: { id: Period; label: string }[] = [
  { id: 'all-time', label: 'All Time' },
  { id: 'monthly', label: 'This Month' },
  { id: 'weekly', label: 'This Week' },
  { id: 'daily', label: 'Today' },
]

const TRADE_TYPES: { id: TradeType; label: string }[] = [
  { id: 'all', label: 'Overall' },
  { id: 'usdt', label: 'USDT Trades' },
  { id: 'ctm', label: 'Community Token Trades' },
  { id: 'gas', label: 'Crypto Gas Trades' },
]

// Map frontend period labels to backend query params
const PERIOD_MAP: Record<Period, string> = {
  'all-time': 'all',
  monthly: 'month',
  weekly: 'week',
  daily: 'week', // backend has no daily; use week as closest fallback
}

function RankDisplay({ rank }: { rank: number }) {
  if (rank === 1) return <span className="text-base font-black text-yellow-500 w-7 text-center inline-block">🥇</span>
  if (rank === 2) return <span className="text-base font-black text-slate-400 w-7 text-center inline-block">🥈</span>
  if (rank === 3) return <span className="text-base font-black text-amber-600 w-7 text-center inline-block">🥉</span>
  return <span className="text-sm font-bold text-text-muted w-7 text-center inline-block">#{rank}</span>
}

function rankRowCls(rank: number, isMe: boolean): string {
  if (isMe) return 'bg-primary/5'
  if (rank === 1) return 'bg-yellow-50'
  if (rank === 2) return 'bg-slate-50'
  if (rank === 3) return 'bg-amber-50/60'
  return ''
}

function rankAvatarCls(rank: number): string {
  if (rank === 1) return 'bg-yellow-100 text-yellow-700'
  if (rank === 2) return 'bg-slate-100 text-slate-500'
  if (rank === 3) return 'bg-amber-100 text-amber-700'
  return 'bg-primary/10 text-primary'
}

function badgeVariant(badge?: string | null): 'warning' | 'success' | 'info' | 'default' {
  if (badge === 'elite' || badge === 'top') return 'warning'
  if (badge === 'trusted') return 'success'
  if (badge === 'active') return 'info'
  return 'default'
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function LeaderboardPage() {
  const { user } = useAuth()
  const [period, setPeriod] = useState<Period>('all-time')
  const [tradeType, setTradeType] = useState<TradeType>('all')
  const [entries, setEntries] = useState<LeaderboardEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await leaderboardApi.getTop({ period: PERIOD_MAP[period] as never, limit: 50, tradeType })
      setEntries((res.entries ?? []) as LeaderboardEntry[])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load leaderboard')
    } finally {
      setLoading(false)
    }
  }, [period, tradeType])

  useEffect(() => { fetchData() }, [fetchData])

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 pb-24 lg:pb-6 space-y-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <Link href="/dashboard" className="inline-flex items-center gap-1.5 text-xs text-text-muted hover:text-primary transition-colors mb-2">
            <ArrowLeft size={13} />
            Dashboard
          </Link>
          <h1 className="text-2xl font-bold text-text-primary">Leaderboard</h1>
          <p className="text-sm text-text-muted">Top traders on PakSwap</p>
        </div>
      </div>

      {/* Trade Type Filter */}
      <div className="flex gap-1 bg-surface rounded-xl p-1 overflow-x-auto">
        {TRADE_TYPES.map((t) => (
          <button
            key={t.id}
            onClick={() => setTradeType(t.id)}
            className={`flex-1 min-w-max py-2 px-3 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
              tradeType === t.id ? 'bg-white text-text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Period Filter */}
      <div className="flex gap-1 bg-surface rounded-xl p-1 overflow-x-auto">
        {PERIODS.map((p) => (
          <button
            key={p.id}
            onClick={() => setPeriod(p.id)}
            className={`flex-1 min-w-max py-2 px-3 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
              period === p.id ? 'bg-white text-text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary'
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
            <EmptyState icon={Trophy} title="No data yet" description="No traders found for this period yet." />
          ) : (
            <>
              {/* Desktop */}
              <div className="hidden md:block bg-surface shadow-card border border-border rounded-xl overflow-hidden">
                <table className="w-full">
                  <thead className="bg-surface border-b-2 border-border">
                    <tr>
                      {['Rank', 'Trader', 'Badge', 'Completed Trades', 'Volume (PKR)', 'Rate'].map((h) => (
                        <th key={h} className="text-left text-xs font-semibold text-text-secondary uppercase tracking-wide px-4 py-3">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {entries.map((entry) => {
                      const isMe = entry.userId === user?.id
                      return (
                        <tr key={entry.userId} className={`hover:brightness-[0.98] transition-colors ${rankRowCls(entry.rank, isMe)}`}>
                          <td className="px-4 py-3">
                            <RankDisplay rank={entry.rank} />
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <div className={`w-7 h-7 rounded-full text-xs font-bold flex items-center justify-center uppercase flex-shrink-0 ${rankAvatarCls(entry.rank)}`}>
                                {(entry.username ?? '?').slice(0, 2)}
                              </div>
                              <span className="text-sm font-medium text-text-primary">
                                {entry.username}
                                {isMe && <span className="ml-1 text-primary text-xs">(you)</span>}
                              </span>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            {entry.badge && <Badge variant={badgeVariant(entry.badge)} size="sm">{entry.badgeLabel ?? entry.badge}</Badge>}
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
                  const rowBg = isMe ? 'border-primary/30 bg-primary/5' : entry.rank === 1 ? 'border-yellow-200 bg-yellow-50' : entry.rank === 2 ? 'border-slate-200 bg-slate-50' : entry.rank === 3 ? 'border-amber-200 bg-amber-50/60' : 'border-border bg-surface'
                  return (
                    <div
                      key={entry.userId}
                      className={`border rounded-xl px-4 py-3 flex items-center gap-3 shadow-card ${rowBg}`}
                    >
                      <div className="flex-shrink-0 w-8 text-center">
                        <RankDisplay rank={entry.rank} />
                      </div>
                      <div className={`w-8 h-8 rounded-full text-xs font-bold flex items-center justify-center flex-shrink-0 uppercase ${rankAvatarCls(entry.rank)}`}>
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
                        {entry.badge && <Badge variant={badgeVariant(entry.badge)} size="sm">{entry.badgeLabel ?? entry.badge}</Badge>}
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
