'use client'
import { useState, useCallback } from 'react'
import Link from 'next/link'
import { adminMakerApi, type PendingAdItem } from '@/lib/makerApi'
import { usePolling } from '@/hooks/usePolling'
import { fmtDateTime } from '@/lib/fmt'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { ClipboardCheck } from 'lucide-react'

export default function AdReviewPage() {
  const [items, setItems] = useState<PendingAdItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [rejecting, setRejecting] = useState<PendingAdItem | null>(null)
  const [note, setNote] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await adminMakerApi.getAdReview()
      setItems([...res.ads, ...res.listings].sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    }
  }, [])

  usePolling(load, 30_000)

  async function decide(item: PendingAdItem, approve: boolean, reason?: string) {
    const key = `${item.kind}:${item.id}`
    setBusyKey(key)
    setActionError(null)
    try {
      await adminMakerApi.decideAd(item.kind, item.id, { approve, ...(reason ? { note: reason } : {}) })
      setRejecting(null)
      setNote('')
      await load()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Action failed')
    } finally {
      setBusyKey(null)
    }
  }

  if (error && !items) return <ErrorState title={error} onRetry={load} />
  if (!items) return <LoadingState message="Loading ad review queue..." />

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      <div className="mb-5">
        <h1 className="text-xl font-bold text-text-primary flex items-center gap-2"><ClipboardCheck className="w-5 h-5 text-primary" /> Ad Review</h1>
        <p className="text-sm text-text-muted mt-1">New makers&apos; first ads wait here and stay hidden until you approve them.</p>
      </div>

      {actionError && <p className="mb-3 text-sm text-danger">{actionError}</p>}

      {items.length === 0 ? (
        <EmptyState title="Queue is empty" description="No ads are waiting for review." />
      ) : (
        <ul className="space-y-3">
          {items.map((it) => {
            const key = `${it.kind}:${it.id}`
            return (
              <li key={key} className="bg-surface border border-border rounded-xl p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-text-primary">{it.title}</p>
                    <p className="text-xs text-text-muted">
                      by{' '}
                      <Link href={`/admin/users/${it.maker.id}`} className="text-primary hover:underline">{it.maker.username ?? 'user'}</Link>
                      {' '}· KYC {it.maker.kycLevel} · {it.maker.tradeStats ? `${it.maker.tradeStats.completedTrades}/${it.maker.tradeStats.totalTrades} trades` : 'no trades yet'} · {fmtDateTime(it.createdAt)}
                    </p>
                  </div>
                  <Badge variant={it.kind === 'ctm' ? 'warning' : 'default'} size="sm">{it.kind === 'ctm' ? 'CTM listing' : 'USDT ad'}</Badge>
                </div>

                <dl className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 text-xs">
                  <div><dt className="text-text-muted">Price</dt><dd className="text-text-primary">{Number(it.price).toLocaleString()}</dd></div>
                  <div><dt className="text-text-muted">Order size</dt><dd className="text-text-primary">{Number(it.minOrder).toLocaleString()} – {Number(it.maxOrder).toLocaleString()}</dd></div>
                  <div><dt className="text-text-muted">Total</dt><dd className="text-text-primary">{Number(it.totalAmount).toLocaleString()}</dd></div>
                  <div><dt className="text-text-muted">Pay with</dt><dd className="text-text-primary truncate">{it.paymentMethods.length ? it.paymentMethods.join(', ') : '—'}</dd></div>
                </dl>
                {it.terms && <p className="mt-2 text-xs text-text-secondary whitespace-pre-wrap border-l-2 border-border pl-2">{it.terms}</p>}

                <div className="mt-3 flex gap-2">
                  <Button size="sm" loading={busyKey === key} onClick={() => decide(it, true)}>Approve</Button>
                  <Button size="sm" variant="danger" disabled={busyKey === key} onClick={() => { setRejecting(it); setNote('') }}>Reject</Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {rejecting && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setRejecting(null)}>
          <div className="bg-surface rounded-xl border border-border p-5 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-semibold text-text-primary mb-1">Reject: {rejecting.title}</h3>
            <p className="text-xs text-text-muted mb-3">The maker sees this reason.</p>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              maxLength={500}
              placeholder="e.g. Price is far from the market rate. Please correct it and post again."
              className="w-full px-3 py-2 border border-border rounded-lg text-sm bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-primary"
            />
            <div className="flex justify-end gap-2 mt-3">
              <Button size="sm" variant="secondary" onClick={() => setRejecting(null)}>Cancel</Button>
              <Button size="sm" variant="danger" loading={busyKey === `${rejecting.kind}:${rejecting.id}`} disabled={!note.trim()} onClick={() => decide(rejecting, false, note.trim())}>Reject</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
