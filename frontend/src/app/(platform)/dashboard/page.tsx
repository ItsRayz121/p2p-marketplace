'use client'
import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { dashboardApi, tradesApi, notificationsApi, marketplaceApi, gasApi } from '@/lib/api'
import type { WalletBalance, Trade, Notification } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { TraderLevelCard, BadgeChip } from '@/components/ui/TraderLevelCard'
import type { TraderBadge } from '@/components/ui/TraderLevelCard'
import { getTradeStatus, getGasStatus, kycStatusVariant } from '@/lib/tradeStatus'
import { cn } from '@/lib/utils'
import {
  Fuel,
  ArrowLeftRight,
  Coins,
  ClipboardList,
  Wallet,
  Gift,
  Bell,
} from 'lucide-react'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { EntityLogo } from '@/components/ui/EntityLogo'

const SOURCE_LABELS: Record<string, { label: string; url: string }> = {
  coingecko: { label: 'CoinGecko', url: 'https://www.coingecko.com' },
  kraken:    { label: 'Kraken',    url: 'https://www.kraken.com' },
  bybit:     { label: 'Bybit',     url: 'https://www.bybit.com' },
  binance:   { label: 'Binance',   url: 'https://www.binance.com' },
}

// Tints use the `/10` opacity pattern (same as the navbar dropdown) so each
// colour stays vivid in light mode AND adapts correctly on dark surfaces —
// unlike raw `bg-blue-100` etc., which render as a fixed pale colour in dark mode.
const QUICK_ACTIONS = [
  { href: '/marketplace', label: 'USDT Market',      Icon: ArrowLeftRight, iconCls: 'text-blue-500',    bgCls: 'bg-blue-500/10'    },
  { href: '/ctm',         label: 'Tokens',           Icon: Coins,          iconCls: 'text-pink-500',    bgCls: 'bg-pink-500/10'    },
  { href: '/gas',         label: 'Gas Fees',         Icon: Fuel,           iconCls: 'text-amber-500',   bgCls: 'bg-amber-500/10'   },
  { href: '/wallet',      label: 'Wallet',           Icon: Wallet,         iconCls: 'text-cyan-500',    bgCls: 'bg-cyan-500/10'    },
  { href: '/orders',      label: 'My Trades',        Icon: ClipboardList,  iconCls: 'text-emerald-500', bgCls: 'bg-emerald-500/10' },
  { href: '/referral',    label: 'Referral',         Icon: Gift,           iconCls: 'text-pink-500',    bgCls: 'bg-pink-500/10'    },
]

// ─── Types ────────────────────────────────────────────────────────────────────

interface DashboardSummary {
  wallets: WalletBalance[]
  tradeStats: {
    completedTrades: number
    totalTrades: number
    completionRate: number | null
    totalVolumePKR: string | null
    badge: string | null
    badgeLabel: string | null
    trustScore: number | null
  } | null
  ctmCompletedTrades?: number
  gasCompletedOrders?: number
  crossPlatformCompletionRate?: number | null
}

interface RecentGasOrder {
  orderRef: string
  chain: string
  gasAmountNative: string
  status: string
  createdAt: string
  deliveryTxHash?: string | null
}

const GAS_NATIVE_SYMBOL: Record<string, string> = {
  TRON: 'TRX', BSC: 'BNB', ETH: 'ETH', SOL: 'SOL',
  MATIC: 'POL', ARB: 'ETH', BASE: 'ETH', OP: 'ETH',
  AVAX: 'AVAX', TON: 'TON', SUI: 'SUI', APT: 'APT',
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function computeEffectiveBadge(completedTrades: number, completionRate: number): TraderBadge {
  if (completedTrades >= 500 && completionRate >= 0.98) return 'elite'
  if (completedTrades >= 200 && completionRate >= 0.95) return 'top'
  if (completedTrades >= 50  && completionRate >= 0.90) return 'trusted'
  if (completedTrades >= 5   && completionRate >= 0.80) return 'active'
  return 'new'
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { user } = useAuth()
  const [summary, setSummary] = useState<DashboardSummary | null>(null)
  const [trades, setTrades] = useState<Trade[]>([])
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [gasOrders, setGasOrders] = useState<RecentGasOrder[]>([])
  const [usdtRate, setUsdtRate] = useState<number>(0)
  const [usdtRateSource, setUsdtRateSource] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchAll = useCallback(async () => {
    try {
      const [summaryRes, tradesRes, notifRes, gasRes] = await Promise.allSettled([
        dashboardApi.getSummary(),
        tradesApi.getMyTrades({ limit: 5 }),
        notificationsApi.getAll({ limit: 5, unreadOnly: true }),
        gasApi.getOrderHistory({ limit: 3, page: 1 }),
      ])

      if (summaryRes.status === 'fulfilled') setSummary(summaryRes.value)
      if (tradesRes.status === 'fulfilled') setTrades(tradesRes.value.trades ?? [])
      if (notifRes.status === 'fulfilled') setNotifications(notifRes.value.notifications ?? [])
      if (gasRes.status === 'fulfilled') setGasOrders((gasRes.value.orders ?? []).slice(0, 3) as RecentGasOrder[])

      // USDT rate for PKR equivalent — optional, never block dashboard render.
      // Use the API client so requests resolve to the configured backend origin
      // (Vercel has no /api/v1 route — a relative fetch always 404s in prod).
      try {
        const rate = await marketplaceApi.getRate('USDT')
        setUsdtRate(rate.rate)
        setUsdtRateSource(rate.source ?? '')
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
  const displayName = user?.fullName || user?.username || 'Trader'

  const kycStatus = user?.kycStatus ?? 'none'
  const dailyUsed = user?.dailyBuyUsed ?? 0
  const dailyLimit = user?.dailyBuyLimit ?? 0
  const dailyPct = dailyLimit > 0 ? Math.min((dailyUsed / dailyLimit) * 100, 100) : 0

  const emailVerified = user?.isEmailVerified ?? false
  const kycApproved = kycStatus === 'approved'
  const hasBalance = (summary?.wallets ?? []).some((b) => parseFloat(b.available) > 0)
  // tradeStats.completedTrades is now the unified count (USDT + CTM + Gas)
  const totalCompletedTrades = summary?.tradeStats?.completedTrades ?? 0
  const hasCompletedTrade = totalCompletedTrades > 0

  const crossPlatformCompletionRate =
    summary?.crossPlatformCompletionRate ??
    user?.tradeStats?.completionRate ??
    0

  const effectiveBadge = computeEffectiveBadge(totalCompletedTrades, crossPlatformCompletionRate)

  const onboardingDone = emailVerified && kycApproved && hasBalance && hasCompletedTrade

  // Aggregate raw wallet rows by coin (a coin can have rows on multiple networks)
  // so we never render duplicate/phantom cards or collide on React keys.
  const portfolioCards = (() => {
    const byCoin = new Map<string, { coin: string; available: number; locked: number }>()
    for (const w of summary?.wallets ?? []) {
      const prev = byCoin.get(w.coin) ?? { coin: w.coin, available: 0, locked: 0 }
      prev.available += parseFloat(w.available ?? '0') || 0
      prev.locked += parseFloat(w.locked ?? '0') || 0
      byCoin.set(w.coin, prev)
    }
    // Always show a USDT card (0.0000 if the user has none); show other coins
    // (BNB / gas tokens) only when there is a real non-zero balance.
    if (!byCoin.has('USDT')) byCoin.set('USDT', { coin: 'USDT', available: 0, locked: 0 })
    return [...byCoin.values()]
      .filter((c) => c.coin === 'USDT' || c.available + c.locked > 0)
      .sort((a, b) => (a.coin === 'USDT' ? -1 : b.coin === 'USDT' ? 1 : 0))
  })()

  const usdtBalance = portfolioCards.find((b) => b.coin === 'USDT')
  const totalPortfolioPkr = usdtRate > 0 && usdtBalance
    ? usdtBalance.available * usdtRate
    : null

  const notifIconColor: Record<string, string> = {
    trade:  'text-primary',
    kyc:    'text-warning',
    wallet: 'text-success',
    system: 'text-text-muted',
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
      {/* ── 1. Welcome bar ── */}
      <div className="bg-surface rounded-xl border border-border shadow-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <UserAvatar name={displayName} avatarUrl={user?.avatarUrl} size="lg" className="flex-shrink-0" />
            <div>
            <p className="text-sm text-text-muted">{greeting}</p>
            <h1 className="text-xl font-bold text-text-primary">{displayName}</h1>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <Link href="/kyc">
                <Badge variant={kycStatusVariant(kycStatus)} size="sm">
                  {kycStatus === 'approved'
                    ? `KYC LV${user?.kycLevel === 'enhanced' ? 2 : 1}: Approved`
                    : `KYC: ${kycStatus.charAt(0).toUpperCase() + kycStatus.slice(1)}`}
                </Badge>
              </Link>
              <BadgeChip badge={effectiveBadge} />
            </div>
            </div>
          </div>
          {totalPortfolioPkr !== null && totalPortfolioPkr > 0 && (
            <div className="text-right">
              <p className="text-xs text-text-muted">USDT Balance (PKR)</p>
              <p className="text-2xl font-bold text-text-primary">PKR {Math.round(totalPortfolioPkr).toLocaleString()}</p>
              {(summary?.tradeStats?.totalVolumePKR ?? null) && (
                <p className="text-xs text-text-muted">Vol: PKR {Number(summary!.tradeStats!.totalVolumePKR).toLocaleString()}</p>
              )}
            </div>
          )}
          {kycStatus !== 'approved' && (
            <Link href="/kyc">
              <Button size="sm" variant="secondary">Upgrade KYC</Button>
            </Link>
          )}
        </div>
        {dailyLimit > 0 && (
          <div className="mt-4">
            <div className="flex justify-between text-xs text-text-muted mb-1">
              <span>Daily trading used</span>
              <span>PKR {dailyUsed.toLocaleString()} / {dailyLimit.toLocaleString()}</span>
            </div>
            <div className="h-2 bg-surface-alt rounded-full overflow-hidden">
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
        {portfolioCards.length > 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {portfolioCards.map((b) => (
              <div key={b.coin} className="bg-surface rounded-xl border border-border shadow-card p-4 hover:shadow-card-md transition-shadow">
                <div className="flex items-center gap-2 mb-2">
                  <EntityLogo type="token" slug={b.coin} size="sm" className="flex-shrink-0" />
                  <span className="text-sm font-medium text-text-primary">{b.coin}</span>
                </div>
                {(() => {
                  const avail = b.available
                  const locked = b.locked
                  const total = avail + locked
                  const pkr = avail * usdtRate
                  return (
                    <>
                      <div className="space-y-0.5 mt-1">
                        <div className="flex justify-between items-baseline">
                          <span className="text-xs text-text-muted">Available</span>
                          <span className="text-base font-bold text-text-primary">{avail.toFixed(4)}</span>
                        </div>
                        {locked > 0 && (
                          <div className="flex justify-between items-baseline">
                            <span className="text-xs text-text-muted">Locked</span>
                            <span className="text-xs text-text-secondary">{locked.toFixed(4)}</span>
                          </div>
                        )}
                        <div className="flex justify-between items-baseline border-t border-border pt-0.5">
                          <span className="text-xs text-text-muted">Total</span>
                          <span className="text-xs text-text-secondary">{total.toFixed(4)}</span>
                        </div>
                      </div>
                      {usdtRate > 0 && b.coin === 'USDT' && (
                        <div className="mt-1">
                          <p className="text-xs text-text-muted">
                            ≈ PKR {Math.round(pkr).toLocaleString()}
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
                    </>
                  )
                })()}
                <Link href="/wallet">
                  <Button size="sm" variant="secondary" className="w-full mt-3">Deposit</Button>
                </Link>
              </div>
            ))}
          </div>
        ) : (
          <div className="bg-surface rounded-xl border border-border shadow-card p-6 text-center text-sm text-text-muted">
            No balances yet. <Link href="/wallet" className="text-primary hover:underline font-medium">Deposit now</Link>
          </div>
        )}
      </section>

      {/* ── 3. Quick Actions ── */}
      <section>
        <h2 className="text-base font-semibold text-text-primary mb-3">Quick Actions</h2>
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
          {QUICK_ACTIONS.map(({ href, label, Icon, iconCls, bgCls }) => (
            <Link
              key={href}
              href={href}
              className="flex flex-col items-center gap-2 bg-surface rounded-xl border border-border shadow-card p-4 hover:border-primary/30 hover:shadow-card-md transition-all text-center group"
            >
              <div className={cn('w-11 h-11 rounded-xl flex items-center justify-center transition-colors', bgCls)}>
                <Icon className={cn('w-5 h-5', iconCls)} aria-hidden />
              </div>
              <span className="text-xs font-medium text-text-secondary group-hover:text-text-primary transition-colors leading-tight">{label}</span>
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
        <div className="bg-surface rounded-xl border border-border shadow-card divide-y divide-border">
          {(trades ?? []).length === 0 ? (
            <p className="text-sm text-text-muted text-center py-6">No trades yet.</p>
          ) : (
            (trades ?? []).slice(0, 5).map((t) => {
              const isUserBuyer = t.buyerId === user?.id
              const counterparty = isUserBuyer
                ? (t.seller?.fullName || t.seller?.username || 'Seller')
                : (t.buyer?.fullName || t.buyer?.username || 'Buyer')
              const ts = getTradeStatus(t.status)
              return (
                <Link key={t.id} href={`/trade/${t.id}`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-surface-alt/60 transition-colors">
                  {/* Name first (always aligned at the avatar offset) with the
                      status badge stacked beneath it — status labels vary in
                      width, so keeping them out of the name's column is what
                      stops the counterparty names from zig-zagging. */}
                  <div className="flex items-center gap-2 min-w-0">
                    <UserAvatar name={counterparty} avatarUrl={isUserBuyer ? t.seller?.avatarUrl : t.buyer?.avatarUrl} size="xs" className="flex-shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm text-text-primary truncate">{counterparty}</p>
                      <Badge variant={ts.variant} icon={ts.icon} size="sm" className="mt-0.5 whitespace-nowrap">{ts.label}</Badge>
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-sm font-medium text-text-primary whitespace-nowrap">{parseFloat(t.amount).toFixed(4)} {t.coin}</p>
                    <p className="text-xs text-text-muted">{timeAgo(t.createdAt)}</p>
                  </div>
                </Link>
              )
            })
          )}
        </div>
      </section>

      {/* ── 5. Recent Gas Orders ── */}
      {gasOrders.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold text-text-primary">Recent Gas Orders</h2>
            <Link href="/gas/orders" className="text-xs text-primary hover:underline">View all</Link>
          </div>
          <div className="bg-surface rounded-xl border border-border shadow-card divide-y divide-border">
            {gasOrders.map((o) => {
              const symbol = GAS_NATIVE_SYMBOL[o.chain] ?? o.chain
              const gs = getGasStatus(o.status)
              return (
                <div key={o.orderRef} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <Badge variant={gs.variant} icon={gs.icon} size="sm">{gs.label}</Badge>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text-primary whitespace-nowrap">
                        {parseFloat(o.gasAmountNative).toFixed(4)} {symbol}
                      </p>
                      <p className="text-xs text-text-muted font-mono truncate">{o.orderRef}</p>
                    </div>
                  </div>
                  <span className="text-xs text-text-muted whitespace-nowrap flex-shrink-0">{timeAgo(o.createdAt)}</span>
                </div>
              )
            })}
          </div>
        </section>
      )}


      {/* ── 7. Trader Badge ── */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold text-text-primary">Your Trader Level</h2>
          <Link href="/levels" className="text-xs text-primary hover:underline">How levels work</Link>
        </div>
        <TraderLevelCard
          badge={effectiveBadge}
          trustScore={user?.tradeStats?.trustScore ?? summary?.tradeStats?.trustScore ?? 0}
          completedTrades={totalCompletedTrades}
          completionRate={crossPlatformCompletionRate}
          kycStatus={kycStatus}
        />
      </section>

      {/* ── 8. Notifications ── */}
      {(notifications ?? []).length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold text-text-primary">Notifications</h2>
            <Link href="/notifications" className="text-xs text-primary hover:underline">View all</Link>
          </div>
          <div className="bg-surface rounded-xl border border-border shadow-card divide-y divide-border">
            {(notifications ?? []).map((n) => (
              <div key={n.id} className="flex items-start gap-3 px-4 py-3">
                <Bell
                  className={`w-4 h-4 mt-0.5 flex-shrink-0 ${notifIconColor[n.type] ?? 'text-text-muted'}`}
                  aria-hidden
                />
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

      {/* ── 9. Onboarding Checklist ── */}
      {!onboardingDone && (
        <section>
          <div className="bg-surface rounded-xl border border-border shadow-card p-5">
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
