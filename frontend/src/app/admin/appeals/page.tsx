'use client'
import { useState, useCallback, useEffect, useRef } from 'react'
import { adminApi } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { MessageSquareWarning } from 'lucide-react'
import { AppealCard, type AppealItem } from '@/components/admin/AppealCard'

type StatusFilter = '' | 'pending' | 'more_info_requested' | 'approved' | 'rejected'

const FILTERS: Array<{ key: StatusFilter; label: string }> = [
  { key: '', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'more_info_requested', label: 'Info Requested' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
]

export default function AppealsPage() {
  const [appeals, setAppeals] = useState<AppealItem[]>([])
  const [pendingCount, setPendingCount] = useState(0)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<StatusFilter>('pending')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [searching, setSearching] = useState(false)
  const limit = 20

  const fetchAppeals = useCallback(async () => {
    try {
      const params: Record<string, string | number> = { page, limit }
      if (status) params.status = status
      if (search) params.search = search
      const data = await adminApi.getAppeals(params)
      setAppeals(data.appeals ?? [])
      setPendingCount(data.pendingCount ?? 0)
      setTotal(data.pagination?.total ?? 0)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load appeals')
    } finally {
      setLoading(false)
      setSearching(false)
    }
  }, [page, status, search])

  usePolling(fetchAppeals, 60_000)

  const firstRun = useRef(true)
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return }
    setSearching(true)
    const t = setTimeout(() => { setSearch(searchInput.trim()); setPage(1) }, 350)
    return () => clearTimeout(t)
  }, [searchInput])

  useEffect(() => { fetchAppeals() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [status, search, page])

  const totalPages = Math.ceil(total / limit)

  if (loading) return <LoadingState message="Loading appeals..." />
  if (error && appeals.length === 0) return <ErrorState title={error} onRetry={fetchAppeals} />

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Appeals</h1>
        <p className="text-text-muted text-sm mt-0.5">{pendingCount} awaiting review · {total} total</p>
      </div>

      <div className="bg-surface shadow-card p-4 rounded-xl border border-border flex flex-wrap gap-3 items-center">
        <div className="flex-1 min-w-48">
          <Input
            placeholder="Search by username or email..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { setSearch(searchInput.trim()); setPage(1) } }}
          />
        </div>
        <Button onClick={() => { setSearch(searchInput.trim()); setPage(1) }} loading={searching}>Search</Button>
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.key || 'all'}
              onClick={() => { setStatus(f.key); setPage(1) }}
              className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${status === f.key ? 'border-primary bg-primary/10 text-primary' : 'border-border text-text-secondary hover:bg-surface-alt'}`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {appeals.length === 0 ? (
        <EmptyState icon={MessageSquareWarning} title="No appeals" description={search || status ? 'No appeals match these filters.' : 'No appeals have been submitted.'} />
      ) : (
        <div className="space-y-3">
          {appeals.map((a) => (
            <AppealCard key={a.id} appeal={a} onChange={fetchAppeals} />
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-text-muted text-sm">Page {page} of {totalPages}</p>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Prev</Button>
            <Button size="sm" variant="secondary" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </div>
      )}
    </div>
  )
}
