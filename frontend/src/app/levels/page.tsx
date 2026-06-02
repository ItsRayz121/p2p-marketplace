import type { Metadata } from 'next'
import Link from 'next/link'
import {
  Medal, CheckCircle, Star, Trophy, Gem,
  ShieldCheck, ShieldPlus, TrendingUp, Award, type LucideIcon,
} from 'lucide-react'

export const metadata: Metadata = {
  title: 'Trader Levels & Badges — RupChain',
  description:
    'Understand how RupChain trader badges and KYC verification levels work — the exact requirements to level up, how your Trust Score is calculated, and the benefits of each tier.',
}

// ─── KYC verification levels ────────────────────────────────────────────────────

interface KycTier {
  level: string
  name: string
  Icon: LucideIcon
  accent: string
  bg: string
  requirements: string[]
  benefits: string[]
  dailyLimit: string
}

const KYC_TIERS: KycTier[] = [
  {
    level: 'Level 0',
    name: 'Unverified',
    Icon: ShieldCheck,
    accent: 'text-text-muted',
    bg: 'bg-surface-alt',
    requirements: ['Just create an account'],
    benefits: ['Browse the marketplace, tokens & gas service', 'Cannot trade, deposit, or withdraw yet'],
    dailyLimit: 'PKR 0',
  },
  {
    level: 'Level 1',
    name: 'Basic KYC',
    Icon: ShieldCheck,
    accent: 'text-blue-500',
    bg: 'bg-blue-500/10',
    requirements: ['CNIC front & back photos', 'Selfie holding your CNIC'],
    benefits: [
      'Unlocks trading, wallet, ads, Community Tokens & Gas',
      'Buy, sell and withdraw crypto',
      'Earn a trader badge & build reputation',
    ],
    dailyLimit: 'PKR 50,000 / day',
  },
  {
    level: 'Level 2',
    name: 'Enhanced KYC',
    Icon: ShieldPlus,
    accent: 'text-amber-500',
    bg: 'bg-amber-500/10',
    requirements: ['Everything in Basic', '2 or more social media profile links'],
    benefits: [
      'Daily limit raised to PKR 200,000',
      'Higher Trust Score & faster badge progression',
      'Priority customer support',
      'Featured trader eligibility',
    ],
    dailyLimit: 'PKR 200,000 / day',
  },
]

// ─── Trader badge tiers ─────────────────────────────────────────────────────────

interface BadgeTier {
  name: string
  Icon: LucideIcon
  color: string
  bg: string
  border: string
  minTrades: number
  minRate: number
  blurb: string
}

const BADGE_TIERS: BadgeTier[] = [
  { name: 'Bronze',  Icon: Medal,       color: 'text-amber-700',  bg: 'bg-amber-50 dark:bg-amber-950/30', border: 'border-amber-300',  minTrades: 0,   minRate: 0,    blurb: 'Every verified trader starts here.' },
  { name: 'Silver',  Icon: CheckCircle, color: 'text-slate-500',  bg: 'bg-slate-100 dark:bg-slate-800/40', border: 'border-slate-300', minTrades: 5,   minRate: 0.80, blurb: 'You are an active, reliable trader.' },
  { name: 'Gold',    Icon: Star,        color: 'text-yellow-600', bg: 'bg-yellow-50 dark:bg-yellow-900/20', border: 'border-yellow-300', minTrades: 50,  minRate: 0.90, blurb: 'A trusted, high-volume trader.' },
  { name: 'Diamond', Icon: Trophy,      color: 'text-cyan-600',   bg: 'bg-cyan-50 dark:bg-cyan-900/20', border: 'border-cyan-300',   minTrades: 200, minRate: 0.95, blurb: 'Among the top traders on RupChain.' },
  { name: 'Elite',   Icon: Gem,         color: 'text-purple-700', bg: 'bg-purple-50 dark:bg-purple-900/20', border: 'border-purple-300', minTrades: 500, minRate: 0.98, blurb: 'The highest tier — elite reputation.' },
]

// ─── Trust score factors ────────────────────────────────────────────────────────

const TRUST_FACTORS = [
  { label: 'Completion rate', weight: '50%', desc: 'The share of your trades that finish successfully. The single biggest factor.' },
  { label: 'Average rating',  weight: '30%', desc: 'Your average star rating from the people you have traded with.' },
  { label: 'Trade volume',    weight: '15%', desc: 'How many trades you have completed (counted on a sliding scale, so early trades matter most).' },
  { label: 'Account age',     weight: '5%',  desc: 'Builds gradually over your first 90 days on the platform.' },
]

function fmtRate(rate: number) {
  return rate === 0 ? 'Any' : `${Math.round(rate * 100)}%+`
}

export default function LevelsPage() {
  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-10 pb-16 space-y-12">
      {/* Header */}
      <header className="text-center space-y-3">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary/10 text-primary mx-auto">
          <Award size={28} aria-hidden />
        </div>
        <h1 className="text-3xl font-black text-text-primary">Trader Levels & Badges</h1>
        <p className="text-sm text-text-secondary max-w-2xl mx-auto">
          RupChain has two ways to grow your standing: your <strong>KYC verification level</strong>, which
          unlocks features and higher limits, and your <strong>trader badge</strong>, which reflects your
          reputation as you complete more trades. Here is exactly how both work and how to level up.
        </p>
      </header>

      {/* ── KYC Verification Levels ── */}
      <section className="space-y-5">
        <div>
          <h2 className="text-xl font-bold text-text-primary">1. KYC Verification Levels</h2>
          <p className="text-sm text-text-muted mt-1">
            Verification unlocks what you can do on the platform and how much you can transact per day.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          {KYC_TIERS.map((tier) => {
            const { Icon } = tier
            return (
              <div key={tier.level} className="bg-surface shadow-card rounded-xl border border-border p-5 flex flex-col">
                <div className="flex items-center justify-between mb-3">
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${tier.bg}`}>
                    <Icon size={20} className={tier.accent} aria-hidden />
                  </div>
                  <span className="text-xs font-semibold text-text-muted">{tier.level}</span>
                </div>
                <h3 className="text-base font-bold text-text-primary">{tier.name}</h3>
                <p className={`text-sm font-semibold mt-0.5 ${tier.accent}`}>{tier.dailyLimit}</p>

                <p className="text-xs font-semibold text-text-muted uppercase tracking-wide mt-4 mb-1.5">Requirements</p>
                <ul className="space-y-1.5 mb-3">
                  {tier.requirements.map((r) => (
                    <li key={r} className="flex gap-2 text-sm text-text-secondary">
                      <span className="text-primary flex-shrink-0">•</span>{r}
                    </li>
                  ))}
                </ul>

                <p className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-1.5">You get</p>
                <ul className="space-y-1.5 mt-auto">
                  {tier.benefits.map((b) => (
                    <li key={b} className="flex gap-2 text-sm text-text-secondary">
                      <span className="text-success flex-shrink-0">✓</span>{b}
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </div>

        <div className="flex justify-center">
          <Link
            href="/kyc"
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-primary text-white text-sm font-semibold rounded-lg hover:bg-primary-hover transition-colors"
          >
            Verify your identity →
          </Link>
        </div>
      </section>

      {/* ── Trader Badge Tiers ── */}
      <section className="space-y-5">
        <div>
          <h2 className="text-xl font-bold text-text-primary">2. Trader Badge Tiers</h2>
          <p className="text-sm text-text-muted mt-1">
            Your badge is earned automatically from your completed trades and completion rate. It appears
            on your ads, your profile, and the leaderboard — so buyers and sellers can see you are reliable.
            Trades count across <strong>all three marketplaces</strong>: USDT P2P, Community Tokens, and Gas.
          </p>
        </div>

        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full">
            <thead className="bg-surface-alt border-b border-border">
              <tr>
                <th className="text-left text-xs font-semibold text-text-muted px-4 py-3">Badge</th>
                <th className="text-left text-xs font-semibold text-text-muted px-4 py-3 whitespace-nowrap">Completed Trades</th>
                <th className="text-left text-xs font-semibold text-text-muted px-4 py-3 whitespace-nowrap">Completion Rate</th>
                <th className="text-left text-xs font-semibold text-text-muted px-4 py-3">What it means</th>
              </tr>
            </thead>
            <tbody className="bg-surface divide-y divide-border">
              {BADGE_TIERS.map((tier) => {
                const { Icon } = tier
                return (
                  <tr key={tier.name}>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold ${tier.bg} ${tier.color}`}>
                        <Icon size={13} aria-hidden />{tier.name}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm font-semibold text-text-primary whitespace-nowrap">
                      {tier.minTrades === 0 ? '0+' : `${tier.minTrades}+`}
                    </td>
                    <td className="px-4 py-3 text-sm font-semibold text-text-primary whitespace-nowrap">{fmtRate(tier.minRate)}</td>
                    <td className="px-4 py-3 text-sm text-text-secondary">{tier.blurb}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-text-muted">
          You must meet <strong>both</strong> the trade count and the completion rate to reach a tier. For example,
          Silver needs at least 5 completed trades <em>and</em> an 80% completion rate. If your completion rate drops,
          your badge can move back down — keeping trades successful matters as much as doing more of them.
        </p>
      </section>

      {/* ── Trust Score ── */}
      <section className="space-y-5">
        <div>
          <h2 className="text-xl font-bold text-text-primary">3. How Your Trust Score Is Calculated</h2>
          <p className="text-sm text-text-muted mt-1">
            Your Trust Score is a single number from 0 to 100 shown on your dashboard. It blends four factors:
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {TRUST_FACTORS.map((f) => (
            <div key={f.label} className="bg-surface shadow-card rounded-xl border border-border p-4">
              <div className="flex items-center justify-between mb-1">
                <p className="text-sm font-bold text-text-primary">{f.label}</p>
                <span className="text-sm font-black text-primary">{f.weight}</span>
              </div>
              <p className="text-xs text-text-secondary leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Tips ── */}
      <section className="space-y-4">
        <h2 className="text-xl font-bold text-text-primary flex items-center gap-2">
          <TrendingUp size={20} className="text-primary" aria-hidden /> How to level up faster
        </h2>
        <div className="bg-primary/5 border border-primary/20 rounded-xl p-5">
          <ul className="space-y-2.5">
            {[
              'Complete every trade you start — your completion rate is the biggest driver of both your badge and Trust Score.',
              'Respond quickly and release crypto promptly to earn high ratings from your counterparties.',
              'Upgrade to Level 2 (Enhanced KYC) for higher limits and faster reputation growth.',
              'Trade across all three marketplaces — USDT, Community Tokens, and Gas all count toward your totals.',
              'Avoid cancelling trades; cancellations lower your completion rate and can pull your badge back down.',
            ].map((tip) => (
              <li key={tip} className="flex gap-2.5 text-sm text-text-secondary">
                <span className="w-5 h-5 rounded-full bg-primary/10 text-primary flex items-center justify-center flex-shrink-0 mt-0.5">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                </span>
                {tip}
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-wrap justify-center gap-3 pt-2">
          <Link href="/dashboard" className="inline-flex items-center gap-2 px-5 py-2.5 bg-primary text-white text-sm font-semibold rounded-lg hover:bg-primary-hover transition-colors">
            View my progress
          </Link>
          <Link href="/leaderboard" className="inline-flex items-center gap-2 px-5 py-2.5 bg-surface border border-border text-text-primary text-sm font-semibold rounded-lg hover:border-primary transition-colors">
            See the leaderboard
          </Link>
        </div>
      </section>
    </div>
  )
}
