'use client'
import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { dashboardApi, tradesApi, notificationsApi, marketplaceApi, instantBuyApi, gasApi } from '@/lib/api'
import type { WalletBalance, Trade, Notification } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { TraderLevelCard, BadgeChip } from '@/components/ui/TraderLevelCard'
import type { TraderBadge } from '@/components/ui/TraderLevelCard'
import { getTradeStatus, getGasStatus, kycStatusVariant } from '@/lib/tradeStatus'
import {
  Fuel,
  Store,
  Coins,
  ClipboardList,
  Wallet,
  Gift,
  Bell,
} from 'lucide-react'

const SOURCE_LABELS: Record<string, { label: string; url: string }> = {
  coingecko: { label: 'CoinGecko', url: 'https://www.coingecko.com' },
  kraken:    { label: 'Kraken',    url: 'https://www.kraken.com' },
  bybit:     { label: 'Bybit',     url: 'https://www.bybit.com' },
  binance:   { label: 'Binance',   url: 'https://www.binance.com' },
}

const QUICK_ACTIONS = [
  { href: '/gas',         label: 'Crypto Gas Fees',  Icon: Fuel          },
  { href: '/marketplace', label: 'USDT Marketplace', Icon: Store         },
  { href: '/ctm',         label: 'Community Tokens', Icon: Coins         },
  { href: '/orders',      label: 'My Trades',        Icon: ClipboardList },
  { href: '/wallet',      label: 'Wallet',           Icon: Wallet        },
  { href: '/referral',    label: 'Referral',         Icon: Gift          },
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
}

interface InstantOrder {
  id: string
  status: string
  coin: string
  amount: string
  amountPkr: string
  createdAt: string
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
  const [instantOrders, setInstantOrders] = useState<InstantOrder[]>([])
  const [gasOrders, setGasOrders] = useState<RecentGasOrder[]>([])
  const [usdtRate, setUsdtRate] = useState<number>(0)
  const [usdtRateSource, setUsdtRateSource] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchAll = useCallback(async () => {
    try {
      const [summaryRes, tradesRes, notifRes, instantRes, gasRes] = await Promise.allSettled([
        dashboardApi.getSummary(),
        tradesApi.getMyTrades({ limit: 5 }),
        notificationsApi.getAll({ limit: 5, unreadOnly: true }),
        instantBuyApi.getMyOrders({ limit: 3 }),
        gasApi.getOrderHistory({ limit: 3, page: 1 }),
      ])

      if (summaryRes.status === 'fulfilled') setSummary(summaryRes.value)
      if (tradesRes.status === 'fulfilled') setTrades(tradesRes.value.trades ?? [])
      if (notifRes.status === 'fulfilled') setNotifications(notifRes.value.notifications ?? [])
      if (instantRes.status === 'fulfilled') setInstantOrders(instantRes.value.orders ?? [])
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
  const displayName = user?.username || user?.fullName || 'Trader'

  const kycStatus = user?.kycStatus ?? 'none'
  const dailyUsed = user?.dailyBuyUsed ?? 0
  const dailyLimit = user?.dailyBuyLimit ?? 0
  const dailyPct = dailyLimit > 0 ? Math.min((dailyUsed / dailyLimit) * 100, 100) : 0

  const emailVerified = user?.isEmailVerified ?? false
  const kycApproved = kycStatus === 'approved'
  const hasBalance = (summary?.wallets ?? []).some((b) => parseFloat(b.available) > 0)
  const hasCompletedTrade =
    (summary?.tradeStats?.completedTrades ?? 0) + (summary?.ctmCompletedTrades ?? 0) > 0

  const onboardingDone = emailVerified && kycApproved && hasBalance && hasCompletedTrade

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
          <div>
            <h1 className="text-xl font-bold text-text-primary">{greeting}, {displayName}!</h1>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <Link href="/kyc">
                <Badge variant={kycStatusVariant(kycStatus)} size="sm">
                  {kycStatus === 'approved'
                    ? `KYC LV${user?.kycLevel === 'enhanced' ? 2 : 1}: Approved`
                    : `KYC: ${kycStatus.charAt(0).toUpperCase() + kycStatus.slice(1)}`}
                </Badge>
              </Link>
              {user?.tradeStats && (
                <BadgeChip badge={user.tradeStats.badge as TraderBadge} badgeLabel={user.tradeStats.badgeLabel ?? undefined} />
              )}
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
              <span>Daily trading used</span>
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
        {summary?.wallets && summary.wallets.length > 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {summary.wallets.map((b) => (
              <div key={b.coin} className="bg-surface rounded-xl border border-border shadow-card p-4 hover:shadow-card-md transition-shadow">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-8 h-8 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center">
                    {b.coin.slice(0, 2)}
                  </div>
                  <span className="text-sm font-medium text-text-primary">{b.coin}</span>
                </div>
                {(() => {
                  const avail = parseFloat(b.available ?? '0') || 0
                  const locked = parseFloat(b.locked ?? '0') || 0
                  const pkr = avail * usdtRate
                  return (
                    <>
                      <p className="text-lg font-bold text-text-primary">{avail.toFixed(4)}</p>
                      {usdtRate > 0 && b.coin === 'USDT' && (
                        <div className="mt-0.5">
                          <p className="text-xs text-text-muted">
                            ≈ PKR {pkr.toLocaleString()}
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
                        Locked: {locked.toFixed(4)}
                      </p>
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
          {QUICK_ACTIONS.map(({ href, label, Icon }) => (
            <Link
              key={href}
              href={href}
              className="flex flex-col items-center gap-2 bg-surface rounded-xl border border-border shadow-card p-4 hover:border-primary/30 hover:shadow-card-md transition-all text-center group"
            >
              <div className="w-10 h-10 rounded-xl bg-surface-alt flex items-center justify-center group-hover:bg-primary/10 transition-colors">
                <Icon size={18} className="text-text-secondary group-hover:text-primary transition-colors" aria-hidden />
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
                ? (t.seller?.username || 'Seller')
                : (t.buyer?.username || 'Buyer')
              const ts = getTradeStatus(t.status)
              return (
                <Link key={t.id} href={`/trade/${t.id}`} className="flex items-center justify-between px-4 py-3 hover:bg-surface-alt/60 transition-colors">
                  <div className="flex items-center gap-3">
                    <Badge variant={ts.variant} icon={ts.icon} size="sm">{ts.label}</Badge>
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
                <div key={o.orderRef} className="flex items-center justify-between px-4 py-3">
                  <div className="flex items-center gap-3">
                    <Badge variant={gs.variant} icon={gs.icon} size="sm">{gs.label}</Badge>
                    <div>
                      <p className="text-sm font-medium text-text-primary">
                        {parseFloat(o.gasAmountNative).toFixed(4)} {symbol}
                      </p>
                      <p className="text-xs text-text-muted font-mono">{o.orderRef}</p>
                    </div>
                  </div>
                  <span className="text-xs text-text-muted">{timeAgo(o.createdAt)}</span>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* ── 6. Recent Instant Buy ── */}
      {(instantOrders ?? []).length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold text-text-primary">Recent Instant Buy</h2>
            <Link href="/instant-buy" className="text-xs text-primary hover:underline">View all</Link>
          </div>
          <div className="bg-surface rounded-xl border border-border shadow-card divide-y divide-border">
            {(instantOrders ?? []).slice(0, 3).map((o) => {
              const s = getTradeStatus(o.status)
              return (
                <div key={o.id} className="flex items-center justify-between px-4 py-3">
                  <div className="flex items-center gap-3">
                    <Badge variant={s.variant} icon={s.icon} size="sm">{s.label}</Badge>
                    <span className="text-sm text-text-primary">{parseFloat(o.amount).toFixed(4)} {o.coin}</span>
                  </div>
                  <span className="text-xs text-text-muted">{timeAgo(o.createdAt)}</span>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* ── 7. Trader Badge ── */}
      <section>
        <TraderLevelCard
          badge={(user?.tradeStats?.badge ?? summary?.tradeStats?.badge ?? 'new') as TraderBadge}
          badgeLabel={user?.tradeStats?.badgeLabel ?? summary?.tradeStats?.badgeLabel ?? undefined}
          trustScore={user?.tradeStats?.trustScore ?? summary?.tradeStats?.trustScore ?? 0}
          completedTrades={user?.tradeStats?.completedTrades ?? summary?.tradeStats?.completedTrades ?? 0}
          completionRate={user?.tradeStats?.completionRate ?? summary?.tradeStats?.completionRate ?? 0}
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
                  size={15}
                  className={`mt-0.5 flex-shrink-0 ${notifIconColor[n.type] ?? 'text-text-muted'}`}
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
