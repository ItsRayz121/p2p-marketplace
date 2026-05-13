'use client'
import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { usersApi } from '@/lib/api'
import type { AuthUser } from '@/store/auth.store'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'

// ─── Types ────────────────────────────────────────────────────────────────────

interface PublicProfile extends Partial<AuthUser> {
  completedTrades?: number
  completionRate?: number
  avgRating?: number
  trustScore?: number
  badgeName?: string
  badgeLabel?: string
  reviews?: Review[]
  activeAdId?: string
}

interface Review {
  id: string
  reviewerUsername: string
  rating: number
  comment?: string
  createdAt: string
}

function StarRating({ rating }: { rating: number }) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((s) => (
        <svg
          key={s}
          className={`w-4 h-4 ${s <= Math.round(rating) ? 'text-gold' : 'text-border'}`}
          fill="currentColor"
          viewBox="0 0 20 20"
        >
          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
        </svg>
      ))}
    </div>
  )
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const days = Math.floor(diff / 86_400_000)
  if (days === 0) return 'today'
  if (days < 7) return `${days}d ago`
  if (days < 30) return `${Math.floor(days / 7)}w ago`
  return `${Math.floor(days / 30)}mo ago`
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function PublicProfilePage() {
  const { username } = useParams<{ username: string }>()
  const [profile, setProfile] = useState<PublicProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const fetchProfile = useCallback(async () => {
    try {
      const p = await usersApi.getProfile(username)
      setProfile(p as PublicProfile)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'User not found')
    } finally {
      setLoading(false)
    }
  }, [username])

  useEffect(() => { fetchProfile() }, [fetchProfile])

  if (loading) return <LoadingState message="Loading profile..." />
  if (error || !profile) return <ErrorState title={error || 'User not found'} onRetry={fetchProfile} />

  const completionRate = profile.completionRate ?? 0
  const avgRating = profile.avgRating ?? 0
  const badgeName = profile.badgeName ?? (
    (profile.completedTrades ?? 0) >= 100 ? 'Diamond' :
    (profile.completedTrades ?? 0) >= 50 ? 'Gold' :
    (profile.completedTrades ?? 0) >= 10 ? 'Silver' : 'Bronze'
  )

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 pb-24 lg:pb-6 space-y-5">
      {/* Header */}
      <div className="bg-white border border-border rounded-xl p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-full bg-primary/10 text-primary text-xl font-bold flex items-center justify-center uppercase">
              {(profile.username ?? 'U').slice(0, 2)}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-bold text-text-primary">{profile.username}</h1>
                <Badge variant="default" size="sm">{badgeName}</Badge>
              </div>
              {profile.fullName && <p className="text-sm text-text-muted">{profile.fullName}</p>}
              {profile.createdAt && (
                <p className="text-xs text-text-muted">Member since {new Date(profile.createdAt).toLocaleDateString('en-PK', { month: 'long', year: 'numeric' })}</p>
              )}
            </div>
          </div>
          <Link href={profile.activeAdId ? `/trade/new?adId=${profile.activeAdId}` : `/marketplace?user=${profile.username}`}>
            <Button size="sm">Trade with {profile.username}</Button>
          </Link>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Completed Trades', value: (profile.completedTrades ?? 0).toString() },
          { label: 'Completion Rate', value: `${completionRate.toFixed(1)}%` },
          { label: 'Avg Rating', value: avgRating > 0 ? avgRating.toFixed(1) : '—' },
          { label: 'Trust Score', value: (profile.trustScore ?? 0).toString() },
        ].map((stat) => (
          <div key={stat.label} className="bg-white border border-border rounded-xl p-4 text-center">
            <p className="text-xl font-bold text-text-primary">{stat.value}</p>
            <p className="text-xs text-text-muted mt-0.5">{stat.label}</p>
          </div>
        ))}
      </div>

      {/* Badge Card */}
      <div className="bg-white border border-border rounded-xl p-5 flex items-center gap-4">
        <div className="w-14 h-14 rounded-full bg-gold/10 text-gold text-2xl flex items-center justify-center border-2 border-gold/30">
          {badgeName === 'Diamond' ? '💎' : badgeName === 'Gold' ? '🥇' : badgeName === 'Silver' ? '🥈' : '🥉'}
        </div>
        <div>
          <p className="text-base font-bold text-text-primary">{badgeName} Trader</p>
          {profile.badgeLabel && <p className="text-sm text-text-muted">{profile.badgeLabel}</p>}
          <p className="text-xs text-text-muted mt-0.5">{profile.completedTrades ?? 0} completed trades</p>
        </div>
      </div>

      {/* Reviews */}
      <section>
        <h2 className="text-base font-semibold text-text-primary mb-3">Reviews</h2>
        {avgRating > 0 && (
          <div className="flex items-center gap-2 mb-3">
            <StarRating rating={avgRating} />
            <span className="text-sm font-semibold text-text-primary">{avgRating.toFixed(1)}</span>
          </div>
        )}
        <div className="bg-white border border-border rounded-xl overflow-hidden divide-y divide-border">
          {!profile.reviews || profile.reviews.length === 0 ? (
            <div className="py-8 text-center text-sm text-text-muted">No reviews yet</div>
          ) : (
            profile.reviews.slice(0, 10).map((review) => (
              <div key={review.id} className="px-4 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-text-primary">{review.reviewerUsername}</p>
                    <StarRating rating={review.rating} />
                  </div>
                  <span className="text-xs text-text-muted flex-shrink-0">{timeAgo(review.createdAt)}</span>
                </div>
                {review.comment && (
                  <p className="text-sm text-text-muted mt-2">{review.comment}</p>
                )}
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  )
}
