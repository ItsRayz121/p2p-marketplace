'use client'
import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { apiRequest } from '@/lib/api'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { BadgeChip } from '@/components/ui/TraderLevelCard'
import type { TraderBadge } from '@/components/ui/TraderLevelCard'
import { EmptyState } from '@/components/ui/EmptyState'
import { Heart } from 'lucide-react'
import { toast } from '@/lib/toast'

interface FavoriteTrader {
  favoritedAt: string
  trader: {
    id: string
    username: string
    lastSeenAt: string | null
    tradeStats: {
      badge: string
      completedTrades: number
      completionRate: string | number
      avgRating: string | number
      avgResponseMinutes: number | null
    } | null
    merchant: { id: string; status: string } | null
    ads: Array<{
      id: string
      side: string
      coin: string
      price: string
      availableAmount: string
      minOrder: string
      maxOrder: string
      paymentMethods: string[]
    }>
  }
}

function onlineDot(lastSeenAt: string | null): string {
  if (!lastSeenAt) return 'bg-border'
  const mins = Math.floor((Date.now() - new Date(lastSeenAt).getTime()) / 60_000)
  if (mins < 10) return 'bg-success animate-pulse'
  if (mins < 60) return 'bg-success'
  if (mins < 1440) return 'bg-yellow-400'
  return 'bg-border'
}

export default function FavoritesPage() {
  const [favorites, setFavorites] = useState<FavoriteTrader[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchFavorites = useCallback(async () => {
    try {
      const data = await apiRequest<FavoriteTrader[]>('/users/me/favorites')
      setFavorites(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load favorites')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchFavorites() }, [fetchFavorites])

  async function removeFavorite(username: string) {
    try {
      await apiRequest(`/users/${encodeURIComponent(username)}/favorite`, { method: 'DELETE' })
      setFavorites((prev) => prev.filter((f) => f.trader.username !== username))
      toast.success('Removed from favorites')
    } catch {
      toast.error('Could not remove favorite')
    }
  }

  if (loading) return <LoadingState message="Loading favorites..." />
  if (error) return <ErrorState title={error} onRetry={fetchFavorites} />

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="flex items-center gap-3 mb-6">
        <Heart size={20} className="text-red-500 fill-current" />
        <h1 className="text-2xl font-bold text-text-primary">Favorite Traders</h1>
        <span className="text-sm text-text-muted">({favorites.length})</span>
      </div>

      {favorites.length === 0 ? (
        <EmptyState
          title="No favorites yet"
          description="Visit a trader's profile and tap the heart icon to save them here."
        />
      ) : (
        <div className="space-y-4">
          {favorites.map(({ trader }) => {
            const stats = trader.tradeStats
            const badge = (stats?.badge ?? 'new') as TraderBadge
            const completionPct = stats?.completionRate != null
              ? (parseFloat(String(stats.completionRate)) * 100).toFixed(0)
              : null
            const rating = stats?.avgRating ? parseFloat(String(stats.avgRating)).toFixed(1) : null

            return (
              <div key={trader.id} className="bg-surface shadow-card border border-border rounded-xl p-4">
                <div className="flex flex-wrap items-start gap-4">
                  {/* Avatar + online */}
                  <div className="relative flex-shrink-0">
                    <UserAvatar name={trader.username} size="md" />
                    <span className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-surface ${onlineDot(trader.lastSeenAt)}`} />
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Link href={`/profile/${trader.username}`} className="font-semibold text-text-primary hover:underline">
                        {trader.username}
                      </Link>
                      <BadgeChip badge={badge} />
                      {trader.merchant?.status === 'approved' && (
                        <span className="text-[10px] font-bold text-primary bg-primary/10 px-1.5 py-0.5 rounded-full">Merchant</span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-xs text-text-muted">
                      {completionPct !== null && <span className="text-success font-semibold">{completionPct}%</span>}
                      {rating && <span>★ {rating}</span>}
                      {stats && <span>{stats.completedTrades} trades</span>}
                    </div>
                  </div>

                  {/* Active ads preview */}
                  {trader.ads.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {trader.ads.map((ad) => (
                        <Link
                          key={ad.id}
                          href={`/trade/new?adId=${ad.id}`}
                          className={`px-3 py-1.5 rounded-lg text-xs font-semibold text-white transition-colors ${
                            ad.side === 'sell' ? 'bg-green-600 hover:bg-green-700' : 'bg-blue-600 hover:bg-blue-700'
                          }`}
                        >
                          {ad.side === 'sell' ? 'Buy' : 'Sell'} {ad.coin} @ PKR {Number(ad.price).toLocaleString()}
                        </Link>
                      ))}
                    </div>
                  )}

                  {/* Remove button */}
                  <button
                    onClick={() => removeFavorite(trader.username)}
                    className="p-1.5 rounded-full text-red-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors flex-shrink-0"
                    title="Remove from favorites"
                  >
                    <Heart size={16} className="fill-current" />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
