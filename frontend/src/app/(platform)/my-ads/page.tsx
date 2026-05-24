'use client'
import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { adsApi } from '@/lib/api'
import type { Ad } from '@/lib/api'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { ConfirmModal } from '@/components/ui/ConfirmModal'
import { Spinner } from '@/components/ui/Spinner'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { PK_MOBILE_METHODS } from '@/lib/pkPaymentMethods'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function statusVariant(s: string): 'success' | 'warning' | 'danger' | 'default' {
  if (s === 'active') return 'success'
  if (s === 'paused') return 'warning'
  if (s === 'inactive') return 'danger'
  return 'default'
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function MyAdsPage() {
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
      let updated: Ad
      if (ad.status === 'active') {
        updated = await adsApi.pauseAd(ad.id)
      } else {
        updated = await adsApi.activateAd(ad.id)
      }
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
    <div className="max-w-4xl mx-auto px-4 py-6 pb-24 lg:pb-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">My Ads</h1>
          <p className="text-sm text-text-muted">{ads.length} ad{ads.length !== 1 ? 's' : ''}</p>
        </div>
        <Link href="/create-ad">
          <Button size="sm">+ Create Ad</Button>
        </Link>
      </div>

      {ads.length === 0 ? (
        <EmptyState
          title="No ads yet"
          description="Create your first buy or sell ad to start trading on PakSwap."
          action={{ label: 'Create Your First Ad', onClick: () => router.push('/create-ad') }}
        />
      ) : (
        <>
          {/* Desktop Table */}
          <div className="hidden md:block bg-white border border-border rounded-xl overflow-hidden">
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
                      <Badge variant={ad.side === 'buy' ? 'success' : 'danger'} size="sm">
                        {ad.side.toUpperCase()}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-sm font-semibold text-text-primary">{ad.coin}</td>
                    <td className="px-4 py-3 text-sm text-text-primary">{parseFloat(ad.price).toLocaleString()}</td>
                    <td className="px-4 py-3 text-sm text-text-muted">
                      {parseFloat(ad.minOrder).toLocaleString()} – {parseFloat(ad.maxOrder).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-sm text-text-primary">—</td>
                    <td className="px-4 py-3">
                      <Badge variant={statusVariant(ad.status)} size="sm">{ad.status}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => handleToggle(ad)}
                          disabled={toggling === ad.id}
                        >
                          {toggling === ad.id ? <Spinner size="sm" /> : ad.status === 'active' ? 'Pause' : 'Activate'}
                        </Button>
                        <Link href={`/create-ad?edit=${ad.id}`}>
                          <Button size="sm" variant="secondary">Edit</Button>
                        </Link>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setDeleteTarget(ad)}
                          className="text-danger hover:bg-danger/10"
                        >
                          Delete
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile Cards */}
          <div className="md:hidden space-y-3">
            {ads.map((ad) => (
              <div key={ad.id} className="bg-white border border-border rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Badge variant={ad.side === 'buy' ? 'success' : 'danger'} size="sm">
                      {ad.side.toUpperCase()}
                    </Badge>
                    <span className="text-sm font-bold text-text-primary">{ad.coin}</span>
                  </div>
                  <Badge variant={statusVariant(ad.status)} size="sm">{ad.status}</Badge>
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
                  <Button
                    size="sm"
                    variant="secondary"
                    className="flex-1"
                    onClick={() => handleToggle(ad)}
                    disabled={toggling === ad.id}
                  >
                    {toggling === ad.id ? <Spinner size="sm" /> : ad.status === 'active' ? 'Pause' : 'Activate'}
                  </Button>
                  <Link href={`/create-ad?edit=${ad.id}`} className="flex-1">
                    <Button size="sm" variant="secondary" className="w-full">Edit</Button>
                  </Link>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="text-danger hover:bg-danger/10"
                    onClick={() => setDeleteTarget(ad)}
                  >
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
    </div>
  )
}
