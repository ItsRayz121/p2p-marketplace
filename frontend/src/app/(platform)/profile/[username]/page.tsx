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
import { UserAvatar } from '@/components/ui/UserAvatar'
import { Clock, Zap, Heart } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { toast } from '@/lib/toast'

interface TraderProfile {
  id: string
  username: string
  isFavorited: boolean
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
    avgRating: number | string
    badge: string
    badgeLabel: string
    trustScore: number
    avgResponseMinutes: number | null
    avgReleaseMinutes: number | null
    totalVolumePKR: string | null
    totalReviews: number | null
    disputesWon: number
    disputesLost: number
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

function memberSince(dateStr: string): string {
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}

function onlineStatus(lastSeenAt: string | null): { dot: string; text: string } {
  if (!lastSeenAt) return { dot: 'bg-border', text: 'Offline' }
  const mins = Math.floor((Date.now() - new Date(lastSeenAt).getTime()) / 60_000)
  if (mins < 10) return { dot: 'bg-success animate-pulse', text: 'Online now' }
  if (mins < 60) return { dot: 'bg-success', text: `Active ${mins}m ago` }
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return { dot: 'bg-yellow-400', text: `Active ${hrs}h ago` }
  const days = Math.floor(hrs / 24)
  if (days <= 3) return { dot: 'bg-yellow-400', text: `Active ${days}d ago` }
  return { dot: 'bg-border', text: `Last seen ${days}d ago` }
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
  const [favorited, setFavorited] = useState(false)
  const [favLoading, setFavLoading] = useState(false)
  const { user: me } = useAuth()

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

  useEffect(() => {
    if (profile) setFavorited(profile.isFavorited)
  }, [profile])

  async function toggleFavorite() {
    if (!me) return
    setFavLoading(true)
    try {
      const method = favorited ? 'DELETE' : 'POST'
      await apiRequest(`/users/${encodeURIComponent(username)}/favorite`, { method })
      setFavorited((v) => !v)
      toast.success(favorited ? 'Removed from favorites' : 'Added to favorites')
    } catch {
      toast.error('Could not update favorites')
    } finally {
      setFavLoading(false)
    }
  }

  if (loading) return <LoadingState message="Loading profile..." />
  if (error || !profile) return <ErrorState title={error ?? 'Profile not found'} onRetry={fetchProfile} />

  const stats = profile.tradeStats
  const badge = (stats?.badge ?? 'new') as TraderBadge
  const successRate = stats ? ((stats.completionRate ?? 0) * 100).toFixed(0) : '—'
  const avgRating = stats?.avgRating ? Number(stats.avgRating).toFixed(1) : '—'
  const completedTrades = stats?.completedTrades ?? 0
  const totalReviews = stats?.totalReviews ?? 0
  const responseMinutes = stats?.avgResponseMinutes ?? null
  const releaseMinutes = stats?.avgReleaseMinutes ?? null
  const disputesWon = stats?.disputesWon ?? 0
  const disputesLost = stats?.disputesLost ?? 0
  const hasDisputeData = disputesWon > 0 || disputesLost > 0
  const volumePKR = stats?.totalVolumePKR ? parseFloat(stats.totalVolumePKR) : null

  function fmtVolume(n: number): string {
    if (n >= 1_00_00_000) return `₨${(n / 1_00_00_000).toFixed(1)}Cr`
    if (n >= 1_00_000)   return `₨${(n / 1_00_000).toFixed(1)}L`
    return `₨${Math.round(n / 1_000)}K`
  }

  function fmtResponseTime(mins: number): string {
    if (mins < 60) return `${mins}m`
    return `${Math.floor(mins / 60)}h ${mins % 60}m`
  }

  const positiveReviews = profile.ratings.filter((r) => r.rating >= 4).length
  const positivePercent = profile.ratings.length > 0
    ? Math.round((positiveReviews / profile.ratings.length) * 100)
    : null

  // Top review tags — counted across all displayed ratings
  const tagCounts: Record<string, number> = {}
  for (const r of profile.ratings) {
    for (const tag of r.tags) {
      tagCounts[tag] = (tagCounts[tag] ?? 0) + 1
    }
  }
  const topTags = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([tag]) => tag)

  const onlineInfo = onlineStatus(profile.lastSeenAt)

  // SEO: update page title
  useEffect(() => {
    document.title = `${profile.fullName || profile.username} — Trader Profile | RupChain`
  }, [profile.fullName, profile.username])

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-5">
      {/* Header */}
      <div className="bg-surface shadow-card rounded-xl border border-border p-5">
        <div className="flex flex-wrap items-start gap-4">
          <div className="relative flex-shrink-0">
            <UserAvatar name={profile.fullName || profile.username} size="xl" />
            <span className={`absolute bottom-0.5 right-0.5 w-3 h-3 rounded-full border-2 border-surface ${onlineInfo.dot}`} />
          </div>
          <div className="flex-1 min-w-0">
            {/* Name row */}
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold text-text-primary">{profile.fullName || profile.username}</h1>
              <BadgeChip badge={badge} />
              {profile.merchant?.status === 'approved' && (
                <Badge variant="success" size="sm">Verified Merchant</Badge>
              )}
              {me && me.username !== profile.username && (
                <button
                  onClick={toggleFavorite}
                  disabled={favLoading}
                  className={`ml-1 p-1.5 rounded-full transition-colors ${favorited ? 'text-red-500 bg-red-50 dark:bg-red-950/30' : 'text-text-muted hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30'}`}
                  title={favorited ? 'Remove from favorites' : 'Add to favorites'}
                >
                  <Heart size={16} className={favorited ? 'fill-current' : ''} />
                </button>
              )}
            </div>

            {/* Username + Online status */}
            <p className="text-xs text-text-muted mt-0.5">@{profile.username} · {onlineInfo.text}</p>

            {/* Verification row */}
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
              <span>Member since {memberSince(profile.createdAt)}</span>
              {profile.merchant?.status === 'approved' && profile.merchant.id && (
                <span className="text-primary">Merchant since {memberSince(profile.createdAt)}</span>
              )}
            </div>

            {/* Inline trust metrics */}
            {stats && (
              <div className="flex flex-wrap items-center gap-3 mt-2 text-xs">
                {responseMinutes != null && (
                  <span className="flex items-center gap-1 text-text-muted">
                    <Clock size={11} className="text-primary" />
                    Response: {fmtResponseTime(responseMinutes)}
                  </span>
                )}
                {releaseMinutes != null && (
                  <span className="flex items-center gap-1 text-text-muted">
                    <Zap size={11} className="text-success" />
                    Release: {fmtResponseTime(releaseMinutes)}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-7 gap-3">
        {([
          { label: 'Trades', value: completedTrades },
          { label: 'Success Rate', value: `${successRate}%` },
          { label: 'Rating', value: totalReviews > 0 ? `${avgRating} ★` : avgRating },
          { label: 'Reviews', value: totalReviews > 0 ? totalReviews : '—' },
          { label: 'Avg Response', value: responseMinutes != null ? fmtResponseTime(responseMinutes) : '—' },
          { label: 'Avg Release', value: releaseMinutes != null ? fmtResponseTime(releaseMinutes) : '—' },
          { label: 'Volume', value: volumePKR != null && volumePKR >= 10_000 ? fmtVolume(volumePKR) : '—' },
        ] as Array<{ label: string; value: string | number }>).map(({ label, value }) => (
          <div key={label} className="bg-surface shadow-card rounded-xl border border-border p-4 text-center">
            <p className="text-xl font-bold text-text-primary">{value}</p>
            <p className="text-xs text-text-muted mt-0.5">{label}</p>
          </div>
        ))}
      </div>

      {/* Dispute record */}
      {hasDisputeData && (
        <div className="bg-surface shadow-card rounded-xl border border-border px-5 py-3 flex items-center gap-6 text-xs">
          <span className="text-text-muted font-medium">Disputes:</span>
          <span className="flex items-center gap-1 text-success font-semibold">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
            </svg>
            Won {disputesWon}
          </span>
          <span className="flex items-center gap-1 text-danger font-semibold">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
            </svg>
            Lost {disputesLost}
          </span>
        </div>
      )}

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
                  {(ad.paymentMethods ?? []).slice(0, 2).map((pm) => (
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
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-text-primary">
              Reviews <span className="text-text-muted font-normal">({totalReviews > 0 ? totalReviews : profile.ratings.length})</span>
            </h2>
            {positivePercent !== null && (
              <span className="text-xs font-medium text-success">{positivePercent}% Positive</span>
            )}
          </div>
          {topTags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-4 pb-4 border-b border-border">
              {topTags.map((tag) => (
                <span key={tag} className="px-2.5 py-1 text-xs rounded-full bg-primary/10 text-primary font-medium">
                  {tag} ×{tagCounts[tag]}
                </span>
              ))}
            </div>
          )}
          <div className="space-y-4">
            {profile.ratings.map((r) => (
              <div key={r.id} className="border-b border-border last:border-0 pb-4 last:pb-0">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="flex items-center gap-2">
                    <UserAvatar name={r.reviewerUsername} size="xs" />
                    <StarRow rating={r.rating} />
                    <span className="text-xs text-text-muted font-medium">{r.reviewerUsername}</span>
                  </div>
                  <span className="text-xs text-text-muted">{timeAgo(r.createdAt)}</span>
                </div>
                {(r.tags ?? []).length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-1.5">
                    {(r.tags ?? []).map((tag) => (
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
