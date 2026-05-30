'use client'
import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { marketplaceApi } from '@/lib/api'
import type { MarketplaceAd } from '@/lib/api'
import { StalenessBadge } from '@/components/ui/StalenessBadge'
import { Badge } from '@/components/ui/Badge'
import { Spinner } from '@/components/ui/Spinner'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { PK_MOBILE_METHODS } from '@/lib/pkPaymentMethods'
import { ArrowLeftRight, Fuel, FileText, type LucideIcon } from 'lucide-react'
import { UserAvatar } from '@/components/ui/UserAvatar'

// ─── Types ────────────────────────────────────────────────────────────────────

interface MarketStats {
  totalUsers: number
  totalTrades: number
  totalVolume: string
  verifiedTraders: number
  todayTrades: number
}

interface TopAds {
  buys: MarketplaceAd[]
  sells: MarketplaceAd[]
}

interface FaqItem {
  question: string
  answer: string
}

// ─── Animated Number ──────────────────────────────────────────────────────────

function AnimatedNumber({ value, prefix = '', suffix = '' }: { value: number; prefix?: string; suffix?: string }) {
  const [display, setDisplay] = useState(0)

  useEffect(() => {
    if (value === 0) return
    const duration = 1000
    const steps = 40
    const increment = value / steps
    let current = 0
    const timer = setInterval(() => {
      current = Math.min(current + increment, value)
      setDisplay(Math.floor(current))
      if (current >= value) clearInterval(timer)
    }, duration / steps)
    return () => clearInterval(timer)
  }, [value])

  return (
    <span>
      {prefix}
      {display.toLocaleString()}
      {suffix}
    </span>
  )
}

// ─── FAQ Accordion ────────────────────────────────────────────────────────────

function FaqAccordion({ items }: { items: FaqItem[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null)

  return (
    <div className="space-y-2">
      {items.map((item, i) => (
        <div key={i} className="border border-border rounded-lg overflow-hidden">
          <button
            className="w-full flex items-center justify-between px-4 py-3 text-left text-sm font-medium text-text-primary hover:bg-surface transition-colors"
            onClick={() => setOpenIndex(openIndex === i ? null : i)}
          >
            <span>{item.question}</span>
            <svg
              className={`w-4 h-4 flex-shrink-0 text-text-muted transition-transform ${openIndex === i ? 'rotate-180' : ''}`}
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {openIndex === i && (
            <div className="px-4 pb-4 text-sm text-text-secondary bg-surface/50">
              {item.answer}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ─── Ad Card ─────────────────────────────────────────────────────────────────

function AdCard({ ad }: { ad: MarketplaceAd }) {
  const seller = ad.seller
  const stats = seller?.tradeStats
  const completionPct = stats?.completionRate ? parseFloat(stats.completionRate) * 100 : null
  const completionColor = completionPct === null ? 'text-text-muted' : completionPct >= 90 ? 'text-success' : completionPct >= 70 ? 'text-warning' : 'text-danger'
  const completedTrades = stats?.completedTrades ?? 0
  const rating = stats?.avgRating ? parseFloat(stats.avgRating) : 0

  return (
    <div className="bg-surface shadow-card border border-border rounded-xl p-4 hover:shadow-card-md transition-shadow">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          {/* Seller row */}
          <div className="flex items-center gap-2 mb-2">
            <UserAvatar name={seller?.username || 'Anonymous'} size="sm" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-text-primary truncate">
                {seller?.username || 'Anonymous'}
              </p>
              <div className="flex items-center gap-2 text-xs mt-0.5">
                {completionPct !== null && (
                  <span className={`font-bold ${completionColor}`}>{completionPct.toFixed(0)}%</span>
                )}
                {rating > 0 && (
                  <span className="text-text-muted flex items-center gap-0.5">
                    <span className="text-gold">★</span>{rating.toFixed(1)}
                  </span>
                )}
                <span className="text-text-muted">{completedTrades} done</span>
              </div>
            </div>
          </div>
          <p className="text-2xl font-bold text-text-primary">
            PKR {Number(ad.price).toLocaleString()}
            <span className="text-sm font-normal text-text-muted ml-1">/ {ad.coin}</span>
          </p>
          <p className="text-xs text-text-muted mt-1">
            Limit: PKR {Number(ad.minOrder).toLocaleString()} – {Number(ad.maxOrder).toLocaleString()}
          </p>
          <div className="flex flex-wrap gap-1 mt-2">
            {ad.paymentMethods.map((pm) => (
              <Badge key={pm} variant="default" size="sm">
                <EntityLogo
                  type={PK_MOBILE_METHODS.includes(pm) ? 'payment_method' : 'bank'}
                  slug={pm}
                  size="xs"
                  className="flex-shrink-0 mr-1"
                />
                {pm}
              </Badge>
            ))}
          </div>
        </div>
        <Link
          href={`/marketplace/listings/${ad.id}`}
          className="flex-shrink-0 px-4 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary/90 transition-colors"
        >
          Trade
        </Link>
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function HomePage() {
  const [rate, setRate] = useState<number | null>(null)
  const [rateUpdatedAt, setRateUpdatedAt] = useState<string | null>(null)
  const [pkrInput, setPkrInput] = useState('')
  const [usdtInput, setUsdtInput] = useState('')
  const [stats, setStats] = useState<MarketStats | null>(null)
  const [topAds, setTopAds] = useState<TopAds | null>(null)
  const [adsTab, setAdsTab] = useState<'buy' | 'sell'>('buy')
  const [faqs, setFaqs] = useState<FaqItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    try {
      const [rateData, statsData, topAdsData, configData] = await Promise.allSettled([
        marketplaceApi.getRate('USDT'),
        marketplaceApi.getStats(),
        marketplaceApi.getTopAds(),
        marketplaceApi.getConfig(),
      ])

      if (rateData.status === 'fulfilled') {
        setRate(rateData.value.rate)
        setRateUpdatedAt(rateData.value.updatedAt)
      }
      if (statsData.status === 'fulfilled') setStats(statsData.value)
      if (topAdsData.status === 'fulfilled') setTopAds(topAdsData.value)
      if (configData.status === 'fulfilled') {
        const cfg = configData.value as Record<string, unknown>
        if (Array.isArray(cfg.home_faqs)) setFaqs(cfg.home_faqs as FaqItem[])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  const handlePkrChange = (val: string) => {
    setPkrInput(val)
    if (rate && val) {
      setUsdtInput((parseFloat(val) / rate).toFixed(6))
    } else {
      setUsdtInput('')
    }
  }

  const handleUsdtChange = (val: string) => {
    setUsdtInput(val)
    if (rate && val) {
      setPkrInput((parseFloat(val) * rate).toFixed(2))
    } else {
      setPkrInput('')
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center">
        <Spinner size="lg" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-surface">
      {/* ── 1. HERO ── */}
      <section className="relative bg-gradient-to-br from-slate-900 via-blue-950 to-slate-900 border-b border-slate-800 overflow-hidden">
        {/* Subtle grid overlay */}
        <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(to_right,rgba(255,255,255,0.03)_1px,transparent_1px)] [background-size:48px_48px] pointer-events-none" />
        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 lg:py-24">
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            <div className="animate-fade-in">
              <div className="inline-flex items-center gap-2 bg-primary/20 border border-primary/30 text-primary text-xs font-semibold px-3 py-1.5 rounded-full mb-5">
                <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                Live P2P Market · Pakistan
              </div>
              <h1 className="text-4xl sm:text-5xl font-bold leading-tight">
                <span className="text-white">Buy &amp; Sell Crypto</span>
                <br />
                <span className="bg-gradient-to-r from-blue-400 to-cyan-400 bg-clip-text text-transparent">
                  in Pakistan
                </span>
              </h1>
              <p className="mt-4 text-lg text-slate-300 max-w-md">
                Peer-to-peer trading with secure escrow. Pay with JazzCash, Easypaisa, or bank transfer.
                Your funds, your control.
              </p>
              <div className="flex flex-wrap gap-3 mt-8">
                <Link
                  href="/marketplace"
                  className="px-6 py-3 bg-primary text-white font-semibold rounded-lg hover:bg-primary-hover transition-colors shadow-lg shadow-primary/30"
                >
                  Start Trading
                </Link>
                <Link
                  href="/gas"
                  className="px-6 py-3 bg-white/10 text-white font-semibold rounded-lg border border-white/20 hover:bg-white/20 transition-colors backdrop-blur-sm"
                >
                  Crypto Gas Fees
                </Link>
              </div>
            </div>

            {/* Rate calculator */}
            <div className="bg-white/5 backdrop-blur-sm rounded-xl border border-white/10 p-6 animate-slide-up shadow-card-lg">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-base font-semibold text-white">USDT / PKR Calculator</h2>
                {rateUpdatedAt && <StalenessBadge updatedAt={rateUpdatedAt} />}
              </div>

              {error ? (
                <p className="text-sm text-red-400">Could not load rate. Please refresh.</p>
              ) : (
                <>
                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-400 mb-1">PKR Amount</label>
                      <div className="relative">
                        <input
                          type="number"
                          value={pkrInput}
                          onChange={(e) => handlePkrChange(e.target.value)}
                          placeholder="Enter PKR"
                          className="w-full px-4 py-3 border border-white/10 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 bg-white/10 text-white placeholder:text-slate-500"
                        />
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-medium text-slate-400">PKR</span>
                      </div>
                    </div>
                    <div className="flex items-center justify-center">
                      <svg className="w-5 h-5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
                      </svg>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-400 mb-1">USDT Amount</label>
                      <div className="relative">
                        <input
                          type="number"
                          value={usdtInput}
                          onChange={(e) => handleUsdtChange(e.target.value)}
                          placeholder="Enter USDT"
                          className="w-full px-4 py-3 border border-white/10 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 bg-white/10 text-white placeholder:text-slate-500"
                        />
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-medium text-slate-400">USDT</span>
                      </div>
                    </div>
                  </div>
                  {rate && (
                    <div className="mt-3 flex items-center justify-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                      <p className="text-xs text-slate-400 text-center">
                        1 USDT = <span className="text-white font-semibold">PKR {rate.toLocaleString()}</span>
                      </p>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* ── 2. STATS BAR ── */}
      {stats && (
        <section className="bg-slate-800 border-b border-slate-700 py-5">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-center">
              <div>
                <p className="text-xl font-bold text-white">
                  <AnimatedNumber value={stats.totalUsers} />
                </p>
                <p className="text-xs text-slate-400 mt-0.5 uppercase tracking-wide font-medium">Users</p>
              </div>
              <div>
                <p className="text-xl font-bold text-white">
                  <AnimatedNumber value={stats.totalTrades} />
                </p>
                <p className="text-xs text-slate-400 mt-0.5 uppercase tracking-wide font-medium">Trades Completed</p>
              </div>
              <div>
                <p className="text-xl font-bold text-white">
                  <AnimatedNumber value={parseFloat(stats.totalVolume) || 0} prefix="$" />
                </p>
                <p className="text-xs text-slate-400 mt-0.5 uppercase tracking-wide font-medium">Volume (USD)</p>
              </div>
              <div>
                <p className="text-xl font-bold text-white">
                  <AnimatedNumber value={stats.verifiedTraders} />
                </p>
                <p className="text-xs text-slate-400 mt-0.5 uppercase tracking-wide font-medium">Verified Traders</p>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* ── 3. TOP ADS ── */}
      <section className="py-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 className="text-2xl font-bold text-text-primary mb-6">Top Offers</h2>

          <div className="flex gap-2 mb-6">
            <button
              onClick={() => setAdsTab('buy')}
              className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                adsTab === 'buy'
                  ? 'bg-primary text-white'
                  : 'bg-surface border border-border text-text-secondary hover:bg-surface-alt'
              }`}
            >
              Buy USDT
            </button>
            <button
              onClick={() => setAdsTab('sell')}
              className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                adsTab === 'sell'
                  ? 'bg-primary text-white'
                  : 'bg-surface border border-border text-text-secondary hover:bg-surface-alt'
              }`}
            >
              Sell USDT
            </button>
          </div>

          {topAds ? (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {(adsTab === 'buy' ? topAds.buys : topAds.sells).map((ad) => (
                <AdCard key={ad.id} ad={ad} />
              ))}
              {(adsTab === 'buy' ? topAds.buys : topAds.sells).length === 0 && (
                <p className="col-span-full text-center text-sm text-text-muted py-8">No offers available right now.</p>
              )}
            </div>
          ) : (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="bg-surface shadow-card border border-border rounded-xl p-4 h-36 animate-pulse-subtle" />
              ))}
            </div>
          )}

          <div className="mt-6 text-center">
            <Link
              href="/marketplace"
              className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline"
            >
              View all offers
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </Link>
          </div>
        </div>
      </section>

      {/* ── 4. QUICK ACTIONS ── */}
      <section className="py-12 bg-surface border-t border-border">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 className="text-2xl font-bold text-text-primary mb-6">Quick Actions</h2>
          <div className="grid sm:grid-cols-3 gap-4">
            <QuickActionCard
              href="/marketplace"
              Icon={ArrowLeftRight}
              title="P2P Marketplace"
              description="Browse buy and sell offers from verified traders"
              iconCls="text-blue-500"
              bgCls="bg-blue-500/10"
            />
            <QuickActionCard
              href="/gas"
              Icon={Fuel}
              title="Crypto Gas Fees"
              description="Top up gas fees on any chain instantly"
              iconCls="text-amber-500"
              bgCls="bg-amber-500/10"
            />
            <QuickActionCard
              href="/fees"
              Icon={FileText}
              title="View Fees"
              description="Transparent fee schedule for all transactions"
              iconCls="text-indigo-500"
              bgCls="bg-indigo-500/10"
            />
          </div>
        </div>
      </section>

      {/* ── 5. FAQ ── */}
      {faqs.length > 0 && (
        <section className="py-12">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
            <h2 className="text-2xl font-bold text-text-primary mb-6">Frequently Asked Questions</h2>
            <FaqAccordion items={faqs} />
          </div>
        </section>
      )}
    </div>
  )
}

function QuickActionCard({
  href, Icon, title, description, iconCls = 'text-primary', bgCls = 'bg-primary/10',
}: {
  href: string
  Icon: LucideIcon
  title: string
  description: string
  iconCls?: string
  bgCls?: string
}) {
  return (
    <Link
      href={href}
      className="block p-6 bg-surface border border-border rounded-xl hover:shadow-card-md hover:border-primary/30 transition-all group"
    >
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center mb-3 transition-colors ${bgCls}`}>
        <Icon size={20} className={iconCls} />
      </div>
      <h3 className="text-base font-semibold text-text-primary group-hover:text-primary transition-colors">{title}</h3>
      <p className="mt-1 text-sm text-text-muted">{description}</p>
    </Link>
  )
}
