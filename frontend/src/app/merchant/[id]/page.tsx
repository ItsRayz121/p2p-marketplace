'use client'
import { useState, useEffect, useCallback, use } from 'react'
import Link from 'next/link'
import { merchantsApi, marketplaceApi } from '@/lib/api'
import type { MarketplaceAd } from '@/lib/api'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { BadgeChip } from '@/components/ui/TraderLevelCard'
import type { TraderBadge } from '@/components/ui/TraderLevelCard'
import { Badge } from '@/components/ui/Badge'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { PK_MOBILE_METHODS } from '@/lib/pkPaymentMethods'
import { ShieldCheck, Star, TrendingUp, ArrowLeft } from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

type MerchantPublicProfile = Awaited<ReturnType<typeof merchantsApi.getPublicProfile>>

const RANK_LABELS: Record<string, string> = {
  bronze: 'Bronze Merchant',
  silver: 'Silver Merchant',
  gold:   'Gold Merchant',
  elite:  'Elite Merchant',
}

const RANK_COLORS: Record<string, string> = {
  bronze: 'text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/30',
  silver: 'text-slate-500 dark:text-slate-300 bg-slate-500/10 border-slate-500/30',
  gold:   'text-yellow-600 dark:text-yellow-400 bg-yellow-500/10 border-yellow-500/30',
  elite:  'text-primary bg-primary/10 border-primary/20',
}

function fmtPct(rate: number) {
  return `${(rate * 100).toFixed(1)}%`
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const days = Math.floor(diff / 86_400_000)
  if (days < 1) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months} month${months > 1 ? 's' : ''} ago`
  return `${Math.floor(months / 12)} year${Math.floor(months / 12) > 1 ? 's' : ''} ago`
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function MerchantProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const [merchant, setMerchant] = useState<MerchantPublicProfile | null>(null)
  const [ads, setAds] = useState<MarketplaceAd[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    try {
      const [merchantRes, adsRes] = await Promise.allSettled([
        merchantsApi.getPublicProfile(id),
        marketplaceApi.getAds({ merchantId: id, limit: 10 }),
      ])
      if (merchantRes.status === 'fulfilled') setMerchant(merchantRes.value)
      else throw new Error('Merchant not found')
      if (adsRes.status === 'fulfilled') setAds(adsRes.value.ads ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load merchant')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { fetchData() }, [fetchData])

  if (loading) return <LoadingState message="Loading merchant profile..." />
  if (error || !merchant) return <ErrorState title={error ?? 'Merchant not found'} onRetry={fetchData} />

  const stats = merchant.user.tradeStats
  const badge = (stats?.badge ?? 'new') as TraderBadge
  const rankCls = RANK_COLORS[merchant.rank] ?? RANK_COLORS.bronze
  const completionPct = stats?.completionRate != null ? stats.completionRate : null
  const completionColor =
    completionPct === null ? 'text-text-muted' :
    completionPct >= 0.90  ? 'text-success' :
    completionPct >= 0.70  ? 'text-warning' : 'text-danger'

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-5">

      {/* Back nav */}
      <Link href="/marketplace" className="inline-flex items-center gap-1.5 text-xs text-text-muted hover:text-primary transition-colors">
        <ArrowLeft size={13} />
        Back to Marketplace
      </Link>

      {/* Header card */}
      <div className="bg-surface shadow-card rounded-xl border border-border p-6">
        <div className="flex flex-wrap items-start gap-5">
          <UserAvatar name={merchant.businessName || merchant.user.fullName || merchant.user.username} avatarUrl={merchant.user.avatarUrl} size="xl" className="flex-shrink-0" />

          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <h1 className="text-xl font-bold text-text-primary">{merchant.businessName}</h1>
              <span className={`inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full border ${rankCls}`}>
                <ShieldCheck size={11} />
                {RANK_LABELS[merchant.rank] ?? 'Verified Merchant'}
              </span>
            </div>

            <p className="text-sm text-text-muted mb-2">
              @{merchant.user.username} · Member since {timeAgo(merchant.user.createdAt)}
            </p>

            <div className="flex flex-wrap items-center gap-2">
              <BadgeChip badge={badge} />
              {merchant.approvedAt && (
                <span className="text-xs text-text-muted">
                  Verified {timeAgo(merchant.approvedAt)}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Stats grid */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-surface shadow-card rounded-xl border border-border p-4 text-center">
            <p className="text-2xl font-bold text-text-primary">{stats.completedTrades.toLocaleString()}</p>
            <p className="text-xs text-text-muted mt-0.5">Completed Trades</p>
          </div>
          <div className="bg-surface shadow-card rounded-xl border border-border p-4 text-center">
            {completionPct !== null && (
              <p className={`text-2xl font-bold ${completionColor}`}>{fmtPct(completionPct)}</p>
            )}
            <p className="text-xs text-text-muted mt-0.5">Completion Rate</p>
          </div>
          <div className="bg-surface shadow-card rounded-xl border border-border p-4 text-center">
            <div className="flex items-center justify-center gap-1">
              <Star size={14} className="text-gold" fill="currentColor" />
              <p className="text-2xl font-bold text-text-primary">{Number(stats.avgRating).toFixed(1)}</p>
            </div>
            <p className="text-xs text-text-muted mt-0.5">{stats.totalReviews} reviews</p>
          </div>
          <div className="bg-surface shadow-card rounded-xl border border-border p-4 text-center">
            <p className="text-2xl font-bold text-text-primary">
              {Number(stats.totalVolumePKR) > 1_000_000
                ? `${(Number(stats.totalVolumePKR) / 1_000_000).toFixed(1)}M`
                : Number(stats.totalVolumePKR) > 1_000
                ? `${(Number(stats.totalVolumePKR) / 1_000).toFixed(0)}K`
                : Number(stats.totalVolumePKR).toLocaleString()}
            </p>
            <p className="text-xs text-text-muted mt-0.5">Volume (PKR)</p>
          </div>
        </div>
      )}

      {/* Active listings */}
      {ads.length > 0 && (
        <div className="bg-surface shadow-card rounded-xl border border-border p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2">
              <TrendingUp size={14} className="text-primary" />
              Active Listings
              <span className="text-xs font-normal text-text-muted">({ads.length})</span>
            </h2>
            <Link href={`/marketplace`} className="text-xs text-primary hover:underline">
              View all →
            </Link>
          </div>
          <div className="space-y-3">
            {ads.map((ad) => {
              const isSell = ad.side === 'sell'
              const accentCls = isSell ? 'border-l-emerald-500' : 'border-l-blue-500'
              const priceCls  = isSell ? 'text-emerald-600 dark:text-emerald-400' : 'text-blue-600 dark:text-blue-400'
              const chipCls   = isSell ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
              return (
                <Link
                  key={ad.id}
                  href={`/marketplace/listings/${ad.id}`}
                  className={`block bg-surface border border-border rounded-xl p-4 hover:shadow-card-md transition-shadow border-l-4 ${accentCls}`}
                >
                  <div className="flex items-center justify-between gap-4 flex-wrap">
                    <div className="flex items-center gap-3">
                      <EntityLogo type="token" slug="USDT" size="md" />
                      <div>
                        <p className={`text-lg font-bold ${priceCls}`}>PKR {Number(ad.price).toLocaleString()}</p>
                        <p className="text-xs text-text-muted">{ad.network} · {Number(ad.minOrder).toLocaleString()}–{Number(ad.maxOrder).toLocaleString()} {ad.coin}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${chipCls}`}>
                        {isSell ? 'SELLING' : 'BUYING'}
                      </span>
                      {(ad.paymentMethods ?? []).slice(0, 3).map((pm) => (
                        <span key={pm} className="inline-flex items-center gap-1 text-xs bg-surface-alt border border-border rounded-full px-2 py-0.5">
                          <EntityLogo type={PK_MOBILE_METHODS.includes(pm) ? 'payment_method' : 'bank'} slug={pm} size="xs" />
                          {pm}
                        </span>
                      ))}
                    </div>
                    <Badge variant={isSell ? 'success' : 'info'} size="sm">
                      {isSell ? `Buy ${ad.coin}` : `Sell ${ad.coin}`}
                    </Badge>
                  </div>
                </Link>
              )
            })}
          </div>
        </div>
      )}

      {ads.length === 0 && (
        <div className="bg-surface shadow-card rounded-xl border border-border p-8 text-center">
          <p className="text-text-muted text-sm">No active listings from this merchant right now.</p>
          <Link href="/marketplace" className="mt-2 inline-block text-xs text-primary hover:underline">
            Browse all listings →
          </Link>
        </div>
      )}
    </div>
  )
}
