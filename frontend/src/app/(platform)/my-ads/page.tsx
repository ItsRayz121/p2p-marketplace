'use client'
import { useState, useEffect, useCallback, Suspense } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { adsApi, ctmApi, dashboardApi } from '@/lib/api'
import type { TradingAnalytics } from '@/lib/api'
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
  tradeWindowMins?: number
  terms?: string | null
  createdAt: string
  token: { id: string; name: string; symbol: string; logoUrl?: string }
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

function StatCard({ label, value, sub, unit, accent, unitInLabel }: { label: string; value: string | number; sub?: string; unit?: string; accent?: string; unitInLabel?: boolean }) {
  return (
    // select-none: stops a mobile long-press from highlighting the number and
    // triggering the OS "tap to search" popover over a compact value like "27.1K".
    <div className="bg-surface shadow-card border border-border rounded-xl p-3 sm:p-4 min-w-0 select-none">
      {/* Label always stays on one line — truncates rather than wrapping to two
          rows (keeps e.g. "Total Spent" tidy in the tight 3-col grid). When
          unitInLabel is set, the currency (PKR / USDT) rides up here next to the
          label so the amount below gets the card's FULL width and can show in
          full instead of being truncated to "18....". */}
      <p className="text-[11px] sm:text-xs text-text-muted truncate">
        {label}
        {unitInLabel && unit && <span className="ml-1 font-semibold">{unit}</span>}
      </p>
      <p className="mt-1 flex items-baseline gap-1 min-w-0">
        {unit && !unitInLabel && <span className="text-[10px] sm:text-xs font-semibold text-text-muted flex-shrink-0">{unit}</span>}
        <span className={`min-w-0 text-sm sm:text-2xl font-bold tabular-nums leading-tight truncate ${accent ?? 'text-text-primary'}`}>{value}</span>
      </p>
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
                  {(() => {
                    // Prefer resolved {id,label} from the API; fall back to raw
                    // ids only if the backend didn't resolve them.
                    const methods = ad.resolvedPaymentMethods?.length
                      ? ad.resolvedPaymentMethods
                      : (ad.paymentMethods ?? []).map((pm) => ({ id: pm, type: 'other', label: pm }))
                    if (methods.length === 0) return null
                    return (
                      <div className="col-span-2">
                        <p className="text-text-muted text-xs mb-1">Payment Methods</p>
                        <div className="flex flex-wrap gap-1">
                          {methods.map((pm) => (
                            <span key={pm.id} className="inline-flex items-center gap-1 text-xs bg-surface border border-border px-2 py-0.5 rounded-full text-text-muted">
                              <EntityLogo type={PK_MOBILE_METHODS.includes(pm.label) ? 'payment_method' : 'bank'} slug={pm.label} size="xs" className="flex-shrink-0" />
                              {pm.label}
                            </span>
                          ))}
                        </div>
                      </div>
                    )
                  })()}
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

// ─── Edit CTM listing modal ───────────────────────────────────────────────────
// The backend only lets a merchant change price, order limits, trade window and
// terms (token / side / delivery are fixed once posted), so the editor is scoped
// to exactly those fields. Payment methods are managed from the create flow.

function EditCtmListingModal({ listing, onClose, onSaved }: { listing: CtmListing; onClose: () => void; onSaved: () => void }) {
  const [price, setPrice] = useState(listing.pricePerUnit)
  const [minTokens, setMinTokens] = useState(listing.minOrderTokens)
  const [maxTokens, setMaxTokens] = useState(listing.maxOrderTokens)
  const [tradeWindow, setTradeWindow] = useState(listing.tradeWindowMins ?? 45)
  const [terms, setTerms] = useState(listing.terms ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const fieldCls = 'w-full border border-border rounded-xl px-3 py-2.5 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-primary/30'
  const labelCls = 'block text-sm font-medium text-text-primary mb-1.5'

  const handleSave = async () => {
    setError('')
    const p = parseFloat(price), mn = parseFloat(minTokens), mx = parseFloat(maxTokens)
    if (!(p > 0)) { setError('Enter a valid price'); return }
    if (!(mn > 0) || !(mx > 0)) { setError('Enter valid order limits'); return }
    if (mx < mn) { setError('Maximum tokens must be ≥ minimum'); return }
    setSaving(true)
    try {
      await ctmApi.updateListing(listing.id, {
        pricePerUnit: p,
        minOrderTokens: mn,
        maxOrderTokens: mx,
        tradeWindowMins: tradeWindow,
        terms: terms.trim(),
      })
      onSaved()
    } catch (err: unknown) {
      setError((err as Error).message ?? 'Failed to update listing')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40" onClick={onClose}>
      <div className="bg-surface border border-border rounded-2xl w-full max-w-md max-h-[90vh] overflow-y-auto p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3">
          <EntityLogo type="token" slug={listing.token.symbol} size="md" logoUrl={listing.token.logoUrl} />
          <div>
            <h2 className="font-bold text-text-primary">Edit listing</h2>
            <p className="text-xs text-text-muted">{listing.side === 'sell' ? 'Selling' : 'Buying'} {listing.token.name}</p>
          </div>
        </div>

        {error && <div className="bg-red-500/10 border border-red-500/30 text-red-700 dark:text-red-300 rounded-xl p-3 text-sm">{error}</div>}

        <div>
          <label className={labelCls}>Price per token (PKR)</label>
          <input type="number" min="0" step="0.000001" value={price} onChange={(e) => setPrice(e.target.value)} className={fieldCls} />
          <p className="mt-1 text-xs text-text-muted">Price can’t be changed while there are active trades on this listing.</p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Min tokens / order</label>
            <input type="number" min="0" step="0.000001" value={minTokens} onChange={(e) => setMinTokens(e.target.value)} className={fieldCls} />
          </div>
          <div>
            <label className={labelCls}>Max tokens / order</label>
            <input type="number" min="0" step="0.000001" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} className={fieldCls} />
          </div>
        </div>

        <div>
          <label className={labelCls}>Trade window (minutes)</label>
          <select value={tradeWindow} onChange={(e) => setTradeWindow(parseInt(e.target.value))} className={fieldCls}>
            {[15, 30, 45, 60, 90, 120].map((m) => <option key={m} value={m}>{m} minutes</option>)}
          </select>
        </div>

        <div>
          <label className={labelCls}>Terms (optional)</label>
          <textarea rows={3} value={terms} onChange={(e) => setTerms(e.target.value)} maxLength={2000} className={`${fieldCls} resize-none`} placeholder="Any additional terms for this listing" />
        </div>

        <div className="flex gap-2 pt-1">
          <Button variant="secondary" className="flex-1" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button className="flex-1" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</Button>
        </div>
      </div>
    </div>
  )
}

// ─── Tab: CTM Listings ────────────────────────────────────────────────────────

function CtmListingsTab() {
  const [listings, setListings] = useState<CtmListing[]>([])
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [editTarget, setEditTarget] = useState<CtmListing | null>(null)

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
        <div className="mb-4 bg-red-500/10 border border-red-500/30 rounded-xl p-3 text-sm text-red-700 dark:text-red-300 flex items-start justify-between gap-3">
          <span className="flex-1">{actionError}</span>
          <button onClick={() => setActionError('')} className="text-red-500 hover:text-red-700 dark:hover:text-red-300 flex-shrink-0" aria-label="Dismiss">×</button>
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

      {editTarget && (
        <EditCtmListingModal
          listing={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={() => { setEditTarget(null); fetchListings() }}
        />
      )}

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
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${l.status === 'active' ? 'bg-green-500/15 text-green-700 dark:text-green-300' : l.status === 'paused' ? 'bg-yellow-500/15 text-yellow-700 dark:text-yellow-300' : 'bg-surface-alt text-text-secondary'}`}>
                        {l.status.charAt(0).toUpperCase() + l.status.slice(1)}
                      </span>
                    </div>
                    <p className="text-xs text-text-muted">PKR {Number(l.pricePerUnit).toLocaleString()} · {Number(l.availableAmount).toLocaleString()} {l.token.symbol} available</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Link href={`/ctm/listings/${l.id}`} className="text-xs border border-border px-3 py-1.5 rounded-lg text-text-primary hover:bg-surface">View</Link>
                  {(l.status === 'active' || l.status === 'paused') && (
                    <button onClick={() => setEditTarget(l)} className="text-xs border border-border px-3 py-1.5 rounded-lg text-text-primary hover:bg-surface">
                      Edit
                    </button>
                  )}
                  {l.status === 'active' && (
                    <button onClick={() => handleAction(l.id, 'pause')} disabled={actionLoading === l.id} className="text-xs border border-border px-3 py-1.5 rounded-lg text-text-primary hover:bg-surface disabled:opacity-50">
                      {actionLoading === l.id ? '…' : 'Pause'}
                    </button>
                  )}
                  {l.status === 'paused' && (
                    <button onClick={() => handleAction(l.id, 'activate')} disabled={actionLoading === l.id} className="text-xs border border-green-500/40 text-green-700 dark:text-green-300 px-3 py-1.5 rounded-lg hover:bg-green-500/10 disabled:opacity-50">
                      {actionLoading === l.id ? '…' : 'Activate'}
                    </button>
                  )}
                  {(l.status === 'active' || l.status === 'paused') && (
                    <button onClick={() => handleAction(l.id, 'delete')} disabled={actionLoading === l.id} className="text-xs border border-red-500/30 text-red-600 dark:text-red-400 px-3 py-1.5 rounded-lg hover:bg-red-500/10 disabled:opacity-50">
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

// ─── Tab: Trading Analytics ───────────────────────────────────────────────────
// Combined trading history & stats across all three marketplaces: USDT P2P,
// Community Tokens (CTM), and Crypto Gas Fees.

function TradingAnalyticsTab() {
  const [data, setData] = useState<TradingAnalytics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    dashboardApi.getTradingAnalytics()
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load analytics'))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return (
    <div className="space-y-4 animate-pulse">
      <div className="bg-surface shadow-card border border-border rounded-xl h-24" />
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => <div key={i} className="bg-surface shadow-card border border-border rounded-xl h-20" />)}
      </div>
    </div>
  )

  if (error || !data) return (
    <div className="text-center py-16">
      <p className="text-text-muted">{error || 'Failed to load analytics.'}</p>
    </div>
  )

  // Compact form (e.g. 18,425 → "18.4K", 2,750,000 → "2.8M") for the tight
  // 3-column Volume cards where the full number gets truncated mid-digits.
  const fmtCompact = (v: string) => {
    const n = Number(v)
    if (!isFinite(n)) return v
    const fmt = (x: number, suffix: string) =>
      `${x.toFixed(1).replace(/\.0$/, '')}${suffix}`
    if (n >= 1_000_000) return fmt(n / 1_000_000, 'M')
    if (n >= 10_000) return fmt(n / 1_000, 'K')
    return n.toLocaleString()
  }
  const combinedRate = data.combined.completionRate != null ? Math.round(data.combined.completionRate * 100) : null

  return (
    <div className="space-y-6">
      {/* Combined summary */}
      <div className="bg-gradient-to-r from-primary/5 to-pink-500/5 border border-primary/20 rounded-xl p-5">
        <h2 className="font-semibold text-text-primary mb-3">All Marketplaces — Combined</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <StatCard label="Total Trades" value={data.combined.totalTrades} />
          <StatCard label="Completed" value={combinedRate != null ? `${data.combined.completedTrades} (${combinedRate}%)` : data.combined.completedTrades} accent="text-green-700 dark:text-green-300" />
          <StatCard label="Total Volume" value={fmtCompact(data.combined.totalVolumePkr)} unit="PKR" unitInLabel />
          <StatCard label="Gas Spend" value={data.gas.spentUsd} unit="USDT" />
        </div>
      </div>

      {/* USDT marketplace */}
      <div className="bg-surface shadow-card border border-border rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-text-primary">USDT Marketplace</h2>
          <Link href="/marketplace" className="text-sm text-primary hover:underline">Open →</Link>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <StatCard label="Trades" value={data.usdt.totalTrades} />
          <StatCard label="Completed" value={data.usdt.completedTrades} accent="text-green-700 dark:text-green-300" />
          <StatCard label="Volume" value={fmtCompact(data.usdt.volumePkr)} unit="PKR" unitInLabel />
        </div>
      </div>

      {/* Community Tokens */}
      <div className="bg-surface shadow-card border border-border rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-text-primary">Community Tokens (CTM)</h2>
          <Link href="/ctm" className="text-sm text-primary hover:underline">Open →</Link>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <StatCard label="Trades" value={data.ctm.totalTrades} />
          <StatCard label="Completed" value={data.ctm.completedTrades} accent="text-green-700 dark:text-green-300" />
          <StatCard label="Volume" value={fmtCompact(data.ctm.volumePkr)} unit="PKR" unitInLabel />
        </div>
        {data.ctm.isMerchant && (
          <div className="flex items-center gap-3 mt-4 text-xs text-text-muted">
            {data.ctm.tier && <span className="px-2 py-0.5 rounded-full bg-surface-alt font-medium">{data.ctm.tier} tier</span>}
            {data.ctm.avgRating && Number(data.ctm.avgRating) > 0 && <span>{data.ctm.avgRating} ★ avg rating</span>}
          </div>
        )}
      </div>

      {/* Gas fees */}
      <div className="bg-surface shadow-card border border-border rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-text-primary">Crypto Gas Fees</h2>
          <Link href="/gas" className="text-sm text-primary hover:underline">Open →</Link>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <StatCard label="Orders" value={data.gas.totalOrders} />
          <StatCard label="Delivered" value={data.gas.deliveredOrders} accent="text-green-700 dark:text-green-300" />
          <StatCard label="Total Spent" value={data.gas.spentUsd} unit="USDT" />
        </div>
      </div>

      {/* Quick links */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {[
          { label: 'My CTM Trades', href: '/ctm/my-trades', desc: 'View trade history' },
          { label: 'My USDT Orders', href: '/orders', desc: 'P2P order history' },
          { label: 'Browse Market', href: '/marketplace', desc: 'See USDT listings' },
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
  { id: 'analytics', label: 'Trading Analytics',  Icon: BarChart3 },
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
      {activeTab === 'analytics' && <TradingAnalyticsTab />}
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
