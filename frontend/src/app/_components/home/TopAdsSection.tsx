'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Badge } from '@/components/ui/Badge'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { BadgeChip } from '@/components/ui/TraderLevelCard'
import type { TraderBadge } from '@/components/ui/TraderLevelCard'
import { traderDisplayName } from '@/lib/traderName'
import { PK_MOBILE_METHODS, isOpaqueId } from '@/lib/pkPaymentMethods'
import { marketplaceApi, ctmApi, gasApi } from '@/lib/api'
import type { MarketplaceAd } from '@/lib/api'

function completionColor(pct: number) {
  if (pct >= 90) return 'text-success'
  if (pct >= 70) return 'text-warning'
  return 'text-danger'
}

/** Shorten long opaque strings (wallet addresses / UIDs) like `cmpj…6fkfvl`. */
function shortLabel(value: string): string {
  if (value.length <= 14) return value
  return `${value.slice(0, 4)}…${value.slice(-6)}`
}

function AdCard({ ad }: { ad: MarketplaceAd }) {
  const seller = ad.seller
  const stats = seller?.tradeStats
  const completionPct = stats?.completionRate ? parseFloat(stats.completionRate) * 100 : null
  const completedTrades = stats?.completedTrades ?? 0
  const rating = stats?.avgRating ? parseFloat(stats.avgRating) : 0
  const sellerName = traderDisplayName({ fullName: seller?.fullName, merchantName: seller?.merchantName, username: seller?.username })
  // The ad's side is the trader's side. A trader "selling" USDT means the
  // visitor would buy from them, so the marketplace link mirrors that.
  const isTraderSelling = ad.side === 'sell'
  const ctaLabel = isTraderSelling ? 'Buy USDT' : 'Sell USDT'
  const marketSide = isTraderSelling ? 'buy' : 'sell'

  return (
    <div className="bg-surface shadow-card border border-border rounded-xl p-4 hover:shadow-card-md transition-shadow flex flex-col">
      <div className="flex items-center gap-2 mb-3">
        <UserAvatar name={sellerName} avatarUrl={seller?.avatarUrl} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="text-sm font-semibold text-text-primary truncate">{sellerName}</p>
            {seller?.badge && <BadgeChip badge={seller.badge as TraderBadge} />}
          </div>
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
        <Badge variant={isTraderSelling ? 'success' : 'warning'} size="sm">
          {isTraderSelling ? 'Selling' : 'Buying'}
        </Badge>
      </div>

      <p className="text-2xl font-bold text-text-primary">
        PKR {Number(ad.price).toLocaleString()}
        <span className="text-sm font-normal text-text-muted ml-1">/ {ad.coin}</span>
      </p>
      <p className="text-xs text-text-muted mt-1">
        Limit: PKR {Number(ad.minOrder).toLocaleString()} – {Number(ad.maxOrder).toLocaleString()}
      </p>
      <div className="flex flex-wrap gap-1 mt-2 min-h-[1.5rem]">
        {(ad.paymentMethods ?? []).filter((pm) => pm && !isOpaqueId(pm)).slice(0, 3).map((pm) => (
          <Badge key={pm} variant="default" size="sm">
            <EntityLogo
              type={PK_MOBILE_METHODS.includes(pm) ? 'payment_method' : 'bank'}
              slug={pm} size="xs" className="flex-shrink-0 mr-1"
            />
            {pm}
          </Badge>
        ))}
      </div>

      <Link
        href={`/marketplace?side=${marketSide}`}
        className="mt-3 w-full text-center px-4 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary/90 transition-colors"
      >
        {ctaLabel}
      </Link>
    </div>
  )
}

interface TopAds {
  buys: MarketplaceAd[]
  sells: MarketplaceAd[]
  usdt?: MarketplaceAd[]
  mode?: 'top' | 'latest' | 'pinned'
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
            <UserAvatar name={listing.merchantProfile.user.username} avatarUrl={listing.merchantProfile.user.avatarUrl ?? null} size="sm" />
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
          {(() => {
            // Drop opaque wallet addresses / UIDs; show only real payment labels.
            const labels = (listing.paymentMethods ?? []).filter((pm) => pm && !isOpaqueId(pm)).slice(0, 3)
            if (labels.length === 0) return null
            return (
              <div className="flex flex-wrap gap-1 mt-2">
                {labels.map((pm) => (
                  <Badge key={pm} variant="default" size="sm">{shortLabel(pm)}</Badge>
                ))}
              </div>
            )
          })()}
        </div>
        <Link
          href="/ctm/listings"
          className="flex-shrink-0 px-4 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary/90 transition-colors"
        >
          Browse Offers
        </Link>
      </div>
    </div>
  )
}

interface GasChainSummary {
  id: string
  slug: string
  name: string
  symbol: string
  logoUrl?: string | null
  platformFeeUsdt?: string | null
  isAvailable?: boolean
  isActive?: boolean
  orderable?: boolean
}

function GasChainCard({ chain }: { chain: GasChainSummary }) {
  const fee = chain.platformFeeUsdt ? Number(chain.platformFeeUsdt) : null
  return (
    <Link
      href="/gas"
      className="bg-surface shadow-card border border-border rounded-xl p-4 hover:shadow-card-md hover:border-primary/30 transition-all flex items-center gap-3"
    >
      <EntityLogo type="chain" slug={chain.slug || chain.symbol} size="lg" logoUrl={chain.logoUrl ?? undefined} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-text-primary truncate">{chain.name}</p>
        <p className="text-xs text-text-muted">{chain.symbol}</p>
        {fee !== null && (
          <p className="text-xs text-text-secondary mt-1">From <span className="font-semibold text-text-primary">${fee.toFixed(2)}</span></p>
        )}
      </div>
      {/* "Soon" only for chains users genuinely can't order yet — mirror the
          gas page's `!isActive || !orderable` rule, not the `isAvailable`
          (hot-wallet-funded) flag which stays false for live, orderable chains. */}
      {(chain.orderable === false || chain.isActive === false) && (
        <Badge variant="default" size="sm">Soon</Badge>
      )}
    </Link>
  )
}

function LoadingSkeleton() {
  return (
    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {[...Array(3)].map((_, i) => (
        <div key={i} className="bg-surface shadow-card border border-border rounded-xl p-4 h-36 animate-pulse-subtle" />
      ))}
    </div>
  )
}

type MainTab = 'usdt' | 'ctm' | 'gas'

export function TopAdsSection({ topAds, topCtm, topGas }: { topAds: TopAds | null; topCtm?: CtmTopListing[] | null; topGas?: GasChainSummary[] | null }) {
  const [activeTab, setActiveTab] = useState<MainTab>('usdt')

  // Seed from the server-rendered props for instant paint, but keep the data in
  // state so we can self-heal: when the Vercel SSR fetch to the backend fails
  // (server-to-server reachability), the props arrive `null` and we re-fetch
  // client-side from the browser, which can always reach the API.
  const [ads, setAds] = useState<TopAds | null>(topAds)
  const [ctm, setCtm] = useState<CtmTopListing[] | null>(topCtm ?? null)
  const [gas, setGas] = useState<GasChainSummary[] | null>(topGas ?? null)

  useEffect(() => {
    if (ads === null) {
      marketplaceApi.getTopAds()
        .then((d) => setAds(d as TopAds))
        .catch(() => setAds({ buys: [], sells: [] }))
    }
    if (ctm === null) {
      ctmApi.getListings({ limit: 6, side: 'sell', status: 'active' })
        .then((d) => setCtm((d.listings ?? []) as CtmTopListing[]))
        .catch(() => setCtm([]))
    }
    if (gas === null) {
      gasApi.getChains()
        .then((d) => setGas((d.chains ?? []) as unknown as GasChainSummary[]))
        .catch(() => setGas([]))
    }
    // Run once on mount — the props are the SSR snapshot; client refetch only
    // fills gaps left by a failed server fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Unified USDT list (admin-ranked server-side). Fall back to merging
  // buys/sells for older API responses that don't include `usdt`.
  const usdtAds = ads
    ? (ads.usdt && ads.usdt.length > 0
        ? ads.usdt
        : [...(ads.sells ?? []), ...(ads.buys ?? [])])
    : []
  const ctmListings = ctm ?? []
  const gasChains = gas ?? []

  // Always expose all three surfaces so the tabs never silently disappear; each
  // tab renders its own empty/CTA state when it has no data.
  const tabs: { key: MainTab; label: string }[] = [
    { key: 'usdt', label: 'USDT Marketplace' },
    { key: 'ctm', label: 'Community Tokens' },
    { key: 'gas', label: 'Crypto Gas Fees' },
  ]

  const viewAllHref = activeTab === 'ctm' ? '/ctm/listings' : activeTab === 'gas' ? '/gas' : '/marketplace'
  const viewAllLabel = activeTab === 'ctm' ? 'View all tokens' : activeTab === 'gas' ? 'View all gas services' : 'View all offers'

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

        {activeTab === 'gas' ? (
          gas === null ? (
            <LoadingSkeleton />
          ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 items-start">
            {gasChains.slice(0, 6).map((c) => <GasChainCard key={c.id} chain={c} />)}
            {gasChains.length === 0 && (
              <div className="col-span-full flex flex-col items-center justify-center py-12 text-center gap-4">
                <p className="text-sm font-medium text-text-primary">No gas services available yet</p>
                <Link href="/gas" className="px-5 py-2.5 bg-primary text-white text-sm font-semibold rounded-lg hover:bg-primary/90 transition-colors">
                  Explore Gas Fees
                </Link>
              </div>
            )}
          </div>
          )
        ) : activeTab === 'ctm' ? (
          ctm === null ? (
            <LoadingSkeleton />
          ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 items-start">
            {ctmListings.slice(0, 3).map((l) => <CtmListingCard key={l.id} listing={l} />)}
            {ctmListings.length === 0 && (
              <div className="col-span-full flex flex-col items-center justify-center py-12 text-center gap-4">
                <p className="text-sm font-medium text-text-primary">No active community token offers</p>
                <Link href="/ctm" className="px-5 py-2.5 bg-primary text-white text-sm font-semibold rounded-lg hover:bg-primary/90 transition-colors">
                  Browse Community Tokens
                </Link>
              </div>
            )}
          </div>
          )
        ) : ads ? (
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 items-start">
            {usdtAds.slice(0, 4).map((ad) => <AdCard key={ad.id} ad={ad} />)}
            {usdtAds.length === 0 && (
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
          <LoadingSkeleton />
        )}

        <div className="mt-6 text-center">
          <Link href={viewAllHref} className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline">
            {viewAllLabel}
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </Link>
        </div>
      </div>
    </section>
  )
}
