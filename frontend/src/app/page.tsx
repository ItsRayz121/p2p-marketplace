// Force dynamic rendering — prevents Next.js from attempting to pre-render
// this page during the Vercel build (which would require the backend to be
// reachable). Fresh marketplace data on every request is correct for a live
// trading platform.
export const dynamic = 'force-dynamic'

import Link from 'next/link'
import type { LucideIcon } from 'lucide-react'
import { ArrowLeftRight, Fuel, FileText, Coins, ShieldCheck, Users, Lock, Headphones, UserPlus, BadgeCheck, Handshake } from 'lucide-react'
import { RateCalculator } from './_components/home/RateCalculator'
import { AnimatedStatsBar } from './_components/home/AnimatedStatsBar'
import { TopAdsSection } from './_components/home/TopAdsSection'
import { FaqAccordion } from './_components/home/FaqAccordion'
import { MarketingHeader } from '@/components/layout/MarketingHeader'
import Footer from '@/components/layout/Footer'
import type { MarketplaceAd } from '@/lib/api'

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
  usdt?: MarketplaceAd[]
  mode?: 'top' | 'latest' | 'pinned'
}

interface FaqItem {
  question: string
  answer: string
}

interface CtmTopListing {
  id: string
  token: { id: string; name: string; symbol: string; logoUrl?: string }
  side: 'buy' | 'sell'
  pricePerUnit: string
  availableAmount: string
  minOrderPkr?: string
  maxOrderPkr?: string
  paymentMethods: string[]
  merchantProfile: { user: { username: string; avatarUrl?: string } }
}

interface GasChainSummary {
  id: string
  slug: string
  name: string
  symbol: string
  logoUrl?: string | null
  platformFeeUsdt?: string | null
  isAvailable?: boolean
}

interface HomeData {
  stats: MarketStats | null
  topAds: TopAds | null
  topCtm: CtmTopListing[] | null
  topGas: GasChainSummary[] | null
  faqs: FaqItem[]
}

// ─── Server-side data fetch ───────────────────────────────────────────────────

async function getHomeData(): Promise<HomeData> {
  // Use NEXT_PUBLIC_API_URL in production; fall back to local backend in dev.
  const api = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001').replace(/\/$/, '')

  const [statsRes, topAdsRes, configRes, topCtmRes, gasRes] = await Promise.allSettled([
    fetch(`${api}/api/v1/marketplace/stats`,   { cache: 'no-store' }),
    fetch(`${api}/api/v1/marketplace/top-ads`, { cache: 'no-store' }),
    fetch(`${api}/api/v1/marketplace/config`,   { cache: 'no-store' }),
    fetch(`${api}/api/v1/ctm/listings?limit=6&side=sell&status=active`, { cache: 'no-store' }),
    fetch(`${api}/api/v1/gas-fee/chains`, { cache: 'no-store' }),
  ])

  // All backend routes wrap responses in { success: true, data: ... } — unwrap here.
  async function json<T>(r: PromiseSettledResult<Response>): Promise<T | null> {
    if (r.status !== 'fulfilled' || !r.value.ok) return null
    try {
      const body = await r.value.json() as { success?: boolean; data?: T } | T
      if (body && typeof body === 'object' && 'data' in body && body.data !== undefined) {
        return (body as { data: T }).data
      }
      return body as T
    } catch { return null }
  }

  const statsData  = await json<MarketStats>(statsRes)
  const topAdsData = await json<TopAds>(topAdsRes)
  const config     = await json<Record<string, unknown>>(configRes)
  const ctmData    = await json<{ listings: CtmTopListing[]; total: number }>(topCtmRes)
  const gasData    = await json<{ chains: GasChainSummary[] }>(gasRes)

  return {
    stats:  statsData,
    topAds: topAdsData,
    topCtm: ctmData?.listings ?? null,
    topGas: gasData?.chains ?? null,
    faqs:   Array.isArray(config?.homeFaqs) ? (config!.homeFaqs as FaqItem[]) : [],
  }
}

// ─── Static UI sub-components ─────────────────────────────────────────────────

function QuickActionCard({
  href, Icon, title, description, iconCls = 'text-primary', bgCls = 'bg-primary/10', badge,
}: {
  href: string
  Icon: LucideIcon
  title: string
  description: string
  iconCls?: string
  bgCls?: string
  badge?: string
}) {
  return (
    <Link
      href={href}
      className="relative block p-6 bg-surface border border-border rounded-xl hover:shadow-card-md hover:border-primary/30 transition-all group"
    >
      {badge && (
        <span className="absolute top-3 right-3 text-[10px] font-bold bg-yellow-400 text-yellow-900 px-2 py-0.5 rounded-full">
          {badge}
        </span>
      )}
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center mb-3 ${bgCls}`}>
        <Icon size={20} className={iconCls} aria-hidden />
      </div>
      <h3 className="text-base font-semibold text-text-primary group-hover:text-primary transition-colors">{title}</h3>
      <p className="mt-1 text-sm text-text-muted">{description}</p>
    </Link>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function HomePage() {
  const { stats, topAds, topCtm, topGas, faqs } = await getHomeData()

  return (
    <div className="min-h-screen bg-surface">
      <MarketingHeader />

      {/* ── 1. HERO ── */}
      <section className="relative bg-gradient-to-br from-slate-900 via-blue-950 to-slate-900 border-b border-slate-800 overflow-hidden">
        <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(to_right,rgba(255,255,255,0.03)_1px,transparent_1px)] [background-size:48px_48px] pointer-events-none" />
        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 lg:py-24">
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            <div>
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
                Peer-to-peer trading with dispute protection. Pay with JazzCash, Easypaisa, or bank transfer.
                Your funds, your control.
              </p>
              <div className="flex flex-col sm:flex-row gap-3 mt-6">
                <Link
                  href="/register"
                  className="flex items-center justify-center gap-2 px-6 py-3 bg-primary text-white font-bold rounded-lg hover:bg-primary-hover transition-colors shadow-lg shadow-primary/30"
                >
                  <UserPlus size={18} aria-hidden />
                  Create Free Account
                </Link>
                <Link
                  href="/marketplace"
                  className="flex items-center justify-center gap-2 px-6 py-3 bg-white/10 text-white font-semibold rounded-lg border border-white/20 hover:bg-white/20 transition-colors backdrop-blur-sm"
                >
                  <ArrowLeftRight size={18} aria-hidden />
                  Browse Marketplace
                </Link>
              </div>
              <div className="flex flex-wrap gap-2.5 mt-4">
                <Link
                  href="/ctm"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-300 bg-white/5 border border-white/10 rounded-full hover:bg-white/10 hover:text-white transition-colors"
                >
                  <Coins size={13} aria-hidden />
                  Community Tokens
                </Link>
                <Link
                  href="/gas"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-300 bg-white/5 border border-white/10 rounded-full hover:bg-white/10 hover:text-white transition-colors"
                >
                  <Fuel size={13} aria-hidden />
                  Crypto Gas Fees
                </Link>
              </div>
            </div>

            {/* Market calculator — client island */}
            <RateCalculator />
          </div>
        </div>
      </section>

      {/* ── 2. STATS BAR — only show when there is real data ── */}
      {stats && (stats.totalUsers > 0 || stats.totalTrades > 0 || parseFloat(stats.totalVolume) > 0) && (
        <AnimatedStatsBar stats={stats} />
      )}

      {/* ── 3. TOP ADS — client island (tab toggle) ── */}
      <TopAdsSection topAds={topAds} topCtm={topCtm} topGas={topGas} />

      {/* ── 4. TRUST BADGES ── */}
      <section className="py-10 bg-surface border-t border-border">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {[
              { Icon: ShieldCheck,     title: 'Escrow Protected',   desc: 'Funds locked until both parties confirm',        color: 'text-success',    bg: 'bg-success/10'    },
              { Icon: Users,           title: 'KYC Verified',       desc: 'Every trader identity-verified via CNIC',        color: 'text-primary',    bg: 'bg-primary/10'    },
              { Icon: Lock,            title: 'Secure Withdrawals', desc: '2FA + email confirmation on every withdrawal',   color: 'text-warning',    bg: 'bg-warning/10'    },
              { Icon: Headphones,      title: '24/7 Support',       desc: 'Live support for trades and disputes',           color: 'text-violet-500', bg: 'bg-violet-500/10' },
            ].map(({ Icon, title, desc, color, bg }) => (
              <div key={title} className="flex flex-col items-center text-center gap-2 px-3 py-4 bg-surface rounded-xl border border-border shadow-card">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${bg}`}>
                  <Icon className={`w-5 h-5 ${color}`} aria-hidden />
                </div>
                <p className="text-sm font-semibold text-text-primary leading-tight">{title}</p>
                <p className="text-xs text-text-muted leading-snug">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── 5. QUICK ACTIONS ── */}
      <section className="py-12 bg-canvas border-t border-border">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 className="text-2xl font-bold text-text-primary mb-6">What would you like to do?</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <QuickActionCard href="/marketplace" Icon={ArrowLeftRight} title="USDT Marketplace"    description="Browse buy and sell USDT offers from verified traders"   iconCls="text-blue-500"   bgCls="bg-blue-500/10"   />
            <QuickActionCard href="/ctm"         Icon={Coins}          title="Community Tokens"    description="Trade community tokens like BKR, SIDRA and more"         iconCls="text-pink-500"   bgCls="bg-pink-500/10"   />
            <QuickActionCard href="/gas"          Icon={Fuel}           title="Crypto Gas Fees"     description="Top up gas fees on any chain instantly with PKR"         iconCls="text-amber-500"  bgCls="bg-amber-500/10"  />
            <QuickActionCard href="/fees"         Icon={FileText}       title="View Fees"           description="Transparent fee schedule for all transactions"          iconCls="text-indigo-500" bgCls="bg-indigo-500/10" />
          </div>
        </div>
      </section>

      {/* ── 6. HOW IT WORKS ── */}
      <section className="py-12 border-t border-border">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 className="text-2xl font-bold text-text-primary mb-2">How RupChain works</h2>
          <p className="text-sm text-text-muted mb-8">From signup to your first trade in three steps</p>
          <div className="grid sm:grid-cols-3 gap-5">
            {[
              {
                Icon: UserPlus,
                step: '1',
                title: 'Create your account',
                text: 'Sign up free with email, Google, or Telegram. No deposit required — your crypto stays in your own wallet.',
                color: 'text-primary', bg: 'bg-primary/10',
              },
              {
                Icon: BadgeCheck,
                step: '2',
                title: 'Verify your identity',
                text: 'Complete a quick CNIC-based KYC. Every trader on RupChain is identity-verified, so you always know who you are dealing with.',
                color: 'text-success', bg: 'bg-success/10',
              },
              {
                Icon: Handshake,
                step: '3',
                title: 'Trade with confidence',
                text: 'Pay with JazzCash, Easypaisa, or bank transfer. Every crypto transfer is verified on the blockchain, and our dispute team has your back.',
                color: 'text-warning', bg: 'bg-warning/10',
              },
            ].map(({ Icon, step, title, text, color, bg }) => (
              <div key={step} className="bg-surface rounded-xl border border-border shadow-card p-5 space-y-3">
                <div className="flex items-center gap-3">
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${bg}`}>
                    <Icon className={`w-5 h-5 ${color}`} aria-hidden />
                  </div>
                  <span className="text-xs font-bold text-text-muted uppercase tracking-wide">Step {step}</span>
                </div>
                <p className="text-base font-semibold text-text-primary">{title}</p>
                <p className="text-sm text-text-secondary leading-relaxed">{text}</p>
              </div>
            ))}
          </div>
          <div className="mt-8 text-center">
            <Link
              href="/register"
              className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-white font-bold rounded-lg hover:bg-primary-hover transition-colors shadow-lg shadow-primary/20"
            >
              <UserPlus size={18} aria-hidden />
              Start Trading Today
            </Link>
          </div>
        </div>
      </section>

      {/* ── 7. FAQ — client island (accordion state) ── */}
      <FaqAccordion items={faqs} />

      <Footer />
    </div>
  )
}
