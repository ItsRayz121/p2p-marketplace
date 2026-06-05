'use client'
import { useState } from 'react'
import Link from 'next/link'
import { Badge } from '@/components/ui/Badge'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { traderDisplayName } from '@/lib/traderName'
import { PK_MOBILE_METHODS } from '@/lib/pkPaymentMethods'
import type { MarketplaceAd } from '@/lib/api'

function completionColor(pct: number) {
  if (pct >= 90) return 'text-success'
  if (pct >= 70) return 'text-warning'
  return 'text-danger'
}

function AdCard({ ad }: { ad: MarketplaceAd }) {
  const seller = ad.seller
  const stats = seller?.tradeStats
  const completionPct = stats?.completionRate ? parseFloat(stats.completionRate) * 100 : null
  const completedTrades = stats?.completedTrades ?? 0
  const rating = stats?.avgRating ? parseFloat(stats.avgRating) : 0
  const sellerName = traderDisplayName({ fullName: seller?.fullName, merchantName: seller?.merchantName, username: seller?.username })

  return (
    <div className="bg-surface shadow-card border border-border rounded-xl p-4 hover:shadow-card-md transition-shadow">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2">
            <UserAvatar name={sellerName} avatarUrl={seller?.avatarUrl} size="sm" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-text-primary truncate">{sellerName}</p>
              <div className="flex items-center gap-2 text-xs mt-0.5">
                {completionPct !== null && (
                  <span className={`font-bold ${completionColor(completionPct)}`}>{completionPct.toFixed(0)}%</span>
                )}
                {rating > 0 && (
                  <span className="text-text-muted flex items-center gap-0.5">
                    <span className="text-gold">★</span>{rating.toFixed(1)}
                  </span>
                )}
                <span className="text-text-muted">{completedTrades} done</span>
              </div>
            </div>
          </div>
          <p className="text-2xl font-bold text-text-primary">
            PKR {Number(ad.price).toLocaleString()}
            <span className="text-sm font-normal text-text-muted ml-1">/ {ad.coin}</span>
          </p>
          <p className="text-xs text-text-muted mt-1">
            Limit: PKR {Number(ad.minOrder).toLocaleString()} – {Number(ad.maxOrder).toLocaleString()}
          </p>
          <div className="flex flex-wrap gap-1 mt-2">
            {(ad.paymentMethods ?? []).map((pm) => (
              <Badge key={pm} variant="default" size="sm">
                <EntityLogo
                  type={PK_MOBILE_METHODS.includes(pm) ? 'payment_method' : 'bank'}
                  slug={pm} size="xs" className="flex-shrink-0 mr-1"
                />
                {pm}
              </Badge>
            ))}
          </div>
        </div>
        <Link
          href={`/marketplace/listings/${ad.id}`}
          className="flex-shrink-0 px-4 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary/90 transition-colors"
        >
          Trade
        </Link>
      </div>
    </div>
  )
}

interface TopAds {
  buys: MarketplaceAd[]
  sells: MarketplaceAd[]
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

function CtmListingCard({ listing }: { listing: CtmTopListing }) {
  return (
    <div className="bg-surface shadow-card border border-border rounded-xl p-4 hover:shadow-card-md transition-shadow">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2">
            <UserAvatar name={listing.merchantProfile.user.username} size="sm" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-text-primary truncate">{listing.merchantProfile.user.username}</p>
              <p className="text-xs text-text-muted">{listing.side === 'sell' ? 'Selling' : 'Buying'} {listing.token.symbol}</p>
            </div>
          </div>
          <p className="text-2xl font-bold text-text-primary">
            PKR {Number(listing.pricePerUnit).toLocaleString()}
            <span className="text-sm font-normal text-text-muted ml-1">/ {listing.token.symbol}</span>
          </p>
          {(listing.minOrderPkr || listing.maxOrderPkr) && (
            <p className="text-xs text-text-muted mt-1">
              Limit: PKR {listing.minOrderPkr ? Number(listing.minOrderPkr).toLocaleString() : '0'} – {listing.maxOrderPkr ? Number(listing.maxOrderPkr).toLocaleString() : '∞'}
            </p>
          )}
          <div className="flex flex-wrap gap-1 mt-2">
            {(listing.paymentMethods ?? []).slice(0, 3).map((pm) => (
              <Badge key={pm} variant="default" size="sm">{pm}</Badge>
            ))}
          </div>
        </div>
        <Link
          href={`/community-tokens/listings/${listing.id}`}
          className="flex-shrink-0 px-4 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary/90 transition-colors"
        >
          Trade
        </Link>
      </div>
    </div>
  )
}

type MainTab = 'buy' | 'sell' | 'ctm'

export function TopAdsSection({ topAds, topCtm }: { topAds: TopAds | null; topCtm?: CtmTopListing[] | null }) {
  const [activeTab, setActiveTab] = useState<MainTab>('buy')

  const p2pAds = topAds ? (activeTab === 'buy' ? (topAds.buys ?? []) : (topAds.sells ?? [])) : []
  const ctmListings = topCtm ?? []

  const tabs: { key: MainTab; label: string }[] = [
    { key: 'buy',  label: 'Buy USDT' },
    { key: 'sell', label: 'Sell USDT' },
    ...(ctmListings.length > 0 ? [{ key: 'ctm' as const, label: 'Community Tokens' }] : []),
  ]

  const viewAllHref = activeTab === 'ctm' ? '/community-tokens' : '/marketplace'

  return (
    <section className="py-12">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <h2 className="text-2xl font-bold text-text-primary mb-6">Top Offers</h2>

        <div className="flex gap-2 mb-6 flex-wrap">
          {tabs.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                activeTab === key
                  ? 'bg-primary text-white'
                  : 'bg-surface border border-border text-text-secondary hover:bg-surface-alt'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {activeTab === 'ctm' ? (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {ctmListings.slice(0, 6).map((l) => <CtmListingCard key={l.id} listing={l} />)}
            {ctmListings.length === 0 && (
              <div className="col-span-full flex flex-col items-center justify-center py-12 text-center gap-4">
                <p className="text-sm font-medium text-text-primary">No active community token offers</p>
                <Link href="/community-tokens" className="px-5 py-2.5 bg-primary text-white text-sm font-semibold rounded-lg hover:bg-primary/90 transition-colors">
                  Browse Community Tokens
                </Link>
              </div>
            )}
          </div>
        ) : topAds ? (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {p2pAds.map((ad) => <AdCard key={ad.id} ad={ad} />)}
            {p2pAds.length === 0 && (
              <div className="col-span-full flex flex-col items-center justify-center py-12 text-center gap-4">
                <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
                  <svg className="w-6 h-6 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                  </svg>
                </div>
                <div>
                  <p className="text-sm font-medium text-text-primary">No active offers available</p>
                  <p className="text-xs text-text-muted mt-1">Be the first to create a trading offer</p>
                </div>
                <Link
                  href="/create-ad"
                  className="px-5 py-2.5 bg-primary text-white text-sm font-semibold rounded-lg hover:bg-primary/90 transition-colors"
                >
                  Create Offer
                </Link>
              </div>
            )}
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="bg-surface shadow-card border border-border rounded-xl p-4 h-36 animate-pulse-subtle" />
            ))}
          </div>
        )}

        <div className="mt-6 text-center">
          <Link href={viewAllHref} className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline">
            View all offers
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </Link>
        </div>
      </div>
    </section>
  )
}
