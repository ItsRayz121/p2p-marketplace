'use client'
import { useEffect, useState } from 'react'
import { ctmApi, favoritesApi } from '@/lib/api'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { traderDisplayName } from '@/lib/traderName'
import { toast } from '@/lib/toast'
import { Heart } from 'lucide-react'

interface Review {
  id: string
  rating: number
  comment: string | null
  tags: string[]
  createdAt: string
  raterUsername: string
  raterFullName: string | null
  raterAvatarUrl: string | null
  tradeRef: string | null
}

interface Profile {
  tier: string
  totalCtmTrades: number
  completedCtmTrades: number
  ctmAvgRating: string
  isFavorited?: boolean
  user: {
    id: string
    username: string
    fullName: string | null
    avatarUrl: string | null
    merchant: { businessName: string | null; status: string } | null
  }
  reviews: Review[]
}

const TIER_COLORS: Record<string, string> = {
  new: 'bg-surface-alt text-text-secondary',
  basic: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
  verified: 'bg-green-500/15 text-green-700 dark:text-green-300',
  elite: 'bg-purple-500/15 text-purple-700',
}

function StarRow({ rating }: { rating: number }) {
  const full = Math.round(rating)
  return (
    <span className="text-yellow-400 text-sm">
      {'★'.repeat(full)}
      {'☆'.repeat(5 - full)}
    </span>
  )
}

export function MerchantProfileModal({ userId, onClose }: { userId: string; onClose: () => void }) {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [favorited, setFavorited] = useState(false)
  const [favBusy, setFavBusy] = useState(false)

  useEffect(() => {
    const load = async () => {
      try {
        const res = await ctmApi.getPublicMerchant(userId)
        setProfile(res as Profile)
        setFavorited(!!(res as Profile).isFavorited)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load profile')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [userId])

  const toggleFavorite = async () => {
    if (!profile || favBusy) return
    setFavBusy(true)
    const next = !favorited
    setFavorited(next) // optimistic
    try {
      if (next) await favoritesApi.addFavorite(profile.user.username)
      else await favoritesApi.removeFavorite(profile.user.username)
      toast.success(next ? 'Added to favorites' : 'Removed from favorites')
    } catch {
      setFavorited(!next) // revert
      toast.error('Could not update favorites')
    } finally {
      setFavBusy(false)
    }
  }

  const avgRating = profile ? Number(profile.ctmAvgRating) : 0

  return (
    <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-surface rounded-2xl w-full max-w-lg max-h-[85vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-border flex items-center justify-between">
          <h3 className="font-bold text-lg text-text-primary">Merchant Profile</h3>
          <div className="flex items-center gap-1">
            {profile && (
              <button
                onClick={toggleFavorite}
                disabled={favBusy}
                aria-label={favorited ? 'Remove from favorites' : 'Add to favorites'}
                title={favorited ? 'Remove from favorites' : 'Add to favorites'}
                className={`p-1.5 rounded-full transition-colors ${favorited ? 'text-red-500 bg-red-500/10' : 'text-text-muted hover:text-red-500 hover:bg-red-500/10'}`}
              >
                <Heart size={18} className={favorited ? 'fill-current' : ''} />
              </button>
            )}
            <button onClick={onClose} aria-label="Close" className="text-text-muted hover:text-text-primary text-xl leading-none px-1.5">×</button>
          </div>
        </div>

        <div className="overflow-y-auto flex-1 p-5 space-y-4">
          {loading ? (
            <div className="animate-pulse space-y-3">
              <div className="h-16 bg-surface rounded-xl" />
              <div className="h-24 bg-surface rounded-xl" />
              <div className="h-24 bg-surface rounded-xl" />
            </div>
          ) : error ? (
            <p className="text-sm text-red-600 dark:text-red-400 text-center py-8">{error}</p>
          ) : !profile ? (
            <p className="text-sm text-text-muted text-center py-8">Profile not found.</p>
          ) : (
            <>
              {/* Header */}
              <div className="flex items-center gap-3">
                <UserAvatar
                  name={traderDisplayName({
                    fullName: profile.user.fullName,
                    merchantName: profile.user.merchant?.status === 'approved' ? profile.user.merchant.businessName : null,
                    username: profile.user.username,
                  })}
                  avatarUrl={profile.user.avatarUrl}
                  size="lg"
                />
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-text-primary">{traderDisplayName({
                      fullName: profile.user.fullName,
                      merchantName: profile.user.merchant?.status === 'approved' ? profile.user.merchant.businessName : null,
                      username: profile.user.username,
                    })}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${TIER_COLORS[profile.tier] ?? 'bg-surface-alt text-text-secondary'}`}>{profile.tier}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <StarRow rating={avgRating} />
                    <span className="text-xs text-text-muted">{avgRating > 0 ? avgRating.toFixed(1) : 'No ratings yet'}</span>
                  </div>
                </div>
              </div>

              {/* Stats */}
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-surface rounded-xl p-3 text-center">
                  <p className="text-xs text-text-muted">Completed trades</p>
                  <p className="text-lg font-bold text-text-primary">{profile.completedCtmTrades}</p>
                </div>
                <div className="bg-surface rounded-xl p-3 text-center">
                  <p className="text-xs text-text-muted">Total reviews</p>
                  <p className="text-lg font-bold text-text-primary">{profile.reviews.length}</p>
                </div>
              </div>

              {/* Reviews */}
              <div>
                <h4 className="font-semibold text-sm text-text-primary mb-2">Reviews</h4>
                {profile.reviews.length === 0 ? (
                  <p className="text-sm text-text-muted text-center py-6">No reviews yet.</p>
                ) : (
                  <div className="space-y-3">
                    {profile.reviews.map((r) => (
                      <div key={r.id} className="border border-border rounded-xl p-3">
                        <div className="flex items-center justify-between mb-1">
                          <div className="flex items-center gap-2">
                            <UserAvatar
                              name={traderDisplayName({ fullName: r.raterFullName, username: r.raterUsername })}
                              avatarUrl={r.raterAvatarUrl}
                              size="xs"
                            />
                            <StarRow rating={r.rating} />
                            <span className="text-xs font-medium text-text-primary">{traderDisplayName({ fullName: r.raterFullName, username: r.raterUsername })}</span>
                          </div>
                          <span className="text-xs text-text-muted">{new Date(r.createdAt).toLocaleDateString()}</span>
                        </div>
                        {r.comment && <p className="text-sm text-text-secondary mt-1">{r.comment}</p>}
                        {r.tradeRef && (
                          <p className="text-xs text-text-muted mt-1.5">Trade: <span className="font-mono">#{r.tradeRef.slice(-8)}</span></p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
