'use client'
import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { apiRequest, ApiError } from '@/lib/api'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { LoadingState } from '@/components/ui/LoadingState'
import { EmptyState } from '@/components/ui/EmptyState'
import { PageContainer } from '@/components/layout/PageContainer'

// ─── Types ────────────────────────────────────────────────────────────────────

interface InventoryPreviewItem {
  id: string
  coin: string
  network: string
  price: string
  minAmount: string
  maxAmount: string
}

interface Review {
  id: string
  reviewerUsername: string
  rating: number
  comment?: string
  createdAt: string
}

interface PublicMerchantProfile {
  id: string
  businessName: string
  username: string
  rank?: string
  memberSince: string
  totalTrades: number
  completionRate: number
  avgRating: number
  totalVolumePKR: string
  isActive: boolean
  inventoryPreview: InventoryPreviewItem[]
  reviews: Review[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function StarRating({ rating, size = 'md' }: { rating: number; size?: 'sm' | 'md' }) {
  const px = size === 'sm' ? 'w-3.5 h-3.5' : 'w-5 h-5'
  return (
    <span className="inline-flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((star) => (
        <svg
          key={star}
          className={`${px} ${star <= Math.round(rating) ? 'text-gold' : 'text-border'}`}
          fill="currentColor"
          viewBox="0 0 20 20"
        >
          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
        </svg>
      ))}
    </span>
  )
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-PK', { year: 'numeric', month: 'short', day: 'numeric' })
}

function formatMemberSince(iso: string) {
  return new Date(iso).toLocaleDateString('en-PK', { year: 'numeric', month: 'long' })
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function PublicMerchantProfilePage() {
  const params = useParams()
  const merchantId = params.id as string

  const [profile, setProfile] = useState<PublicMerchantProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!merchantId) return
    setLoading(true)
    setError('')
    apiRequest<PublicMerchantProfile>(`/merchants/${merchantId}/public`)
      .then((data) => setProfile(data))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) {
          setNotFound(true)
        } else {
          setError(err instanceof ApiError ? err.message : 'Failed to load merchant profile.')
        }
      })
      .finally(() => setLoading(false))
  }, [merchantId])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <LoadingState message="Loading merchant profile..." />
      </div>
    )
  }

  if (notFound) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="text-center space-y-4 max-w-sm">
          <div className="w-16 h-16 rounded-full bg-surface flex items-center justify-center mx-auto">
            <svg className="w-8 h-8 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-text-primary">Merchant Not Found</h1>
          <p className="text-sm text-text-muted">
            This merchant profile does not exist or has been removed.
          </p>
          <Link href="/marketplace">
            <Button variant="secondary" className="mt-2">Browse Marketplace</Button>
          </Link>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center space-y-3 px-4">
          <p className="text-danger font-medium">{error}</p>
          <Button variant="secondary" onClick={() => window.location.reload()}>Retry</Button>
        </div>
      </div>
    )
  }

  if (!profile) return null

  return (
    <div className="min-h-screen bg-surface pb-24">
      <PageContainer>
        <div className="py-6 space-y-6 max-w-2xl mx-auto">

          {/* ── Header ── */}
          <div className="bg-white rounded-xl border border-border p-5 sm:p-6">
            <div className="flex items-start gap-4">
              {/* Avatar */}
              <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                <span className="text-xl sm:text-2xl font-bold text-primary">
                  {profile.businessName.charAt(0).toUpperCase()}
                </span>
              </div>
              <div className="flex-1 min-w-0 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-lg sm:text-xl font-bold text-text-primary">{profile.businessName}</h1>
                  <Badge variant="gold" size="sm">Verified Merchant</Badge>
                  {profile.rank && (
                    <Badge variant="outline" size="sm">{profile.rank}</Badge>
                  )}
                </div>
                <p className="text-sm text-text-muted">@{profile.username}</p>
                <div className="flex flex-wrap items-center gap-3 text-xs text-text-muted">
                  <span>Member since {formatMemberSince(profile.memberSince)}</span>
                  <Badge variant={profile.isActive ? 'success' : 'warning'} size="sm">
                    {profile.isActive ? 'Online' : 'Offline'}
                  </Badge>
                </div>
              </div>
            </div>
          </div>

          {/* ── Stats ── */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-white rounded-xl border border-border p-4 text-center">
              <p className="text-2xl font-bold text-text-primary">{profile.totalTrades}</p>
              <p className="text-xs text-text-muted mt-0.5">Total Trades</p>
            </div>
            <div className="bg-white rounded-xl border border-border p-4 text-center">
              <p className="text-2xl font-bold text-success">{profile.completionRate.toFixed(0)}%</p>
              <p className="text-xs text-text-muted mt-0.5">Completion</p>
            </div>
            <div className="bg-white rounded-xl border border-border p-4 text-center">
              <div className="flex justify-center mb-1">
                <StarRating rating={profile.avgRating} size="sm" />
              </div>
              <p className="text-xl font-bold text-text-primary">{profile.avgRating.toFixed(1)}</p>
              <p className="text-xs text-text-muted">Rating</p>
            </div>
            <div className="bg-white rounded-xl border border-border p-4 text-center">
              <p className="text-lg font-bold text-text-primary leading-tight">
                {Number(profile.totalVolumePKR) >= 1_000_000
                  ? `${(Number(profile.totalVolumePKR) / 1_000_000).toFixed(1)}M`
                  : Number(profile.totalVolumePKR) >= 1_000
                  ? `${(Number(profile.totalVolumePKR) / 1_000).toFixed(0)}K`
                  : Number(profile.totalVolumePKR).toLocaleString('en-PK')}
              </p>
              <p className="text-xs text-text-muted mt-0.5">PKR Volume</p>
            </div>
          </div>

          {/* ── Inventory Preview ── */}
          <section className="bg-white rounded-xl border border-border overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <h2 className="text-base font-semibold text-text-primary">Available Offers</h2>
            </div>
            {profile.inventoryPreview.length === 0 ? (
              <div className="px-5">
                <EmptyState title="No active offers" description="This merchant has no active buy offers at the moment." />
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {profile.inventoryPreview.map((item) => (
                  <li key={item.id} className="px-5 py-4 flex items-center gap-4">
                    <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                      <span className="text-xs font-bold text-primary">{item.coin}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-semibold text-text-primary">{item.coin}</p>
                        <Badge variant="outline" size="sm">{item.network}</Badge>
                      </div>
                      <p className="text-xs text-text-muted mt-0.5">
                        Limits: {item.minAmount} – {item.maxAmount} {item.coin}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-bold text-text-primary">
                        PKR {Number(item.price).toLocaleString('en-PK')}
                      </p>
                      <p className="text-xs text-text-muted">per {item.coin}</p>
                    </div>
                    <Link href={`/trade/new?adId=${item.id}`}>
                      <Button size="sm">Trade</Button>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* ── Reviews ── */}
          <section className="bg-white rounded-xl border border-border overflow-hidden">
            <div className="px-5 py-4 border-b border-border flex items-center justify-between">
              <h2 className="text-base font-semibold text-text-primary">Reviews</h2>
              {profile.reviews.length > 0 && (
                <div className="flex items-center gap-1.5">
                  <StarRating rating={profile.avgRating} size="sm" />
                  <span className="text-sm font-medium text-text-secondary">{profile.avgRating.toFixed(1)}</span>
                </div>
              )}
            </div>
            {profile.reviews.length === 0 ? (
              <div className="px-5">
                <EmptyState title="No reviews yet" description="This merchant hasn't received any reviews yet." />
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {profile.reviews.map((review) => (
                  <li key={review.id} className="px-5 py-4 space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-full bg-surface flex items-center justify-center shrink-0">
                          <span className="text-xs font-semibold text-text-secondary">
                            {review.reviewerUsername.charAt(0).toUpperCase()}
                          </span>
                        </div>
                        <span className="text-sm font-medium text-text-primary">@{review.reviewerUsername}</span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <StarRating rating={review.rating} size="sm" />
                        <span className="text-xs text-text-muted">{formatDate(review.createdAt)}</span>
                      </div>
                    </div>
                    {review.comment && (
                      <p className="text-sm text-text-secondary pl-9 leading-relaxed">{review.comment}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* ── Contact CTA ── */}
          <div className="flex flex-col sm:flex-row gap-3">
            <Link href={`/marketplace?merchantId=${profile.id}`} className="flex-1">
              <Button variant="primary" fullWidth size="lg">
                Contact Merchant
              </Button>
            </Link>
            <Link href={`/marketplace?merchantId=${profile.id}`} className="flex-1">
              <Button variant="secondary" fullWidth size="lg">
                View All Offers
              </Button>
            </Link>
          </div>

        </div>
      </PageContainer>
    </div>
  )
}
