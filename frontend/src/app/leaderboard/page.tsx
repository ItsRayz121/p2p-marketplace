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
import { UserAvatar } from '@/components/ui/UserAvatar'
import { fmtNumber, fmtPkr } from '@/lib/fmt'

// ─── Types ────────────────────────────────────────────────────────────────────

interface LeaderboardEntry {
  rank: number
  userId: string
  username: string
  fullName?: string | null
  avatarUrl?: string | null
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

// `short` labels keep all tabs on one line on phones (no horizontal scroll);
// the full label shows from sm+.
const PERIODS: { id: Period; label: string; short: string }[] = [
  { id: 'all-time', label: 'All Time', short: 'All' },
  { id: 'monthly', label: 'This Month', short: 'Month' },
  { id: 'weekly', label: 'This Week', short: 'Week' },
  { id: 'daily', label: 'Today', short: 'Today' },
]

const TRADE_TYPES: { id: TradeType; label: string; short: string }[] = [
  { id: 'all', label: 'Overall', short: 'Overall' },
  { id: 'usdt', label: 'USDT Trades', short: 'USDT' },
  { id: 'ctm', label: 'Community Token Trades', short: 'Tokens' },
  { id: 'gas', label: 'Crypto Gas Trades', short: 'Gas' },
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
  if (rank === 3) return <span className="text-base font-black text-amber-600 dark:text-amber-400 w-7 text-center inline-block">🥉</span>
  return <span className="text-sm font-bold text-text-muted w-7 text-center inline-block">#{rank}</span>
}

function rankRowCls(rank: number, isMe: boolean): string {
  if (isMe) return 'bg-primary/5'
  if (rank === 1) return 'bg-yellow-500/10 dark:bg-yellow-500/10'
  if (rank === 2) return 'bg-slate-50 dark:bg-slate-500/10'
  if (rank === 3) return 'bg-amber-500/10 dark:bg-amber-500/10'
  return ''
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
          <p className="text-sm text-text-muted">Top traders on RupChain</p>
        </div>
      </div>

      {/* Trade Type Filter — all tabs fit one line on mobile (short labels) */}
      <div className="flex gap-1 bg-surface rounded-xl p-1">
        {TRADE_TYPES.map((t) => (
          <button
            key={t.id}
            onClick={() => setTradeType(t.id)}
            className={`flex-1 min-w-0 py-2 px-1.5 sm:px-3 rounded-lg text-xs sm:text-sm font-medium transition-colors whitespace-nowrap ${
              tradeType === t.id ? 'bg-surface-alt text-text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            <span className="sm:hidden">{t.short}</span>
            <span className="hidden sm:inline">{t.label}</span>
          </button>
        ))}
      </div>

      {/* Period Filter — all tabs fit one line on mobile (short labels) */}
      <div className="flex gap-1 bg-surface rounded-xl p-1">
        {PERIODS.map((p) => (
          <button
            key={p.id}
            onClick={() => setPeriod(p.id)}
            className={`flex-1 min-w-0 py-2 px-1.5 sm:px-3 rounded-lg text-xs sm:text-sm font-medium transition-colors whitespace-nowrap ${
              period === p.id ? 'bg-surface-alt text-text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            <span className="sm:hidden">{p.short}</span>
            <span className="hidden sm:inline">{p.label}</span>
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
              {/* Top-3 podium — shown on every breakpoint (compact on mobile) */}
              {entries.length >= 3 && (
                <div className="grid grid-cols-3 gap-2 sm:gap-3 mb-2 items-end">
                  {[entries[1], entries[0], entries[2]].map((entry, podiumIdx) => {
                    const isFirst = podiumIdx === 1
                    // rank badge styles: gold=1st, slate=2nd, amber=3rd
                    const rankNum = podiumIdx === 0 ? 2 : podiumIdx === 1 ? 1 : 3
                    const isMe = entry.userId === user?.id
                    const rankBadgeCls = isFirst
                      ? 'bg-yellow-500 text-white shadow-lg shadow-yellow-200'
                      : rankNum === 2
                      ? 'bg-slate-400 text-white'
                      : 'bg-amber-600 text-white'
                    const cardCls = isFirst
                      ? 'bg-gradient-to-b from-yellow-500/10 to-surface border-yellow-500/30 shadow-card-md pb-4 sm:pb-5'
                      : 'bg-surface border-border shadow-card pb-3 sm:pb-4'
                    return (
                      <div key={entry.userId} className={`border rounded-xl pt-3 px-1.5 sm:pt-4 sm:px-4 text-center flex flex-col items-center gap-1.5 sm:gap-2 ${cardCls}`}>
                        <div className={`w-7 h-7 sm:w-8 sm:h-8 rounded-full flex items-center justify-center text-xs sm:text-sm font-black flex-shrink-0 ${rankBadgeCls}`}>
                          #{rankNum}
                        </div>
                        <UserAvatar name={entry.fullName || entry.username || '?'} avatarUrl={entry.avatarUrl} size={isFirst ? 'lg' : 'md'} />
                        <div className="w-full min-w-0">
                          <p className={`font-bold text-text-primary truncate ${isFirst ? 'text-sm sm:text-base' : 'text-xs sm:text-sm'}`}>
                            {entry.fullName || entry.username}
                            {isMe && <span className="text-primary"> (you)</span>}
                          </p>
                          <p className="text-[10px] sm:text-xs text-text-muted">{fmtNumber(entry.completedTrades)} trades</p>
                          {entry.totalVolumePKR != null && (
                            <p className="text-[10px] sm:text-xs font-semibold text-text-secondary mt-0.5 truncate">
                              PKR {fmtNumber(entry.totalVolumePKR)}
                            </p>
                          )}
                        </div>
                        {entry.badge && (
                          <Badge variant={badgeVariant(entry.badge)} size="sm">{entry.badgeLabel ?? entry.badge}</Badge>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}

              {/* Desktop table */}
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
                        <tr key={entry.userId} className={`hover:bg-black/[0.03] transition-colors ${rankRowCls(entry.rank, isMe)}`}>
                          <td className="px-4 py-3">
                            <RankDisplay rank={entry.rank} />
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <UserAvatar name={entry.fullName || entry.username || '?'} avatarUrl={entry.avatarUrl} size="sm" />
                              <div>
                                <span className="text-sm font-medium text-text-primary">
                                  {entry.fullName || entry.username}
                                  {isMe && <span className="ml-1 text-primary text-xs">(you)</span>}
                                </span>
                                {entry.fullName && <p className="text-xs text-text-muted">@{entry.username}</p>}
                              </div>
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

              {/* Mobile — top 3 are shown in the podium above, so the list
                  starts from rank 4 (falls back to all if fewer than 3). */}
              <div className="md:hidden space-y-2">
                {(entries.length >= 3 ? entries.slice(3) : entries).map((entry) => {
                  const isMe = entry.userId === user?.id
                  const rowBg = isMe ? 'border-primary/30 bg-primary/5' : entry.rank === 1 ? 'border-yellow-500/30 bg-yellow-500/10 dark:border-yellow-500/30 dark:bg-yellow-500/10' : entry.rank === 2 ? 'border-slate-200 bg-slate-50 dark:border-slate-500/30 dark:bg-slate-500/10' : entry.rank === 3 ? 'border-amber-500/30 bg-amber-500/10 dark:border-amber-500/30 dark:bg-amber-500/10' : 'border-border bg-surface'
                  return (
                    <div
                      key={entry.userId}
                      className={`border rounded-xl px-4 py-3 flex items-center gap-3 shadow-card ${rowBg}`}
                    >
                      <div className="flex-shrink-0 w-8 text-center">
                        <RankDisplay rank={entry.rank} />
                      </div>
                      <UserAvatar name={entry.fullName || entry.username || '?'} avatarUrl={entry.avatarUrl} size="sm" />
                      <div className="flex-1 min-w-0">
                        {/* name truncates but "(you)" never gets clipped */}
                        <p className="text-sm font-semibold text-text-primary flex items-baseline gap-1 min-w-0">
                          <span className="truncate">{entry.fullName || entry.username}</span>
                          {isMe && <span className="text-primary text-xs flex-shrink-0">(you)</span>}
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
