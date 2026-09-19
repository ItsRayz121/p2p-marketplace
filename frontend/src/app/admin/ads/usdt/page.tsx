'use client'
import { useState, useCallback } from 'react'
import Link from 'next/link'
import { adminApi } from '@/lib/api'
import { fmtDate } from '@/lib/fmt'
import { usePolling } from '@/hooks/usePolling'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Megaphone, ExternalLink } from 'lucide-react'

interface AdSeller {
  id: string
  username: string
  fullName?: string | null
}

interface AdRow {
  id: string
  side: 'buy' | 'sell'
  coin: string
  network: string
  priceType: string
  price: string
  availableAmount: string
  minOrder: string
  maxOrder: string
  paymentMethods: string[]
  status: string
  createdAt: string
  seller: AdSeller
}

interface AdsResponse {
  ads: AdRow[]
  total: number
  page: number
  limit: number
  totalPages: number
}

const statusVariant = (s: string) => {
  if (s === 'active') return 'success'
  if (s === 'paused') return 'warning'
  return 'default'
}

export default function AdminUsdtAdsPage() {
  const [ads, setAds] = useState<AdRow[]>([])
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [statusFilter, setStatusFilter] = useState('active')
  const [page, setPage] = useState(1)

  const limit = 20

  const fetchAds = useCallback(async () => {
    try {
      const params: Record<string, string | number> = { side, status: statusFilter, page, limit }
      const data = await adminApi.getAds(params) as AdsResponse
      setAds(data.ads ?? [])
      setTotal(data.total ?? 0)
      setTotalPages(data.totalPages ?? 1)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load ads')
    } finally {
      setLoading(false)
    }
  }, [side, statusFilter, page])

  usePolling(fetchAds, 30_000, true, [side, statusFilter, page])

  if (loading) return <LoadingState message="Loading marketplace ads..." />
  if (error && ads.length === 0) return <ErrorState title={error} onRetry={fetchAds} />

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">USDT Marketplace</h1>
        <p className="text-text-muted text-sm mt-0.5">{total.toLocaleString()} {side} ads</p>
      </div>

      <div className="bg-surface shadow-card p-4 rounded-xl border border-border flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-border overflow-hidden">
          {(['buy', 'sell'] as const).map((s) => (
            <button
              key={s}
              onClick={() => { setSide(s); setPage(1); setLoading(true) }}
              className={`px-4 py-1.5 text-sm font-medium capitalize transition-colors ${
                side === s ? (s === 'buy' ? 'bg-success text-white' : 'bg-danger text-white') : 'bg-surface text-text-muted hover:text-text-secondary'
              }`}
            >
              {s} USDT
            </button>
          ))}
        </div>
        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(1); setLoading(true) }}
          className="px-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-surface focus:outline-none focus:ring-2 focus:ring-primary"
        >
          <option value="active">Active</option>
          <option value="paused">Paused</option>
          <option value="completed">Completed</option>
          <option value="all">All Statuses</option>
        </select>
      </div>

      {ads.length === 0 ? (
        <EmptyState icon={Megaphone} title="No ads found" description="No listings match the current filters." />
      ) : (
        <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm stack-sm">
              <thead className="bg-surface border-b border-border">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Seller</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Price (PKR)</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Network</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Available</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Order Limits</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Payment Methods</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Status</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {ads.map((ad) => (
                  <tr key={ad.id} className="hover:bg-surface/50 transition-colors">
                    <td className="px-4 py-3" data-label="Seller">
                      <Link href={`/admin/users/${ad.seller.id}`} className="text-primary hover:underline inline-flex items-center gap-1">
                        {ad.seller.username}
                        <ExternalLink size={11} className="opacity-60" />
                      </Link>
                    </td>
                    <td className="px-4 py-3 font-medium text-text-primary" data-label="Price">
                      {Number(ad.price).toLocaleString()} <span className="text-xs text-text-muted">({ad.priceType})</span>
                    </td>
                    <td className="px-4 py-3 text-text-secondary" data-label="Network">{ad.network}</td>
                    <td className="px-4 py-3 text-text-primary" data-label="Available">{Number(ad.availableAmount).toLocaleString()} USDT</td>
                    <td className="px-4 py-3 text-text-secondary" data-label="Order Limits">{Number(ad.minOrder).toLocaleString()} – {Number(ad.maxOrder).toLocaleString()}</td>
                    <td className="px-4 py-3 text-text-secondary" data-label="Payment Methods">{ad.paymentMethods.join(', ') || '—'}</td>
                    <td className="px-4 py-3" data-label="Status">
                      <Badge variant={statusVariant(ad.status)} size="sm">{ad.status}</Badge>
                    </td>
                    <td className="px-4 py-3 text-text-secondary" data-label="Created">{fmtDate(ad.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-border">
              <p className="text-text-muted text-sm">Page {page} of {totalPages}</p>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => { setPage((p) => p - 1); setLoading(true) }}>Prev</Button>
                <Button size="sm" variant="secondary" disabled={page >= totalPages} onClick={() => { setPage((p) => p + 1); setLoading(true) }}>Next</Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
