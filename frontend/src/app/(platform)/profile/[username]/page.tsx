'use client'
import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { apiRequest } from '@/lib/api'
import { BadgeChip } from '@/components/ui/TraderLevelCard'
import type { TraderBadge } from '@/components/ui/TraderLevelCard'
import { Badge } from '@/components/ui/Badge'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Button } from '@/components/ui/Button'
import { getPaymentMethodColor } from '@/lib/pkPaymentMethods'

interface TraderProfile {
  id: string
  username: string
  fullName: string
  role: string
  kycStatus: string
  kycLevel: string
  verifiedEmail: boolean
  createdAt: string
  lastSeenAt: string | null
  tradeStats: {
    totalTrades: number
    completedTrades: number
    completionRate: number
    avgRating: number
    badge: string
    badgeLabel: string
    trustScore: number
  } | null
  merchant: {
    id: string
    businessName: string
    status: string
    rank: string
  } | null
  ratings: Array<{
    id: string
    rating: number
    comment: string | null
    tags: string[]
    createdAt: string
    reviewerUsername: string
    trade: { orderRef: string; coin: string }
  }>
  activeAds: Array<{
    id: string
    side: string
    coin: string
    network: string
    price: string
    minOrder: string
    maxOrder: string
    availableAmount: string
    paymentMethods: string[]
    tradeWindow: number
  }>
}

function StarRow({ rating }: { rating: number }) {
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((s) => (
        <span key={s} className={`text-sm ${s <= rating ? 'text-gold' : 'text-text-muted/30'}`}>★</span>
      ))}
    </div>
  )
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const days = Math.floor(diff / 86_400_000)
  if (days < 1) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

export default function TraderProfilePage() {
  const { username } = useParams<{ username: string }>()
  const [profile, setProfile] = useState<TraderProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchProfile = useCallback(async () => {
    try {
      const data = await apiRequest<TraderProfile>(`/users/${encodeURIComponent(username)}/profile`)
      setProfile(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load profile')
    } finally {
      setLoading(false)
    }
  }, [username])

  useEffect(() => { fetchProfile() }, [fetchProfile])

  if (loading) return <LoadingState message="Loading profile..." />
  if (error || !profile) return <ErrorState title={error ?? 'Profile not found'} onRetry={fetchProfile} />

  const stats = profile.tradeStats
  const badge = (stats?.badge ?? 'new') as TraderBadge
  const successRate = stats ? ((stats.completionRate ?? 0) * 100).toFixed(0) : '—'
  const avgRating = stats?.avgRating ? stats.avgRating.toFixed(1) : '—'
  const completedTrades = stats?.completedTrades ?? 0

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-5">
      {/* Header */}
      <div className="bg-surface shadow-card rounded-xl border border-border p-5">
        <div className="flex flex-wrap items-start gap-4">
          <div className="w-14 h-14 rounded-full bg-primary/10 text-primary text-2xl font-bold flex items-center justify-center flex-shrink-0">
            {profile.username.charAt(0).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold text-text-primary">{profile.username}</h1>
              <BadgeChip badge={badge} />
              {profile.merchant?.status === 'approved' && (
                <Badge variant="success" size="sm">Verified Merchant</Badge>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3 mt-1.5 text-xs text-text-muted">
              {profile.verifiedEmail && (
                <span className="flex items-center gap-1 text-success">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                  </svg>
                  Email Verified
                </span>
              )}
              {profile.kycLevel !== 'none' && (
                <span className="flex items-center gap-1 text-primary">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                  </svg>
                  KYC {profile.kycLevel === 'enhanced' ? 'Enhanced' : 'Basic'}
                </span>
              )}
              <span>Joined {timeAgo(profile.createdAt)}</span>
              {profile.lastSeenAt && <span>Last seen {timeAgo(profile.lastSeenAt)}</span>}
            </div>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Completed Trades', value: completedTrades },
          { label: 'Success Rate', value: `${successRate}%` },
          { label: 'Avg Rating', value: avgRating },
        ].map(({ label, value }) => (
          <div key={label} className="bg-surface shadow-card rounded-xl border border-border p-4 text-center">
            <p className="text-2xl font-bold text-text-primary">{value}</p>
            <p className="text-xs text-text-muted mt-0.5">{label}</p>
          </div>
        ))}
      </div>

      {/* Active Ads */}
      {profile.activeAds.length > 0 && (
        <div className="bg-surface shadow-card rounded-xl border border-border p-5">
          <h2 className="text-sm font-semibold text-text-primary mb-4">Active Listings</h2>
          <div className="space-y-3">
            {profile.activeAds.map((ad) => (
              <div key={ad.id} className="flex flex-wrap items-center gap-3 py-3 border-b border-border last:border-0">
                <Badge variant={ad.side === 'sell' ? 'success' : 'warning'} size="sm">
                  {ad.side === 'sell' ? 'Selling' : 'Buying'}
                </Badge>
                <span className="text-sm font-semibold text-text-primary">{ad.coin}</span>
                <span className="text-sm text-text-secondary">PKR {Number(ad.price).toLocaleString()}</span>
                <span className="text-xs text-text-muted">
                  {Number(ad.minOrder).toLocaleString()} – {Number(ad.maxOrder).toLocaleString()} PKR
                </span>
                <div className="flex flex-wrap gap-1">
                  {ad.paymentMethods.slice(0, 2).map((pm) => (
                    <span key={pm} className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${getPaymentMethodColor(pm)}`}>{pm}</span>
                  ))}
                </div>
                <Link href={`/trade/new?adId=${ad.id}`} className="ml-auto">
                  <Button size="sm" variant="secondary">{ad.side === 'sell' ? 'Buy' : 'Sell'}</Button>
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Ratings */}
      {profile.ratings.length > 0 && (
        <div className="bg-surface shadow-card rounded-xl border border-border p-5">
          <h2 className="text-sm font-semibold text-text-primary mb-4">
            Reviews <span className="text-text-muted font-normal">({profile.ratings.length})</span>
          </h2>
          <div className="space-y-4">
            {profile.ratings.map((r) => (
              <div key={r.id} className="border-b border-border last:border-0 pb-4 last:pb-0">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="flex items-center gap-2">
                    <StarRow rating={r.rating} />
                    <span className="text-xs text-text-muted">by {r.reviewerUsername}</span>
                  </div>
                  <span className="text-xs text-text-muted">{timeAgo(r.createdAt)}</span>
                </div>
                {r.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-1.5">
                    {r.tags.map((tag) => (
                      <span key={tag} className="px-2 py-0.5 text-xs rounded-full bg-surface text-text-secondary border border-border">{tag}</span>
                    ))}
                  </div>
                )}
                {r.comment && <p className="text-sm text-text-secondary">{r.comment}</p>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
