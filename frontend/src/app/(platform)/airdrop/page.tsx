'use client'
import { useState, useEffect, useCallback } from 'react'
import { airdropApi, type AirdropStatus, type AirdropLedgerEntry } from '@/lib/api'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { toast } from '@/lib/toast'
import {
  Sparkles,
  ArrowLeftRight,
  Coins,
  Fuel,
  Gift,
  CalendarCheck,
  Users,
  Flame,
  Settings2,
  RotateCcw,
  Rocket,
  Lock,
  Snowflake,
  Wrench,
} from 'lucide-react'

// ─── Source presentation ────────────────────────────────────────────────────
const SOURCE_META: Record<string, { label: string; Icon: React.ElementType; cls: string; bg: string }> = {
  usdt_trade:   { label: 'USDT Trades',            Icon: ArrowLeftRight, cls: 'text-emerald-500', bg: 'bg-emerald-500/10' },
  ctm_trade:    { label: 'Community Token Trades', Icon: Coins,          cls: 'text-cyan-500',    bg: 'bg-cyan-500/10' },
  gas_order:    { label: 'Gas Orders',             Icon: Fuel,           cls: 'text-orange-500',  bg: 'bg-orange-500/10' },
  referral:     { label: 'Referrals',              Icon: Users,          cls: 'text-pink-500',    bg: 'bg-pink-500/10' },
  checkin:      { label: 'Daily Check-in',         Icon: CalendarCheck,  cls: 'text-blue-500',    bg: 'bg-blue-500/10' },
  social:       { label: 'Social Follows',         Icon: Gift,           cls: 'text-fuchsia-500', bg: 'bg-fuchsia-500/10' },
  streak_bonus: { label: 'Streak Bonus',           Icon: Flame,          cls: 'text-red-500',     bg: 'bg-red-500/10' },
  admin_adjust: { label: 'Adjustment',             Icon: Settings2,      cls: 'text-slate-500',   bg: 'bg-slate-400/10' },
  clawback:     { label: 'Reversal',               Icon: RotateCcw,      cls: 'text-slate-500',   bg: 'bg-slate-400/10' },
}
function sourceMeta(s: string) {
  return SOURCE_META[s] ?? { label: s, Icon: Sparkles, cls: 'text-primary', bg: 'bg-primary/10' }
}

const fmtPoints = (n: number) =>
  (Math.round(n * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d ago`
  return new Date(dateStr).toLocaleDateString()
}

// Qualitative milestone band — we deliberately show a PROGRESS BAR, not a precise
// live user count, so a small early number never reads as "dead" or exposes the
// exact listing trigger. (Recommendation from the airdrop design.)
function milestoneBand(pct: number): string {
  if (pct >= 100) return 'Milestone reached! 🎉'
  if (pct >= 75) return 'Almost there'
  if (pct >= 50) return 'Gaining traction'
  if (pct >= 25) return 'Building momentum'
  return 'Just getting started'
}

function MilestoneBar({ current, target }: { current: number; target: number }) {
  const pct = target > 0 ? Math.min(100, (current / target) * 100) : 0
  return (
    <div className="rounded-2xl border border-border bg-surface p-5">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Rocket className="w-4 h-4 text-primary" aria-hidden />
          <span className="text-sm font-semibold text-text-primary">Road to token listing</span>
        </div>
        <span className="text-xs font-medium text-text-muted">{milestoneBand(pct)}</span>
      </div>
      <div className="h-3 w-full rounded-full bg-surface-alt overflow-hidden">
        <div
          className="h-full rounded-full bg-gradient-to-r from-fuchsia-500 to-primary transition-[width] duration-700"
          style={{ width: `${Math.max(pct, 2)}%` }}
        />
      </div>
      <p className="mt-2 text-xs text-text-muted">
        We unlock our token milestone as the community grows toward{' '}
        {target.toLocaleString()} members. Keep trading to earn your share.
      </p>
    </div>
  )
}

// ─── Locked / "coming soon" state ─────────────────────────────────────────────
function ComingSoon({ status }: { status: AirdropStatus | null }) {
  return (
    <div className="max-w-2xl mx-auto text-center py-10">
      <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-fuchsia-500/10 mb-5">
        <Sparkles className="w-8 h-8 text-fuchsia-500" aria-hidden />
      </div>
      <h1 className="text-2xl font-black text-text-primary mb-2">Airdrop — Coming Soon</h1>
      <p className="text-text-secondary mb-6">
        Every trade, gas order, and referral will soon earn you points toward our
        upcoming token. Points are non-transferable rewards and convert to token at
        listing. Nothing to do yet — just keep using the platform.
      </p>
      <div className="flex items-center justify-center gap-2 text-xs text-text-muted mb-8">
        <Lock className="w-3.5 h-3.5" aria-hidden />
        Earning is not live yet
      </div>
      {status && <MilestoneBar current={status.milestone.current} target={status.milestone.target} />}
    </div>
  )
}

// ─── Streak card ──────────────────────────────────────────────────────────────
function StreakCard({ status, onChange }: { status: AirdropStatus; onChange: () => void }) {
  const s = status.streak
  const [busy, setBusy] = useState<'checkin' | 'repair' | 'reset' | null>(null)
  if (!s) return null

  const doCheckin = async () => {
    setBusy('checkin')
    try {
      const r = await airdropApi.checkin()
      toast.success(
        r.alreadyToday ? 'Already checked in today' : `Checked in! ${s.count === 0 ? 'Streak started' : `Day ${r.streak}`}`,
        r.pointsAwarded > 0 ? `+${r.pointsAwarded} points` : undefined,
      )
      onChange()
    } catch (e) {
      toast.error('Check-in failed', e instanceof Error ? e.message : undefined)
    } finally {
      setBusy(null)
    }
  }
  const doRepair = async () => {
    setBusy('repair')
    try {
      const r = await airdropApi.repairStreak()
      toast.success(`Streak restored to ${r.restored}`, `−${r.cost} points`)
      onChange()
    } catch (e) {
      toast.error('Repair failed', e instanceof Error ? e.message : undefined)
    } finally {
      setBusy(null)
    }
  }
  const doReset = async () => {
    if (!confirm('Reset your streak to zero? This cannot be undone.')) return
    setBusy('reset')
    try {
      await airdropApi.resetStreak()
      toast.success('Streak reset')
      onChange()
    } catch (e) {
      toast.error('Reset failed', e instanceof Error ? e.message : undefined)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-5">
      <div className="flex items-center gap-3">
        <span className="flex items-center justify-center w-12 h-12 rounded-xl bg-red-500/10 flex-shrink-0">
          <Flame className="w-6 h-6 text-red-500" aria-hidden />
        </span>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-2xl font-black text-text-primary tabular-nums">{s.count}</span>
            <span className="text-sm text-text-muted">day streak</span>
            <span className="ml-auto text-xs font-bold text-fuchsia-500 bg-fuchsia-500/10 px-2 py-1 rounded-full">
              {s.multiplier.toFixed(2)}× points
            </span>
          </div>
          <div className="flex items-center gap-3 mt-1 text-xs text-text-muted">
            <span>Best: {s.longest}</span>
            <span className="inline-flex items-center gap-1">
              <Snowflake className="w-3 h-3 text-sky-400" aria-hidden /> {s.freezes} freeze{s.freezes === 1 ? '' : 's'}
            </span>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 mt-4">
        <button
          onClick={doCheckin}
          disabled={s.checkedInToday || busy !== null}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg bg-primary text-white hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <CalendarCheck className="w-4 h-4" aria-hidden />
          {s.checkedInToday ? 'Checked in today' : 'Daily check-in'}
        </button>

        {s.brokenAt && s.canRepair && (
          <button
            onClick={doRepair}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-lg border border-border text-text-primary hover:bg-surface-alt disabled:opacity-50 transition-colors"
          >
            <Wrench className="w-4 h-4" aria-hidden />
            Repair streak ({s.repairCost} pts, {s.repairsLeft} left)
          </button>
        )}

        {s.count > 0 && (
          <button
            onClick={doReset}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-alt disabled:opacity-50 transition-colors ml-auto"
          >
            <RotateCcw className="w-3.5 h-3.5" aria-hidden />
            Reset
          </button>
        )}
      </div>

      {s.brokenAt && !s.canRepair && s.preBreakStreak > s.count && (
        <p className="mt-3 text-xs text-text-muted">
          Your {s.preBreakStreak}-day streak broke. {s.repairsLeft > 0 ? 'The repair window has closed or you need more points.' : 'No repairs left this season.'}
        </p>
      )}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function AirdropPage() {
  const [status, setStatus] = useState<AirdropStatus | null>(null)
  const [ledger, setLedger] = useState<AirdropLedgerEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const fetchData = useCallback(async () => {
    try {
      const st = await airdropApi.getStatus()
      setStatus(st)
      if (st.enabled) {
        const led = await airdropApi.getLedger()
        setLedger(led.entries)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load airdrop data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchData()
  }, [fetchData])

  if (loading) return <LoadingState />
  if (error) return <ErrorState description={error} onRetry={fetchData} />
  if (!status || !status.enabled) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <ComingSoon status={status} />
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
      {/* Header + total */}
      <div className="rounded-2xl border border-border bg-gradient-to-br from-fuchsia-500/10 to-primary/5 p-6">
        <div className="flex items-center gap-2 mb-1">
          <Sparkles className="w-5 h-5 text-fuchsia-500" aria-hidden />
          <h1 className="text-lg font-black text-text-primary">Airdrop Points</h1>
          {status.season && (
            <span className="ml-auto text-xs font-semibold text-text-muted bg-surface px-2 py-1 rounded-full border border-border">
              {status.season.name}
            </span>
          )}
        </div>
        <p className="text-4xl font-black text-text-primary tabular-nums">{fmtPoints(status.totalPoints)}</p>
        <p className="text-sm text-text-muted mt-1">points earned this season</p>
      </div>

      {/* Streak */}
      <StreakCard status={status} onChange={fetchData} />

      {/* Milestone */}
      <MilestoneBar current={status.milestone.current} target={status.milestone.target} />

      {/* Where your points come from */}
      <div className="rounded-2xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold text-text-primary mb-3">Where your points come from</h2>
        {status.breakdown.length === 0 ? (
          <p className="text-sm text-text-muted py-4 text-center">
            No points yet — complete a trade, buy gas, or refer a friend to start earning.
          </p>
        ) : (
          <div className="space-y-2">
            {status.breakdown.map((b) => {
              const m = sourceMeta(b.source)
              const share = status.totalPoints > 0 ? (b.points / status.totalPoints) * 100 : 0
              return (
                <div key={b.source} className="flex items-center gap-3">
                  <span className={`flex items-center justify-center w-8 h-8 rounded-lg flex-shrink-0 ${m.bg}`}>
                    <m.Icon className={`w-4 h-4 ${m.cls}`} aria-hidden />
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-text-primary truncate">{m.label}</span>
                      <span className="text-sm font-semibold text-text-primary tabular-nums">{fmtPoints(b.points)}</span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-surface-alt overflow-hidden mt-1">
                      <div className="h-full rounded-full bg-primary/70" style={{ width: `${Math.max(share, 2)}%` }} />
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Recent activity */}
      <div className="rounded-2xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold text-text-primary mb-3">Recent activity</h2>
        {ledger.length === 0 ? (
          <p className="text-sm text-text-muted py-4 text-center">No point activity yet.</p>
        ) : (
          <div className="divide-y divide-border">
            {ledger.map((e) => {
              const m = sourceMeta(e.source)
              const positive = e.points >= 0
              return (
                <div key={e.id} className="flex items-center gap-3 py-2.5">
                  <span className={`flex items-center justify-center w-8 h-8 rounded-lg flex-shrink-0 ${m.bg}`}>
                    <m.Icon className={`w-4 h-4 ${m.cls}`} aria-hidden />
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-text-primary truncate">{m.label}</p>
                    <p className="text-xs text-text-muted">{timeAgo(e.createdAt)}</p>
                  </div>
                  <span className={`text-sm font-semibold tabular-nums ${positive ? 'text-emerald-500' : 'text-danger'}`}>
                    {positive ? '+' : ''}{fmtPoints(e.points)}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <p className="text-xs text-text-muted text-center px-4">
        Points are non-transferable loyalty rewards. Your final token share equals your
        points ÷ the season total × the season pool, so more points means a bigger share.
      </p>
    </div>
  )
}
