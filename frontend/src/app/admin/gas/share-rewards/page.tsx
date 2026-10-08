'use client'
import { useState, useEffect, useCallback } from 'react'
import { shareApi } from '@/lib/api'
import type { ShareRewardAdminRow } from '@/lib/api'
import { toast } from '@/lib/toast'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { ExternalLink } from 'lucide-react'
import { PromotionsNav } from '@/components/admin/promotions/PromotionsNav'

const FILTERS = ['submitted', 'approved', 'used', 'rejected', 'all'] as const

export default function AdminShareRewardsPage() {
  const [status, setStatus] = useState<(typeof FILTERS)[number]>('submitted')
  const [rows, setRows] = useState<ShareRewardAdminRow[] | null>(null)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError('')
    try { setRows(await shareApi.adminList(status)) }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed to load') }
  }, [status])

  useEffect(() => { setRows(null); void load() }, [load])

  async function approve(id: string) {
    setBusyId(id)
    try {
      const r = await shareApi.adminApprove(id)
      toast.success(`Approved. Drew a ${r.discountPct}% discount.`)
      await load()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Approve failed') }
    finally { setBusyId(null) }
  }

  async function reject(id: string) {
    const reason = window.prompt('Reason shown to the user (optional):', 'The post is missing the required details or is not public.')
    if (reason === null) return
    setBusyId(id)
    try {
      await shareApi.adminReject(id, reason)
      toast.success('Rejected')
      await load()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Reject failed') }
    finally { setBusyId(null) }
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-4">
      <PromotionsNav active="rewards" current="/admin/gas/share-rewards" />
      <div>
        <h1 className="text-xl font-bold text-text-primary">Share &amp; Earn posts</h1>
        <p className="text-sm text-text-muted mt-1">
          Open each X post and check it is public and about the order. Approving draws a random fee discount (default 20–50%, high end rare) for the user&apos;s next gas order.
          Limits and the test-account list are in Config → Share &amp; Earn.
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setStatus(f)}
            className={`rounded-full px-3 py-1 text-xs font-medium capitalize ${status === f ? 'bg-primary text-white' : 'bg-surface-alt text-text-secondary hover:text-text-primary'}`}
          >
            {f}
          </button>
        ))}
      </div>

      {error && <ErrorState description={error} onRetry={() => void load()} />}
      {!error && rows === null && <LoadingState />}
      {rows && rows.length === 0 && <p className="text-sm text-text-muted py-8 text-center">Nothing here.</p>}

      <div className="space-y-3">
        {rows?.map((r) => (
          <div key={r.id} className="rounded-xl border border-border bg-surface p-4 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold text-text-primary">
                {r.user.username} <span className="font-normal text-text-muted">· {r.user.email}</span>
              </p>
              <Badge variant={r.status === 'approved' || r.status === 'used' ? 'success' : r.status === 'rejected' ? 'outline' : 'default'} size="sm">
                {r.status}{r.discountPct ? ` · ${r.discountPct}%` : ''}
              </Badge>
            </div>
            <p className="text-xs text-text-muted">
              {r.order ? `Order ${r.order.orderRef} · ${r.order.amount} ${r.order.chain}` : 'Order not found'} · submitted {new Date(r.createdAt).toLocaleString()}
            </p>
            <a href={r.postUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 break-all text-sm text-primary hover:underline">
              {r.postUrl} <ExternalLink className="h-3.5 w-3.5 flex-shrink-0" />
            </a>
            {r.rejectionReason && <p className="text-xs text-danger">Reason: {r.rejectionReason}</p>}
            {r.status === 'submitted' && (
              <div className="flex gap-2 pt-1">
                <Button size="sm" loading={busyId === r.id} onClick={() => approve(r.id)}>Approve</Button>
                <Button size="sm" variant="secondary" disabled={busyId === r.id} onClick={() => reject(r.id)}>Reject</Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
