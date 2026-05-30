'use client'
import { useState, useEffect, useCallback, Suspense } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { adsApi, ctmApi } from '@/lib/api'
import type { Ad } from '@/lib/api'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Badge } from '@/components/ui/Badge'
import { Tag, LayoutList, BarChart3 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { ConfirmModal } from '@/components/ui/ConfirmModal'
import { Spinner } from '@/components/ui/Spinner'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { PK_MOBILE_METHODS } from '@/lib/pkPaymentMethods'
import { useAuth } from '@/hooks/useAuth'

// ─── Types ───────────────────────────────────────────────────────────────────

interface CtmListing {
  id: string
  side: string
  status: string
  pricePerUnit: string
  availableAmount: string
  totalAmount: string
  minOrderTokens: string
  maxOrderTokens: string
  paymentMethods: string[]
  createdAt: string
  token: { id: string; name: string; symbol: string; logoUrl?: string }
}

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

type Tab = 'usdt' | 'ctm' | 'analytics'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function statusVariant(s: string): 'success' | 'warning' | 'danger' | 'default' {
  if (s === 'active') return 'success'
  if (s === 'paused') return 'warning'
  if (s === 'inactive') return 'danger'
  return 'default'
}

const AD_STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  paused: 'Paused',
  inactive: 'Inactive',
}
const adStatusLabel = (s: string) => AD_STATUS_LABELS[s] ?? s.charAt(0).toUpperCase() + s.slice(1)

const TIER_COLORS: Record<string, string> = {
  new: 'bg-surface-alt text-text-secondary',
  basic: 'bg-blue-100 text-blue-700',
  verified: 'bg-green-100 text-green-700',
  elite: 'bg-primary/10 text-primary',
}

const TIER_NEXT: Record<string, { requirement: string }> = {
  new: { requirement: '10 completed trades to upgrade to Basic' },
  basic: { requirement: 'Apply to admin for Verified tier' },
  verified: { requirement: '200 completed trades + <2% dispute rate for Elite' },
  elite: { requirement: 'You are at the highest tier!' },
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

// ─── Tab: USDT Ads ────────────────────────────────────────────────────────────

function UsdtAdsTab() {
  const router = useRouter()
  const [ads, setAds] = useState<Ad[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [toggling, setToggling] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Ad | null>(null)
  const [deleting, setDeleting] = useState(false)

  const fetchAds = useCallback(async () => {
    try {
      const res = await adsApi.getMyAds({ limit: 100 })
      setAds(res.items ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load ads')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchAds() }, [fetchAds])

  const handleToggle = async (ad: Ad) => {
    setToggling(ad.id)
    try {
      const updated = ad.status === 'active'
        ? await adsApi.pauseAd(ad.id)
        : await adsApi.activateAd(ad.id)
      setAds((prev) => prev.map((a) => a.id === ad.id ? updated : a))
    } catch { /* silent */ } finally {
      setToggling(null)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await adsApi.deleteAd(deleteTarget.id)
      setAds((prev) => prev.filter((a) => a.id !== deleteTarget.id))
      setDeleteTarget(null)
    } catch { /* silent */ } finally {
      setDeleting(false)
    }
  }

  if (loading) return <LoadingState message="Loading your ads..." />
  if (error) return <ErrorState title={error} onRetry={fetchAds} />

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-text-muted">{ads.length} listing{ads.length !== 1 ? 's' : ''}</p>
        <Link href="/create-ad">
          <Button size="sm">+ Create Listing</Button>
        </Link>
      </div>

      {ads.length === 0 ? (
        <EmptyState
          icon={Tag}
          title="No USDT listings yet"
          description="Create your first buy or sell listing to start trading on RupChain."
          action={{ label: 'Create Your First Listing', onClick: () => router.push('/create-ad') }}
        />
      ) : (
        <>
          <div className="hidden md:block bg-surface shadow-card border border-border rounded-xl overflow-hidden">
            <table className="w-full">
              <thead className="bg-surface border-b border-border">
                <tr>
                  {['Side', 'Coin', 'Price (PKR)', 'Min / Max', 'Available', 'Status', 'Actions'].map((h) => (
                    <th key={h} className="text-left text-xs font-semibold text-text-muted px-4 py-3">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {ads.map((ad) => (
                  <tr key={ad.id} className="hover:bg-surface/50 transition-colors">
                    <td className="px-4 py-3">
                      <Badge variant={ad.side === 'buy' ? 'success' : 'danger'} size="sm">{ad.side.toUpperCase()}</Badge>
                    </td>
                    <td className="px-4 py-3 text-sm font-semibold text-text-primary">{ad.coin}</td>
                    <td className="px-4 py-3 text-sm text-text-primary">{parseFloat(ad.price).toLocaleString()}</td>
                    <td className="px-4 py-3 text-sm text-text-muted">
                      {parseFloat(ad.minOrder).toLocaleString()} – {parseFloat(ad.maxOrder).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-sm text-text-primary">—</td>
                    <td className="px-4 py-3">
                      <Badge variant={statusVariant(ad.status)} size="sm">{adStatusLabel(ad.status)}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Link href={`/marketplace/listings/${ad.id}`}>
                          <Button size="sm" variant="secondary">View</Button>
                        </Link>
                        <Button size="sm" variant="secondary" onClick={() => handleToggle(ad)} disabled={toggling === ad.id}>
                          {toggling === ad.id ? <Spinner size="sm" /> : ad.status === 'active' ? 'Pause' : 'Activate'}
                        </Button>
                        <Link href={`/create-ad?edit=${ad.id}`}>
                          <Button size="sm" variant="secondary">Edit</Button>
                        </Link>
                        <Button size="sm" variant="secondary" onClick={() => setDeleteTarget(ad)} className="text-danger hover:bg-danger/10">
                          Delete
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="md:hidden space-y-3">
            {ads.map((ad) => (
              <div key={ad.id} className="bg-surface shadow-card border border-border rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Badge variant={ad.side === 'buy' ? 'success' : 'danger'} size="sm">{ad.side.toUpperCase()}</Badge>
                    <span className="text-sm font-bold text-text-primary">{ad.coin}</span>
                  </div>
                  <Badge variant={statusVariant(ad.status)} size="sm">{adStatusLabel(ad.status)}</Badge>
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <p className="text-text-muted text-xs">Price</p>
                    <p className="font-semibold text-text-primary">PKR {parseFloat(ad.price).toLocaleString()}</p>
                  </div>
                  <div>
                    <p className="text-text-muted text-xs">Min / Max</p>
                    <p className="font-semibold text-text-primary text-xs">
                      {parseFloat(ad.minOrder).toLocaleString()} – {parseFloat(ad.maxOrder).toLocaleString()}
                    </p>
                  </div>
                  {ad.paymentMethods.length > 0 && (
                    <div className="col-span-2">
                      <p className="text-text-muted text-xs mb-1">Payment Methods</p>
                      <div className="flex flex-wrap gap-1">
                        {ad.paymentMethods.map((pm) => (
                          <span key={pm} className="inline-flex items-center gap-1 text-xs bg-surface border border-border px-2 py-0.5 rounded-full text-text-muted">
                            <EntityLogo type={PK_MOBILE_METHODS.includes(pm) ? 'payment_method' : 'bank'} slug={pm} size="xs" className="flex-shrink-0" />
                            {pm}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex gap-2">
                  <Link href={`/marketplace/listings/${ad.id}`} className="flex-1">
                    <Button size="sm" variant="secondary" className="w-full">View</Button>
                  </Link>
                  <Button size="sm" variant="secondary" className="flex-1" onClick={() => handleToggle(ad)} disabled={toggling === ad.id}>
                    {toggling === ad.id ? <Spinner size="sm" /> : ad.status === 'active' ? 'Pause' : 'Activate'}
                  </Button>
                  <Link href={`/create-ad?edit=${ad.id}`}>
                    <Button size="sm" variant="secondary">Edit</Button>
                  </Link>
                  <Button size="sm" variant="secondary" className="text-danger hover:bg-danger/10" onClick={() => setDeleteTarget(ad)}>
                    Delete
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {deleteTarget && (
        <ConfirmModal
          isOpen={!!deleteTarget}
          onClose={() => setDeleteTarget(null)}
          title="Delete Ad"
          description={`Are you sure you want to delete this ${deleteTarget.side} ad for ${deleteTarget.coin}? This action cannot be undone.`}
          confirmLabel="Delete"
          cancelLabel="Cancel"
          onConfirm={handleDelete}
          confirmVariant="danger"
        />
      )}
    </>
  )
}

// ─── Tab: CTM Listings ────────────────────────────────────────────────────────

function CtmListingsTab() {
  const [listings, setListings] = useState<CtmListing[]>([])
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const fetchListings = useCallback(async () => {
    try {
      const res = await ctmApi.getMyListings()
      setListings((res as { listings: CtmListing[] }).listings ?? [])
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchListings() }, [fetchListings])

  const handleAction = async (id: string, action: 'pause' | 'activate' | 'delete') => {
    if (action === 'delete') { setConfirmDelete(id); return }
    setActionLoading(id)
    setActionError('')
    try {
      if (action === 'pause') await ctmApi.pauseListing(id)
      else await ctmApi.activateListing(id)
      await fetchListings()
    } catch (err: unknown) {
      setActionError((err as Error).message ?? 'Action failed')
    } finally {
      setActionLoading(null)
    }
  }

  const handleConfirmedDelete = async () => {
    if (!confirmDelete) return
    const id = confirmDelete
    setActionLoading(id)
    setActionError('')
    try {
      await ctmApi.deleteListing(id)
      await fetchListings()
    } catch (err: unknown) {
      setActionError((err as Error).message ?? 'Failed to cancel listing')
    } finally {
      setActionLoading(null)
      setConfirmDelete(null)
    }
  }

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-text-muted">{listings.length} listing{listings.length !== 1 ? 's' : ''}</p>
        <Link href="/ctm/listings/create" className="bg-primary text-white px-4 py-2 rounded-xl font-semibold text-sm hover:bg-primary/90 transition-colors">
          + New Listing
        </Link>
      </div>

      {actionError && (
        <div className="mb-4 bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700 flex items-start justify-between gap-3">
          <span className="flex-1">{actionError}</span>
          <button onClick={() => setActionError('')} className="text-red-500 hover:text-red-700 flex-shrink-0" aria-label="Dismiss">×</button>
        </div>
      )}

      <ConfirmModal
        isOpen={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={handleConfirmedDelete}
        title="Cancel this listing?"
        description="This cannot be undone. Existing trades created from this listing are not affected."
        confirmLabel="Cancel Listing"
        confirmVariant="danger"
      />

      {loading ? (
        <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="bg-surface shadow-card border border-border rounded-xl h-24 animate-pulse" />)}</div>
      ) : listings.length === 0 ? (
        <EmptyState
          icon={LayoutList}
          title="No CTM listings yet"
          description="Post a listing to start selling community tokens on RupChain."
          action={{ label: 'Create a Listing', onClick: () => window.location.href = '/ctm/listings/create' }}
        />
      ) : (
        <div className="space-y-3">
          {listings.map((l) => (
            <div key={l.id} className="bg-surface shadow-card border border-border rounded-xl p-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <EntityLogo type="token" slug={l.token.symbol} size="xl" logoUrl={l.token.logoUrl} />
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="font-semibold text-text-primary">{l.side === 'sell' ? 'Selling' : 'Buying'} {l.token.name}</p>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${l.status === 'active' ? 'bg-green-100 text-green-700' : l.status === 'paused' ? 'bg-yellow-100 text-yellow-700' : 'bg-surface-alt text-text-secondary'}`}>
                        {l.status.charAt(0).toUpperCase() + l.status.slice(1)}
                      </span>
                    </div>
                    <p className="text-xs text-text-muted">PKR {Number(l.pricePerUnit).toLocaleString()} · {Number(l.availableAmount).toLocaleString()} {l.token.symbol} available</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Link href={`/ctm/listings/${l.id}`} className="text-xs border border-border px-3 py-1.5 rounded-lg text-text-primary hover:bg-surface">View</Link>
                  {l.status === 'active' && (
                    <button onClick={() => handleAction(l.id, 'pause')} disabled={actionLoading === l.id} className="text-xs border border-border px-3 py-1.5 rounded-lg text-text-primary hover:bg-surface disabled:opacity-50">
                      {actionLoading === l.id ? '…' : 'Pause'}
                    </button>
                  )}
                  {l.status === 'paused' && (
                    <button onClick={() => handleAction(l.id, 'activate')} disabled={actionLoading === l.id} className="text-xs border border-green-300 text-green-700 px-3 py-1.5 rounded-lg hover:bg-green-50 disabled:opacity-50">
                      {actionLoading === l.id ? '…' : 'Activate'}
                    </button>
                  )}
                  {(l.status === 'active' || l.status === 'paused') && (
                    <button onClick={() => handleAction(l.id, 'delete')} disabled={actionLoading === l.id} className="text-xs border border-red-200 text-red-600 px-3 py-1.5 rounded-lg hover:bg-red-50 disabled:opacity-50">
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

// ─── Tab: Merchant Analytics ──────────────────────────────────────────────────

function MerchantAnalyticsTab() {
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

  if (loading) return (
    <div className="space-y-4 animate-pulse">
      <div className="bg-surface shadow-card border border-border rounded-xl h-32" />
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => <div key={i} className="bg-surface shadow-card border border-border rounded-xl h-20" />)}
      </div>
    </div>
  )

  if (error || !profile) return (
    <div className="text-center py-16">
      <p className="text-text-muted mb-4">{error || 'No CTM merchant profile found.'}</p>
      <Link href="/ctm/merchant-setup" className="bg-primary text-white px-5 py-2.5 rounded-xl font-semibold text-sm">
        Register as Merchant
      </Link>
    </div>
  )

  const completionRate = profile.totalCtmTrades > 0
    ? Math.round((profile.completedCtmTrades / profile.totalCtmTrades) * 100)
    : 0
  const disputeRate = Math.round(parseFloat(profile.ctmDisputeRate) * 100)
  const avgRating = parseFloat(profile.ctmAvgRating)
  const activeListings = profile.listings.filter((l) => l.status === 'active')
  const tierNext = TIER_NEXT[profile.tier] ?? TIER_NEXT.elite

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-text-muted">@{user?.username}</p>
        <Link href="/ctm/listings/create" className="bg-primary text-white px-4 py-2 rounded-xl font-semibold text-sm hover:bg-primary/90 transition-colors">
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
        <StatCard label="Completed" value={`${profile.completedCtmTrades} (${completionRate}%)`} accent="text-green-700" />
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
          <h2 className="font-semibold text-text-primary">Active CTM Listings ({activeListings.length})</h2>
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
          { label: 'My CTM Trades', href: '/ctm/my-trades', desc: 'View trade history' },
          { label: 'Incoming Bids', href: '/ctm/incoming-bids', desc: 'Accept or reject bids' },
          { label: 'My Bids', href: '/ctm/my-bids', desc: 'Bids you have placed' },
          { label: 'My Requests', href: '/ctm/my-requests', desc: 'Buy requests you posted' },
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

// ─── Tab bar ──────────────────────────────────────────────────────────────────

const TABS: { id: Tab; label: string; Icon: typeof Tag }[] = [
  { id: 'usdt',      label: 'USDT Ads',           Icon: Tag       },
  { id: 'ctm',       label: 'CTM Listings',        Icon: LayoutList },
  { id: 'analytics', label: 'Merchant Analytics',  Icon: BarChart3 },
]

// ─── Inner page (reads search params) ────────────────────────────────────────

function MyAdsInner() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const rawTab = searchParams.get('tab')
  const activeTab: Tab = (rawTab === 'ctm' || rawTab === 'analytics') ? rawTab : 'usdt'

  const setTab = (tab: Tab) => {
    const params = new URLSearchParams(searchParams.toString())
    if (tab === 'usdt') params.delete('tab')
    else params.set('tab', tab)
    router.replace(`/my-ads${params.size ? `?${params}` : ''}`)
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-text-primary">My Ads</h1>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 bg-surface border border-border rounded-xl p-1 mb-6">
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
              activeTab === id
                ? 'bg-primary text-white shadow-sm'
                : 'text-text-muted hover:text-text-primary hover:bg-surface-alt'
            }`}
          >
            <Icon size={15} aria-hidden />
            <span className="hidden sm:inline">{label}</span>
            <span className="sm:hidden">{label.split(' ')[0]}</span>
          </button>
        ))}
      </div>

      {activeTab === 'usdt'      && <UsdtAdsTab />}
      {activeTab === 'ctm'       && <CtmListingsTab />}
      {activeTab === 'analytics' && <MerchantAnalyticsTab />}
    </div>
  )
}

// ─── Page (Suspense boundary for useSearchParams) ─────────────────────────────

export default function MyAdsPage() {
  return (
    <Suspense fallback={<LoadingState message="Loading..." />}>
      <MyAdsInner />
    </Suspense>
  )
}
