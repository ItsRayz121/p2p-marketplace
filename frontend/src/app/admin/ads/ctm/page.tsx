'use client'
import { useState, useCallback, useEffect, useRef } from 'react'
import Link from 'next/link'
import { ctmApi } from '@/lib/api'
import { fmtDate } from '@/lib/fmt'
import { usePolling } from '@/hooks/usePolling'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Megaphone, ExternalLink } from 'lucide-react'

interface CtmToken {
  id: string
  symbol: string
  name: string
}

interface CtmListingRow {
  id: string
  side: 'buy' | 'sell'
  pricePerUnit: string
  availableAmount: string
  totalAmount: string
  minOrderTokens: string
  maxOrderTokens: string
  status: string
  createdAt: string
  token: { id: string; symbol: string; name: string }
  merchantProfile: { user: { id: string; username: string } }
  resolvedPaymentMethods?: Array<{ label: string }>
}

interface ListingsResponse {
  listings: CtmListingRow[]
  total: number
  page: number
  limit: number
  totalPages: number
}

const statusVariant = (s: string) => {
  if (s === 'active') return 'success'
  if (s === 'paused') return 'warning'
  if (s === 'expired' || s === 'cancelled') return 'danger'
  return 'default'
}

export default function AdminCtmAdsPage() {
  const [tokens, setTokens] = useState<CtmToken[]>([])
  const [tokenId, setTokenId] = useState<string>('all')
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [statusFilter, setStatusFilter] = useState('active')
  const [page, setPage] = useState(1)

  const [listings, setListings] = useState<CtmListingRow[]>([])
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const limit = 20

  useEffect(() => {
    ctmApi.adminListTokens({ limit: 200 })
      .then((data: any) => setTokens(data.tokens ?? []))
      .catch(() => {})
  }, [])

  const fetchListings = useCallback(async () => {
    try {
      const params: Record<string, string | number> = { side, page, limit }
      if (statusFilter !== 'all') params.status = statusFilter
      if (tokenId !== 'all') params.tokenId = tokenId
      const data = await ctmApi.adminGetListings(params) as unknown as ListingsResponse
      setListings(data.listings ?? [])
      setTotal(data.total ?? 0)
      setTotalPages(data.totalPages ?? 1)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load listings')
    } finally {
      setLoading(false)
    }
  }, [side, statusFilter, tokenId, page])

  // usePolling already fetches once immediately on mount; this effect only
  // needs to force an extra fetch when the filters change AFTER that first
  // mount (skipping the first run avoids firing two concurrent requests).
  const mountedRef = useRef(false)
  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return }
    setLoading(true)
    fetchListings()
  }, [fetchListings])

  usePolling(fetchListings, 30_000)

  if (loading) return <LoadingState message="Loading CTM listings..." />
  if (error && listings.length === 0) return <ErrorState title={error} onRetry={fetchListings} />

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">CTM Marketplace</h1>
        <p className="text-text-muted text-sm mt-0.5">{total.toLocaleString()} {side} listings</p>
      </div>

      <div className="bg-surface shadow-card p-4 rounded-xl border border-border flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-border overflow-hidden">
          {(['buy', 'sell'] as const).map((s) => (
            <button
              key={s}
              onClick={() => { setSide(s); setPage(1) }}
              className={`px-4 py-1.5 text-sm font-medium capitalize transition-colors ${
                side === s ? (s === 'buy' ? 'bg-success text-white' : 'bg-danger text-white') : 'bg-surface text-text-muted hover:text-text-secondary'
              }`}
            >
              {s} tokens
            </button>
          ))}
        </div>
        <select
          value={tokenId}
          onChange={(e) => { setTokenId(e.target.value); setPage(1) }}
          className="px-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-surface focus:outline-none focus:ring-2 focus:ring-primary"
        >
          <option value="all">All Tokens</option>
          {tokens.map((t) => (
            <option key={t.id} value={t.id}>{t.symbol} — {t.name}</option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(1) }}
          className="px-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-surface focus:outline-none focus:ring-2 focus:ring-primary"
        >
          <option value="active">Active</option>
          <option value="paused">Paused</option>
          <option value="completed">Completed</option>
          <option value="expired">Expired</option>
          <option value="cancelled">Cancelled</option>
          <option value="all">All Statuses</option>
        </select>
      </div>

      {listings.length === 0 ? (
        <EmptyState icon={Megaphone} title="No listings found" description="No listings match the current filters." />
      ) : (
        <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm stack-sm">
              <thead className="bg-surface border-b border-border">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Token</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Merchant</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Price/Unit</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Available</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Order Limits (PKR)</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Payment Methods</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Status</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {listings.map((l) => (
                  <tr key={l.id} className="hover:bg-surface/50 transition-colors">
                    <td className="px-4 py-3 font-medium text-text-primary" data-label="Token">{l.token.symbol}</td>
                    <td className="px-4 py-3" data-label="Merchant">
                      <Link href={`/admin/users/${l.merchantProfile.user.id}`} className="text-primary hover:underline inline-flex items-center gap-1">
                        {l.merchantProfile.user.username}
                        <ExternalLink size={11} className="opacity-60" />
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-text-primary" data-label="Price/Unit">{Number(l.pricePerUnit).toLocaleString()}</td>
                    <td className="px-4 py-3 text-text-primary" data-label="Available">{Number(l.availableAmount).toLocaleString()} / {Number(l.totalAmount).toLocaleString()} {l.token.symbol}</td>
                    <td className="px-4 py-3 text-text-secondary" data-label="Order Limits">{(Number(l.minOrderTokens) * Number(l.pricePerUnit)).toLocaleString()} – {(Number(l.maxOrderTokens) * Number(l.pricePerUnit)).toLocaleString()}</td>
                    <td className="px-4 py-3 text-text-secondary" data-label="Payment Methods">{l.resolvedPaymentMethods?.map((m) => m.label).join(', ') || '—'}</td>
                    <td className="px-4 py-3" data-label="Status">
                      <Badge variant={statusVariant(l.status)} size="sm">{l.status}</Badge>
                    </td>
                    <td className="px-4 py-3 text-text-secondary" data-label="Created">{fmtDate(l.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-border">
              <p className="text-text-muted text-sm">Page {page} of {totalPages}</p>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Prev</Button>
                <Button size="sm" variant="secondary" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
