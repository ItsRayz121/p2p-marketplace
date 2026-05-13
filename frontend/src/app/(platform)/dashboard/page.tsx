'use client'
import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { dashboardApi, tradesApi, notificationsApi } from '@/lib/api'
import type { WalletBalance, Trade, Notification } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'

const SOURCE_LABELS: Record<string, { label: string; url: string }> = {
  coingecko: { label: 'CoinGecko', url: 'https://www.coingecko.com' },
  kraken:    { label: 'Kraken',    url: 'https://www.kraken.com' },
  bybit:     { label: 'Bybit',     url: 'https://www.bybit.com' },
  binance:   { label: 'Binance',   url: 'https://www.binance.com' },
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface DashboardSummary {
  totalTrades: number
  activeTrades: number
  completedTrades: number
  totalVolumeUsd: string
  balance: WalletBalance[]
}

interface InstantOrder {
  id: string
  status: string
  coin: string
  amount: string
  amountPkr: string
  createdAt: string
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function tradeStatusVariant(status: string): 'success' | 'warning' | 'danger' | 'default' {
  if (status === 'released') return 'success'
  if (status === 'disputed') return 'danger'
  if (status === 'cancelled' || status === 'expired') return 'danger'
  if (status === 'pending' || status === 'paid') return 'warning'
  return 'default'
}

function kycBadgeVariant(status: string): 'success' | 'warning' | 'danger' | 'default' {
  if (status === 'approved') return 'success'
  if (status === 'pending') return 'warning'
  if (status === 'rejected') return 'danger'
  return 'default'
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { user } = useAuth()
  const [summary, setSummary] = useState<DashboardSummary | null>(null)
  const [trades, setTrades] = useState<Trade[]>([])
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [instantOrders, setInstantOrders] = useState<InstantOrder[]>([])
  const [usdtRate, setUsdtRate] = useState<number>(0)
  const [usdtRateSource, setUsdtRateSource] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchAll = useCallback(async () => {
    try {
      const [summaryRes, tradesRes, notifRes] = await Promise.allSettled([
        dashboardApi.getSummary(),
        tradesApi.getMyTrades({ limit: 5 }),
        notificationsApi.getAll({ limit: 5, unreadOnly: true }),
      ])

      if (summaryRes.status === 'fulfilled') setSummary(summaryRes.value)
      if (tradesRes.status === 'fulfilled') setTrades(tradesRes.value.trades)
      if (notifRes.status === 'fulfilled') setNotifications(notifRes.value.notifications)

      // Try getting USDT rate for PKR equivalent
      try {
        const rateRes = await fetch('/api/v1/marketplace/rate/USDT', { credentials: 'include' })
        if (rateRes.ok) {
          const d = await rateRes.json() as { rate: number; source?: string }
          setUsdtRate(d.rate)
          setUsdtRateSource(d.source ?? '')
        }
      } catch { /* optional */ }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])

  if (loading) return <LoadingState message="Loading dashboard..." />
  if (error) return <ErrorState title={error} onRetry={fetchAll} />

  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const displayName = user?.username || user?.fullName || 'Trader'

  const kycStatus = user?.kycStatus ?? 'none'
  const dailyUsed = user?.dailyBuyUsed ?? 0
  const dailyLimit = user?.dailyBuyLimit ?? 0
  const dailyPct = dailyLimit > 0 ? Math.min((dailyUsed / dailyLimit) * 100, 100) : 0

  const emailVerified = user?.isEmailVerified ?? false
  const kycApproved = kycStatus === 'approved'
  const hasBalance = (summary?.balance ?? []).some((b) => parseFloat(b.available) > 0)
  const hasCompletedTrade = (summary?.completedTrades ?? 0) > 0

  const onboardingDone = emailVerified && kycApproved && hasBalance && hasCompletedTrade

  const notifIconColor: Record<string, string> = {
    trade: 'text-primary',
    kyc: 'text-warning',
    wallet: 'text-success',
    system: 'text-text-muted',
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 pb-24 lg:pb-6 space-y-6">
      {/* ── 1. Welcome bar ── */}
      <div className="bg-white rounded-xl border border-border p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-text-primary">{greeting}, {displayName}!</h1>
            <div className="flex items-center gap-2 mt-1">
              <Badge variant={kycBadgeVariant(kycStatus)} size="sm">
                KYC: {kycStatus.charAt(0).toUpperCase() + kycStatus.slice(1)}
              </Badge>
            </div>
          </div>
          {kycStatus !== 'approved' && (
            <Link href="/kyc">
              <Button size="sm" variant="secondary">Upgrade KYC</Button>
            </Link>
          )}
        </div>
        {dailyLimit > 0 && (
          <div className="mt-4">
            <div className="flex justify-between text-xs text-text-muted mb-1">
              <span>Daily Buy Used</span>
              <span>PKR {dailyUsed.toLocaleString()} / {dailyLimit.toLocaleString()}</span>
            </div>
            <div className="h-2 bg-surface rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all"
                style={{ width: `${dailyPct}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* ── 2. Portfolio ── */}
      <section>
        <h2 className="text-base font-semibold text-text-primary mb-3">Portfolio</h2>
        {summary?.balance && summary.balance.length > 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {summary.balance.map((b) => (
              <div key={b.coin} className="bg-white rounded-xl border border-border p-4">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-8 h-8 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center">
                    {b.coin.slice(0, 2)}
                  </div>
                  <span className="text-sm font-medium text-text-primary">{b.coin}</span>
                </div>
                <p className="text-lg font-bold text-text-primary">{parseFloat(b.available).toFixed(4)}</p>
                {usdtRate > 0 && b.coin === 'USDT' && (
                  <div className="mt-0.5">
                    <p className="text-xs text-text-muted">
                      ≈ PKR {(parseFloat(b.available) * usdtRate).toLocaleString()}
                    </p>
                    {SOURCE_LABELS[usdtRateSource] && (
                      <a
                        href={SOURCE_LABELS[usdtRateSource].url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[10px] text-text-muted hover:text-primary"
                      >
                        via {SOURCE_LABELS[usdtRateSource].label}
                      </a>
                    )}
                  </div>
                )}
                <p className="text-xs text-text-muted mt-0.5">
                  Locked: {parseFloat(b.locked).toFixed(4)}
                </p>
                <Link href="/wallet">
                  <Button size="sm" variant="secondary" className="w-full mt-3">Deposit</Button>
                </Link>
              </div>
            ))}
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-border p-6 text-center text-sm text-text-muted">
            No balances. <Link href="/wallet" className="text-primary underline">Deposit now</Link>
          </div>
        )}
      </section>

      {/* ── 3. Quick Actions ── */}
      <section>
        <h2 className="text-base font-semibold text-text-primary mb-3">Quick Actions</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { href: '/instant-buy', label: 'Buy Crypto', icon: '⚡' },
            { href: '/marketplace', label: 'Marketplace', icon: '🏪' },
            { href: '/ads', label: 'My Ads', icon: '📢' },
            { href: '/referral', label: 'Referral', icon: '🎁' },
          ].map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="flex flex-col items-center gap-2 bg-white rounded-xl border border-border p-4 hover:border-primary/40 hover:shadow-sm transition-all text-center"
            >
              <span className="text-2xl">{item.icon}</span>
              <span className="text-xs font-medium text-text-primary">{item.label}</span>
            </Link>
          ))}
        </div>
      </section>

      {/* ── 4. Recent Trades ── */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold text-text-primary">Recent Trades</h2>
          <Link href="/orders" className="text-xs text-primary hover:underline">View all</Link>
        </div>
        <div className="bg-white rounded-xl border border-border divide-y divide-border">
          {trades.length === 0 ? (
            <p className="text-sm text-text-muted text-center py-6">No trades yet.</p>
          ) : (
            trades.slice(0, 5).map((t) => {
              const isUserBuyer = t.buyerId === user?.id
              const counterparty = isUserBuyer
                ? (t.seller?.username || 'Seller')
                : (t.buyer?.username || 'Buyer')
              return (
                <Link key={t.id} href={`/trade/${t.id}`} className="flex items-center justify-between px-4 py-3 hover:bg-surface transition-colors">
                  <div className="flex items-center gap-3">
                    <Badge variant={tradeStatusVariant(t.status)} size="sm">{t.status}</Badge>
                    <span className="text-sm text-text-primary">{counterparty}</span>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-medium text-text-primary">{parseFloat(t.amount).toFixed(4)} {t.coin}</p>
                    <p className="text-xs text-text-muted">{timeAgo(t.createdAt)}</p>
                  </div>
                </Link>
              )
            })
          )}
        </div>
      </section>

      {/* ── 5. Recent Instant Buy ── */}
      {instantOrders.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold text-text-primary">Recent Instant Buy</h2>
          </div>
          <div className="bg-white rounded-xl border border-border divide-y divide-border">
            {instantOrders.slice(0, 3).map((o) => (
              <div key={o.id} className="flex items-center justify-between px-4 py-3">
                <div className="flex items-center gap-3">
                  <Badge variant={o.status === 'completed' ? 'success' : 'warning'} size="sm">{o.status}</Badge>
                  <span className="text-sm text-text-primary">{parseFloat(o.amount).toFixed(4)} {o.coin}</span>
                </div>
                <Button size="sm" variant="secondary" onClick={() => {}}>Repeat</Button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── 6. Trader Badge ── */}
      <section>
        <div className="bg-white rounded-xl border border-border p-5">
          <h2 className="text-base font-semibold text-text-primary mb-3">Trader Badge</h2>
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-full bg-gold/10 text-gold text-lg font-bold flex items-center justify-center border-2 border-gold/30">
              {summary && summary.completedTrades >= 100 ? '💎' : summary && summary.completedTrades >= 50 ? '🥇' : summary && summary.completedTrades >= 10 ? '🥈' : '🥉'}
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold text-text-primary">
                {summary && summary.completedTrades >= 100 ? 'Diamond' : summary && summary.completedTrades >= 50 ? 'Gold' : summary && summary.completedTrades >= 10 ? 'Silver' : 'Bronze'} Trader
              </p>
              <p className="text-xs text-text-muted">{summary?.completedTrades ?? 0} completed trades</p>
              <div className="h-2 bg-surface rounded-full overflow-hidden mt-2">
                <div
                  className="h-full bg-gold rounded-full transition-all"
                  style={{ width: `${Math.min(((summary?.completedTrades ?? 0) % 50) * 2, 100)}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── 7. Notifications ── */}
      {notifications.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold text-text-primary">Notifications</h2>
            <Link href="/notifications" className="text-xs text-primary hover:underline">View all</Link>
          </div>
          <div className="bg-white rounded-xl border border-border divide-y divide-border">
            {notifications.map((n) => (
              <div key={n.id} className="flex items-start gap-3 px-4 py-3">
                <div className={`mt-0.5 ${notifIconColor[n.type] ?? 'text-text-muted'}`}>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
                    />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-text-primary">{n.title}</p>
                  <p className="text-xs text-text-muted truncate">{n.body}</p>
                </div>
                <span className="text-xs text-text-muted flex-shrink-0">{timeAgo(n.createdAt)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── 8. Onboarding Checklist ── */}
      {!onboardingDone && (
        <section>
          <div className="bg-white rounded-xl border border-border p-5">
            <h2 className="text-base font-semibold text-text-primary mb-4">Getting Started</h2>
            <div className="space-y-3">
              <ChecklistRow done={emailVerified} label="Verify your email" href="/settings" />
              <ChecklistRow done={kycApproved} label="Submit KYC verification" href="/kyc" />
              <ChecklistRow done={hasBalance} label="Fund your wallet" href="/wallet" />
              <ChecklistRow done={hasCompletedTrade} label="Complete your first trade" href="/marketplace" />
            </div>
          </div>
        </section>
      )}
    </div>
  )
}

function ChecklistRow({ done, label, href }: { done: boolean; label: string; href: string }) {
  return (
    <div className="flex items-center gap-3">
      <div className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 ${done ? 'bg-success text-white' : 'border-2 border-border'}`}>
        {done && (
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
          </svg>
        )}
      </div>
      <span className={`text-sm ${done ? 'line-through text-text-muted' : 'text-text-primary'}`}>{label}</span>
      {!done && (
        <Link href={href} className="ml-auto text-xs text-primary hover:underline">
          Go
        </Link>
      )}
    </div>
  )
}
