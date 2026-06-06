'use client'
import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { adminApi } from '@/lib/api'
import { fmtDateTime } from '@/lib/fmt'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Badge } from '@/components/ui/Badge'
import { ArrowLeft } from 'lucide-react'

/* eslint-disable @typescript-eslint/no-explicit-any */

function statusTone(status: string): 'success' | 'warning' | 'danger' | 'default' {
  const s = (status ?? '').toLowerCase()
  if (['sent', 'completed', 'approved'].includes(s)) return 'success'
  if (['rejected', 'failed', 'cancelled'].includes(s)) return 'danger'
  if (['pending', 'on_hold', 'processing'].includes(s)) return 'warning'
  return 'default'
}

function InfoRow({ label, value, mono }: { label: string; value?: React.ReactNode; mono?: boolean }) {
  if (value === undefined || value === null || value === '') return null
  return (
    <div className="flex gap-2 py-1.5 border-b border-border last:border-0">
      <span className="text-text-muted text-xs w-40 flex-shrink-0">{label}</span>
      <span className={`text-text-primary text-sm break-all ${mono ? 'font-mono text-xs' : ''}`}>{value}</span>
    </div>
  )
}

export default function AdminWithdrawalDetailPage() {
  const params = useParams()
  const id = params?.id as string
  const [w, setW] = useState<any | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const d = await adminApi.getWithdrawal(id)
      setW(d)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load withdrawal')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { if (id) load() }, [id, load])

  if (loading) return <LoadingState message="Loading withdrawal..." />
  if (error || !w) return <ErrorState title={error ?? 'Withdrawal not found'} onRetry={load} />

  return (
    <div className="space-y-5">
      <Link href="/admin/withdrawals" className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-primary">
        <ArrowLeft size={15} /> Back to Withdrawals
      </Link>

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold text-text-primary">Withdrawal {w.orderRef}</h1>
        <Badge variant={statusTone(w.status)} size="sm">{String(w.status).replace(/_/g, ' ')}</Badge>
        {w.tier != null && <Badge variant="default" size="sm">Tier {w.tier}</Badge>}
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <div className="bg-surface shadow-card border border-border rounded-xl p-4">
          <p className="text-[11px] font-semibold text-text-muted uppercase tracking-wide mb-2">Details</p>
          <InfoRow label="Order Ref" value={w.orderRef} mono />
          <InfoRow label="User" value={w.user ? <Link href={`/admin/users/${w.user.id}`} className="text-primary hover:underline">{w.user.username}</Link> : undefined} />
          <InfoRow label="Email" value={w.user?.email} />
          <InfoRow label="Amount" value={`${Number(w.amount).toLocaleString()} ${w.coin}`} />
          <InfoRow label="Fee" value={`${Number(w.fee).toLocaleString()} ${w.coin}`} />
          <InfoRow label="USD Value" value={w.amountUsd ? `$${Number(w.amountUsd).toLocaleString()}` : undefined} />
          <InfoRow label="Network" value={w.network} />
          <InfoRow label="To Address" value={w.toAddress} mono />
          <InfoRow label="Tx Hash" value={w.txHash} mono />
          <InfoRow label="Created" value={fmtDateTime(w.createdAt)} />
        </div>

        <div className="bg-surface shadow-card border border-border rounded-xl p-4">
          <p className="text-[11px] font-semibold text-text-muted uppercase tracking-wide mb-2">Risk & Review</p>
          <InfoRow label="Risk Score" value={w.riskScore != null ? String(w.riskScore) : undefined} />
          <InfoRow label="Risk Flags" value={w.riskFlags?.length ? w.riskFlags.join(', ') : 'None'} />
          <InfoRow label="Risk Override" value={w.riskOverride ? 'Yes' : undefined} />
          <InfoRow label="On Hold Reason" value={w.onHoldReason} />
          <InfoRow label="Rejection Reason" value={w.rejectionReason} />
          <InfoRow label="Admin Note" value={w.adminNote} />
          <InfoRow label="Confirmation" value={w.confirmationChannel} />
        </div>
      </div>

      <p className="text-xs text-text-muted">
        This is a read-only view. Use the{' '}
        <Link href="/admin/withdrawals" className="text-primary hover:underline">Withdrawals</Link> queue to approve, reject, hold or mark withdrawals.
      </p>
    </div>
  )
}
