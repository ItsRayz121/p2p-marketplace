'use client'
import { useState } from 'react'
import Link from 'next/link'
import { ctmApi } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { ConfirmModal } from '@/components/ui/ConfirmModal'

interface Listing {
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

export default function MyListingsPage() {
  const [listings, setListings] = useState<Listing[]>([])
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const fetchListings = async () => {
    try {
      const res = await ctmApi.getMyListings()
      setListings((res as { listings: Listing[] }).listings ?? [])
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  usePolling(fetchListings, 30000)

  const handleAction = async (id: string, action: 'pause' | 'activate' | 'delete') => {
    if (action === 'delete') {
      setConfirmDelete(id)
      return
    }
    setActionLoading(id)
    setActionError('')
    try {
      if (action === 'pause') await ctmApi.pauseListing(id)
      else if (action === 'activate') await ctmApi.activateListing(id)
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
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-text-primary">My Listings</h1>
        <Link href="/ctm/listings/create" className="bg-primary text-white px-4 py-2.5 rounded-xl font-semibold text-sm hover:bg-primary/90 transition-colors">+ New Listing</Link>
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
        <div className="text-center py-16 text-text-muted">
          <p className="mb-4">No listings yet.</p>
          <Link href="/ctm/listings/create" className="text-primary hover:underline">Create your first listing →</Link>
        </div>
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
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${l.status === 'active' ? 'bg-green-100 text-green-700' : l.status === 'paused' ? 'bg-yellow-100 text-yellow-700' : 'bg-gray-100 text-gray-600'}`}>{l.status}</span>
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
    </div>
  )
}
