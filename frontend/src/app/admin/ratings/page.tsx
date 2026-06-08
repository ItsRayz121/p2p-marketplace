'use client'
import { useState, useCallback, useEffect, useRef } from 'react'
import Link from 'next/link'
import { adminApi } from '@/lib/api'
import { fmtDateTime } from '@/lib/fmt'
import { usePolling } from '@/hooks/usePolling'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Star } from 'lucide-react'
import { ConfirmModal } from '@/components/ui/ConfirmModal'

interface RatingRecord {
  id: string
  tradeId: string
  ratedByUserId: string
  ratedUserId: string
  rating: number
  comment?: string
  tags: string[]
  hidden: boolean
  createdAt: string
  trade?: { id: string; orderRef: string }
  reviewer?: { username: string; email: string } | null
  reviewedUser?: { username: string; email: string } | null
}

type StatusFilter = '' | 'visible' | 'hidden'

interface RatingsResponse {
  ratings: RatingRecord[]
  pagination: { page: number; limit: number; total: number; pages: number }
}

function Stars({ n }: { n: number }) {
  return (
    <span className="text-gold font-medium">
      {'★'.repeat(Math.max(0, Math.min(5, n)))}{'☆'.repeat(Math.max(0, 5 - n))}
    </span>
  )
}

export default function AdminRatingsPage() {
  const [ratings, setRatings] = useState<RatingRecord[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedHidden, setSelectedHidden] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('')
  const [searching, setSearching] = useState(false)

  const limit = 50

  const fetchRatings = useCallback(async () => {
    try {
      const params: Record<string, string | number> = { page, limit }
      if (search) params.search = search
      if (statusFilter) params.status = statusFilter
      const data = await adminApi.getAdminRatings(params) as RatingsResponse
      setRatings(data.ratings ?? [])
      setTotal(data.pagination?.total ?? 0)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load ratings')
    } finally {
      setLoading(false)
      setSearching(false)
    }
  }, [page, search, statusFilter])

  usePolling(fetchRatings, 60_000)

  const firstRun = useRef(true)
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return }
    setSearching(true)
    const t = setTimeout(() => { setSearch(searchInput.trim()); setPage(1) }, 350)
    return () => clearTimeout(t)
  }, [searchInput])

  useEffect(() => {
    fetchRatings()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, statusFilter, page])

  function runSearchNow() {
    setSearch(searchInput.trim())
    setPage(1)
  }

  function promptToggle(id: string, hidden: boolean) {
    setSelectedId(id)
    setSelectedHidden(hidden)
    setActionError(null)
    setConfirmOpen(true)
  }

  async function handleToggle() {
    if (!selectedId) return
    setActionError(null)
    try {
      if (selectedHidden) {
        await adminApi.unhideRating(selectedId)
      } else {
        await adminApi.hideRating(selectedId)
      }
      setConfirmOpen(false)
      fetchRatings()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Action failed')
    }
  }

  const totalPages = Math.ceil(total / limit)

  if (loading) return <LoadingState message="Loading ratings..." />
  if (error && ratings.length === 0) return <ErrorState title={error} onRetry={fetchRatings} />

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Trade Ratings</h1>
        <p className="text-text-muted text-sm mt-0.5">{total} ratings{search || statusFilter ? ' (filtered)' : ' total'}</p>
      </div>

      {/* Search & filters */}
      <div className="bg-surface shadow-card p-4 rounded-xl border border-border flex flex-wrap gap-3 items-center">
        <div className="flex-1 min-w-48">
          <Input
            placeholder="Search by trade ref, reviewer/reviewed username or email..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') runSearchNow() }}
          />
        </div>
        <Button onClick={runSearchNow} loading={searching}>Search</Button>
        <div className="flex flex-wrap gap-1.5">
          {([['', 'All'], ['visible', 'Visible'], ['hidden', 'Hidden']] as Array<[StatusFilter, string]>).map(([key, label]) => (
            <button
              key={key || 'all'}
              onClick={() => { setStatusFilter(key); setPage(1) }}
              className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${statusFilter === key ? 'border-primary bg-primary/10 text-primary' : 'border-border text-text-secondary hover:bg-surface-alt'}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {ratings.length === 0 ? (
        <EmptyState icon={Star} title={search || statusFilter ? 'No matching ratings' : 'No ratings yet'} description={search || statusFilter ? 'Try a different search term or filter.' : 'Ratings will appear here after trades are completed and reviewed.'} />
      ) : (
        <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface border-b border-border">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Trade</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Reviewer</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Reviewed</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Stars</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Comment</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Date</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Status</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {ratings.map((r) => (
                  <tr key={r.id} className={`hover:bg-surface/50 transition-colors ${r.hidden ? 'opacity-50' : ''}`}>
                    <td className="px-4 py-3">
                      <Link href={`/admin/trades/${r.trade?.id ?? r.tradeId}`} className="font-mono text-xs text-primary hover:underline">
                        #{r.trade?.orderRef?.slice(0, 12) ?? r.tradeId.slice(0, 8)}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-text-primary">{r.reviewer?.username ?? r.ratedByUserId.slice(0, 8)}</p>
                      <p className="text-xs text-text-muted">{r.reviewer?.email}</p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-text-primary">{r.reviewedUser?.username ?? r.ratedUserId.slice(0, 8)}</p>
                      <p className="text-xs text-text-muted">{r.reviewedUser?.email}</p>
                    </td>
                    <td className="px-4 py-3">
                      <Stars n={r.rating} />
                    </td>
                    <td className="px-4 py-3 text-text-secondary max-w-xs">
                      <p className="truncate">{r.comment || '—'}</p>
                      {(r.tags ?? []).length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {(r.tags ?? []).map((t) => (
                            <span key={t} className="text-[10px] bg-surface px-1.5 py-0.5 rounded-full text-text-muted">{t}</span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-text-secondary whitespace-nowrap">{fmtDateTime(r.createdAt)}</td>
                    <td className="px-4 py-3">
                      {r.hidden ? (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-danger/10 text-danger font-medium">Hidden</span>
                      ) : (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-success/10 text-success font-medium">Visible</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        size="sm"
                        variant={r.hidden ? 'secondary' : 'ghost'}
                        onClick={() => promptToggle(r.id, r.hidden)}
                      >
                        {r.hidden ? 'Unhide' : 'Hide'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-border">
              <p className="text-text-muted text-sm">Page {page} of {totalPages} ({total} total)</p>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Prev</Button>
                <Button size="sm" variant="secondary" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next</Button>
              </div>
            </div>
          )}
        </div>
      )}

      {actionError && (
        <div className="px-3 py-2 bg-danger/10 border border-danger/20 rounded-lg text-danger text-sm">
          {actionError}
        </div>
      )}

      <ConfirmModal
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={handleToggle}
        title={selectedHidden ? 'Unhide Rating' : 'Hide Rating'}
        description={
          selectedHidden
            ? 'Make this rating visible again to users?'
            : 'Hide this rating? It will no longer be visible to users. You can unhide it later.'
        }
        confirmLabel={selectedHidden ? 'Unhide' : 'Hide'}
        confirmVariant={selectedHidden ? 'primary' : 'danger'}
      />
    </div>
  )
}
