'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { ctmApi } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'

interface MerchantProfile {
  id: string
  tier: string
  isActive: boolean
  totalCtmTrades: number
  completedCtmTrades: number
  disputedCtmTrades: number
  ctmAvgRating: string
  ctmDisputeRate: string
  lastActiveAt?: string
  listings: Array<{
    id: string
    listingRef: string
    side: string
    status: string
    pricePerUnit: string
    availableAmount: string
    totalAmount: string
    token: { name: string; symbol: string }
  }>
  user: { username: string; email: string }
}

const TIER_COLORS: Record<string, string> = {
  new: 'bg-surface-alt text-text-secondary',
  basic: 'bg-blue-100 text-blue-700',
  verified: 'bg-green-100 text-green-700',
  elite: 'bg-primary/10 text-primary',
}

const TIER_NEXT: Record<string, { label: string; requirement: string }> = {
  new: { label: 'Basic', requirement: '10 completed trades to upgrade' },
  basic: { label: 'Verified', requirement: 'Apply to admin for Verified tier' },
  verified: { label: 'Elite', requirement: '200 completed trades + <2% dispute rate' },
  elite: { label: 'Elite (Max)', requirement: 'You are at the highest tier!' },
}

function StatCard({ label, value, sub, accent }: { label: string; value: string | number; sub?: string; accent?: string }) {
  return (
    <div className="bg-surface shadow-card border border-border rounded-xl p-4">
      <p className="text-xs text-text-muted">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${accent ?? 'text-text-primary'}`}>{value}</p>
      {sub && <p className="text-xs text-text-muted mt-0.5">{sub}</p>}
    </div>
  )
}

export default function CtmDashboardPage() {
  const { user } = useAuth()
  const [profile, setProfile] = useState<MerchantProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    ctmApi.getMyCtmProfile()
      .then((res) => setProfile(res as MerchantProfile))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load profile'))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-12">
        <div className="space-y-4 animate-pulse">
          <div className="bg-surface shadow-card border border-border rounded-xl h-32" />
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => <div key={i} className="bg-surface shadow-card border border-border rounded-xl h-20" />)}
          </div>
        </div>
      </div>
    )
  }

  if (error || !profile) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-12 text-center">
        <p className="text-text-muted mb-4">{error || 'No CTM merchant profile found.'}</p>
        <Link href="/ctm/merchant-setup" className="bg-primary text-white px-5 py-2.5 rounded-xl font-semibold text-sm">
          Register as Merchant
        </Link>
      </div>
    )
  }

  const completionRate = profile.totalCtmTrades > 0
    ? Math.round((profile.completedCtmTrades / profile.totalCtmTrades) * 100)
    : 0
  const disputeRate = Math.round(parseFloat(profile.ctmDisputeRate) * 100)
  const avgRating = parseFloat(profile.ctmAvgRating)
  const activeListings = profile.listings.filter((l) => l.status === 'active')
  const tierNext = TIER_NEXT[profile.tier] ?? TIER_NEXT.elite

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Merchant Dashboard</h1>
          <p className="text-text-muted text-sm">@{user?.username}</p>
        </div>
        <Link href="/ctm/listings/create" className="bg-primary text-white px-4 py-2.5 rounded-xl font-semibold text-sm hover:bg-primary/90 transition-colors">
          + New Listing
        </Link>
      </div>

      {/* Status banner */}
      <div className={`rounded-xl p-4 border ${profile.isActive ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${profile.isActive ? 'bg-green-500' : 'bg-red-500'}`} />
            <div>
              <p className={`font-semibold text-sm ${profile.isActive ? 'text-green-800' : 'text-red-800'}`}>
                {profile.isActive ? 'Active Merchant' : 'Account Suspended'}
              </p>
              <p className={`text-xs ${profile.isActive ? 'text-green-700' : 'text-red-700'}`}>
                {profile.isActive ? 'Your listings are visible to buyers.' : 'Contact support to restore your account.'}
              </p>
            </div>
          </div>
          <span className={`text-xs px-2.5 py-1 rounded-full font-semibold ${TIER_COLORS[profile.tier] ?? 'bg-surface-alt text-text-secondary'}`}>
            {profile.tier.charAt(0).toUpperCase() + profile.tier.slice(1)} Tier
          </span>
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard label="Total Trades" value={profile.totalCtmTrades} />
        <StatCard
          label="Completed"
          value={`${profile.completedCtmTrades} (${completionRate}%)`}
          accent="text-green-700"
        />
        <StatCard
          label="Dispute Rate"
          value={`${disputeRate}%`}
          sub={profile.disputedCtmTrades > 0 ? `${profile.disputedCtmTrades} disputed` : 'No disputes'}
          accent={disputeRate > 5 ? 'text-red-600' : 'text-text-primary'}
        />
        <StatCard
          label="Avg Rating"
          value={avgRating > 0 ? `${avgRating.toFixed(1)} ★` : 'No ratings'}
          sub={avgRating > 0 ? `${profile.totalCtmTrades} reviews` : undefined}
          accent={avgRating >= 4 ? 'text-yellow-600' : 'text-text-primary'}
        />
      </div>

      {/* Tier progress */}
      <div className="bg-surface shadow-card border border-border rounded-xl p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold text-text-primary">Tier Progress</h2>
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${TIER_COLORS[profile.tier] ?? 'bg-surface-alt text-text-secondary'}`}>
            {profile.tier}
          </span>
        </div>
        <p className="text-sm text-text-muted">{tierNext.requirement}</p>
        {profile.tier !== 'elite' && (
          <div className="mt-3 bg-surface rounded-full h-2 overflow-hidden">
            <div
              className="h-2 rounded-full bg-primary transition-all"
              style={{ width: `${Math.min(100, (profile.completedCtmTrades / (profile.tier === 'new' ? 10 : 200)) * 100)}%` }}
            />
          </div>
        )}
      </div>

      {/* Active listings */}
      <div className="bg-surface shadow-card border border-border rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-text-primary">Active Listings ({activeListings.length})</h2>
          <Link href="/ctm/my-listings" className="text-sm text-primary hover:underline">View all</Link>
        </div>
        {activeListings.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-text-muted text-sm mb-3">You have no active listings.</p>
            <Link href="/ctm/listings/create" className="text-sm text-primary hover:underline">Create your first listing →</Link>
          </div>
        ) : (
          <div className="space-y-2">
            {activeListings.map((l) => {
              const fillPct = parseFloat(l.totalAmount) > 0
                ? Math.round(((parseFloat(l.totalAmount) - parseFloat(l.availableAmount)) / parseFloat(l.totalAmount)) * 100)
                : 0
              return (
                <Link key={l.id} href={`/ctm/listings/${l.id}`} className="flex items-center justify-between p-3 bg-surface rounded-xl hover:bg-border/30 transition-colors">
                  <div className="flex items-center gap-3">
                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${l.side === 'sell' ? 'bg-green-500' : 'bg-blue-500'}`} />
                    <div>
                      <p className="text-sm font-medium text-text-primary">
                        {l.side === 'sell' ? 'Selling' : 'Buying'} {l.token.symbol}
                      </p>
                      <p className="text-xs text-text-muted">
                        PKR {Number(l.pricePerUnit).toLocaleString()} · {Number(l.availableAmount).toFixed(4)} {l.token.symbol} left
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-text-muted mb-1">{fillPct}% filled</p>
                    <div className="w-20 bg-surface rounded-full h-1.5 border border-border">
                      <div className="h-1.5 rounded-full bg-primary" style={{ width: `${fillPct}%` }} />
                    </div>
                  </div>
                </Link>
              )
            })}
          </div>
        )}
      </div>

      {/* Quick links */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {[
          { label: 'My Trades', href: '/ctm/my-trades', desc: 'View trade history' },
          { label: 'My Listings', href: '/ctm/my-listings', desc: 'Manage all listings' },
          { label: 'Incoming Bids', href: '/ctm/incoming-bids', desc: 'Accept or reject bids' },
          { label: 'My Bids', href: '/ctm/my-bids', desc: 'Bids you have placed' },
          { label: 'Browse Market', href: '/ctm/listings', desc: 'See other listings' },
        ].map((l) => (
          <Link key={l.href} href={l.href} className="bg-surface shadow-card border border-border rounded-xl p-4 hover:shadow-card transition-shadow">
            <p className="font-semibold text-text-primary text-sm">{l.label}</p>
            <p className="text-xs text-text-muted mt-0.5">{l.desc}</p>
          </Link>
        ))}
      </div>
    </div>
  )
}
