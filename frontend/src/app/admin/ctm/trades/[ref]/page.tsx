'use client'
import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { ctmApi } from '@/lib/api'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { CtmStatusTimeline } from '@/components/admin/CtmStatusTimeline'
import { ArrowLeft } from 'lucide-react'

const CTM_TERMINAL = ['completed', 'cancelled', 'expired', 'dispute_resolved']

/* eslint-disable @typescript-eslint/no-explicit-any */

function fmtDt(iso?: string) {
  return iso ? new Date(iso).toLocaleString('en-PK', { dateStyle: 'short', timeStyle: 'short' }) : '—'
}

function statusTone(status: string): 'success' | 'warning' | 'danger' | 'default' {
  if (['completed', 'dispute_resolved'].includes(status)) return 'success'
  if (['cancelled', 'expired'].includes(status)) return 'default'
  if (status === 'disputed') return 'danger'
  return 'warning'
}

function InfoRow({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null
  return (
    <div className="flex gap-2">
      <span className="text-text-muted text-xs w-36 flex-shrink-0">{label}</span>
      <span className="text-text-primary text-xs font-medium break-all">{value}</span>
    </div>
  )
}

export default function AdminCtmTradeDetailPage() {
  const params = useParams()
  const ref = params?.ref as string
  const [trade, setTrade] = useState<any | null>(null)
  const [messages, setMessages] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [fcOpen, setFcOpen] = useState(false)
  const [fcReason, setFcReason] = useState('')
  const [fcBusy, setFcBusy] = useState(false)
  const [fcErr, setFcErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const d = await ctmApi.getTrade(ref)
      setTrade(d)
      setError(null)
      // Trade chat lives in a separate endpoint; fetch it best-effort.
      try {
        const msgs = await ctmApi.getMessages(ref)
        setMessages(Array.isArray(msgs) ? msgs : [])
      } catch { setMessages([]) }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load trade')
    } finally {
      setLoading(false)
    }
  }, [ref])

  useEffect(() => { if (ref) load() }, [ref, load])

  async function handleForceComplete() {
    setFcBusy(true); setFcErr(null)
    try {
      await ctmApi.adminForceRelease(ref, fcReason.trim() || undefined)
      setFcOpen(false); setFcReason('')
      await load()
    } catch (e) {
      setFcErr(e instanceof Error ? e.message : 'Force-complete failed')
    } finally {
      setFcBusy(false)
    }
  }

  if (loading) return <LoadingState message="Loading trade..." />
  if (error || !trade) return <ErrorState title={error ?? 'Trade not found'} onRetry={load} />

  const proofs = trade.proofs ?? []
  const disputeMessages = trade.dispute?.messages ?? []

  return (
    <div className="space-y-5">
      <Link href="/admin/ctm/trades" className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-primary">
        <ArrowLeft size={15} /> Back to CTM Trades
      </Link>

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold text-text-primary">CTM Trade #{trade.tradeRef.slice(-10)}</h1>
        <Badge variant={statusTone(trade.status)} size="sm">{trade.status.replace(/_/g, ' ')}</Badge>
      </div>

      {/* Timeline */}
      <div className="bg-surface shadow-card border border-border rounded-xl p-5">
        <CtmStatusTimeline status={trade.status} />
      </div>

      {/* Parties + amounts */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-surface shadow-card rounded-xl p-3 border border-border">
          <p className="text-[11px] font-semibold text-text-muted uppercase tracking-wide">Buyer</p>
          <Link href={`/admin/users/${trade.buyer.id}`} className="font-semibold text-text-primary text-sm hover:text-primary hover:underline">{trade.buyer.username}</Link>
          {trade.buyer.fullName && <p className="text-xs text-text-muted">{trade.buyer.fullName}</p>}
        </div>
        <div className="bg-surface shadow-card rounded-xl p-3 border border-border">
          <p className="text-[11px] font-semibold text-text-muted uppercase tracking-wide">Seller</p>
          <Link href={`/admin/users/${trade.seller.id}`} className="font-semibold text-text-primary text-sm hover:text-primary hover:underline">{trade.seller.username}</Link>
          {trade.seller.fullName && <p className="text-xs text-text-muted">{trade.seller.fullName}</p>}
        </div>
        <div className="bg-surface shadow-card rounded-xl p-3 border border-border">
          <p className="text-[11px] font-semibold text-text-muted uppercase tracking-wide">PKR Amount</p>
          <p className="font-bold text-text-primary">PKR {Number(trade.fiatAmount).toLocaleString()}</p>
        </div>
        <div className="bg-surface shadow-card rounded-xl p-3 border border-border">
          <p className="text-[11px] font-semibold text-text-muted uppercase tracking-wide">Token</p>
          <p className="font-bold text-text-primary">{Number(trade.tokenAmount).toLocaleString()} {trade.token?.symbol}</p>
          {trade.pricePerUnit && <p className="text-xs text-text-muted">@ PKR {Number(trade.pricePerUnit).toLocaleString()}</p>}
        </div>
      </div>

      {/* Trade details */}
      <div className="bg-surface shadow-card border border-border rounded-xl p-4 space-y-1.5">
        <p className="text-[11px] font-semibold text-text-muted uppercase tracking-wide mb-2">Trade Details</p>
        <InfoRow label="Ref" value={trade.tradeRef} />
        <InfoRow label="Token" value={trade.token ? `${trade.token.name} (${trade.token.symbol})` : undefined} />
        <InfoRow label="Settlement" value={trade.settlementType} />
        <InfoRow label="Network" value={trade.listing?.networkLabel ?? trade.networkLabel} />
        <InfoRow label="Seller receives" value={trade.listing?.receivingWalletAddress ?? trade.sellerWalletAddress} />
        <InfoRow label="Payment method" value={trade.listing?.paymentMethods?.join(', ') ?? trade.paymentMethod} />
        <InfoRow label="Created" value={fmtDt(trade.createdAt)} />
        <InfoRow label="Expires" value={fmtDt(trade.expiresAt)} />
        <InfoRow label="Completed" value={trade.completedAt ? fmtDt(trade.completedAt) : undefined} />
      </div>

      {/* Payment proof */}
      {trade.paymentProofUrl && (
        <div className="bg-surface shadow-card border border-border rounded-xl p-4">
          <p className="text-sm font-medium text-text-primary mb-2">Payment Proof</p>
          <a href={trade.paymentProofUrl} target="_blank" rel="noopener noreferrer">
            <img src={trade.paymentProofUrl} alt="Payment proof" className="max-h-64 object-contain rounded-xl border border-border" />
          </a>
        </div>
      )}

      {/* All proofs */}
      {proofs.length > 0 && (
        <div className="bg-surface shadow-card border border-border rounded-xl p-4">
          <p className="text-sm font-medium text-text-primary mb-2">Proofs ({proofs.length})</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {proofs.map((p: any, i: number) => (
              p.fileUrl ? (
                <a key={p.id ?? i} href={p.fileUrl} target="_blank" rel="noopener noreferrer">
                  <img src={p.fileUrl} alt="proof" className="w-full h-28 object-cover rounded-xl border border-border" />
                  <p className="text-xs text-text-muted mt-0.5">{p.proofType} · {fmtDt(p.createdAt)}</p>
                </a>
              ) : (
                <div key={p.id ?? i} className="h-28 rounded-xl border border-border bg-surface-alt flex items-center justify-center text-xs text-text-muted">{p.proofType}</div>
              )
            ))}
          </div>
        </div>
      )}

      {/* Trade chat */}
      {messages.length > 0 && (
        <div className="bg-surface shadow-card border border-border rounded-xl p-4">
          <p className="text-sm font-medium text-text-primary mb-2">Trade Chat ({messages.length})</p>
          <div className="space-y-2 max-h-72 overflow-y-auto">
            {messages.map((m: any, i: number) => {
              const isBuyer = m.senderId === trade.buyer.id
              const isSeller = m.senderId === trade.seller.id
              const label = isBuyer ? `${trade.buyer.username} (Buyer)` : isSeller ? `${trade.seller.username} (Seller)` : 'Admin'
              return (
                <div key={m.id ?? i} className={`flex ${isBuyer ? 'justify-start' : 'justify-end'}`}>
                  <div className={`rounded-lg px-3 py-2 max-w-[80%] text-xs ${
                    isBuyer ? 'bg-blue-500/10 text-blue-800 dark:bg-blue-500/15 dark:text-blue-200'
                      : isSeller ? 'bg-green-500/10 text-green-800 dark:bg-green-500/15 dark:text-green-200'
                      : 'bg-purple-500/10 text-purple-800 dark:bg-purple-500/15 dark:text-purple-200'
                  }`}>
                    <p className="font-semibold text-[10px] mb-0.5">{label}</p>
                    <p>{m.message}</p>
                    {m.attachmentUrl && (
                      <a href={m.attachmentUrl} target="_blank" rel="noopener noreferrer" className="underline text-[10px]">attachment</a>
                    )}
                    <p className="text-[9px] opacity-60 mt-0.5">{fmtDt(m.createdAt)}</p>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Dispute */}
      {trade.dispute && (
        <div className="bg-danger/5 border border-danger/30 rounded-xl p-4 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <p className="font-semibold text-danger text-sm">Dispute</p>
              <Badge variant="danger" size="sm">{trade.dispute.status.replace(/_/g, ' ')}</Badge>
            </div>
            <Link href="/admin/ctm/disputes" className="text-xs text-primary hover:underline">Manage in Disputes →</Link>
          </div>
          <p className="text-danger text-xs">Reason: {String(trade.dispute.reason).replace(/_/g, ' ')}</p>
          {trade.dispute.resolution && <p className="text-text-secondary text-xs">Resolution: {trade.dispute.resolution}</p>}
          {disputeMessages.length > 0 && (
            <div className="max-h-40 overflow-y-auto space-y-1 mt-2">
              {disputeMessages.map((m: any, i: number) => (
                <p key={m.id ?? i} className="text-xs text-text-secondary">
                  <span className="text-text-muted">{fmtDt(m.createdAt)} · </span>{m.message}
                </p>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Force complete — any non-terminal CTM trade (incl. a disputed one) */}
      {!CTM_TERMINAL.includes(trade.status) && (
        <div className="bg-surface shadow-card border border-border rounded-xl p-4">
          <p className="text-sm font-medium text-text-primary mb-1">Force Complete</p>
          <p className="text-xs text-text-secondary mb-3">
            Marks the trade completed (stats, streaks, maker bond, messaging thread) and closes any
            open dispute. Use when both sides have settled off-platform or the buyer confirmed receipt
            elsewhere. Does not move any tokens.
          </p>
          {!fcOpen ? (
            <Button variant="danger" size="sm" onClick={() => { setFcOpen(true); setFcErr(null) }}>Force Complete Trade</Button>
          ) : (
            <div className="space-y-2">
              <textarea
                value={fcReason}
                onChange={(e) => setFcReason(e.target.value)}
                placeholder="Reason (optional, recorded in the audit log / dispute resolution)"
                rows={3}
                className="w-full border border-border rounded-xl p-2 text-xs bg-surface"
              />
              {fcErr && <p className="text-xs text-danger">{fcErr}</p>}
              <div className="flex gap-2">
                <Button variant="danger" size="sm" onClick={handleForceComplete} disabled={fcBusy}>
                  {fcBusy ? 'Completing…' : 'Confirm — Complete Trade'}
                </Button>
                <Button variant="secondary" size="sm" onClick={() => { setFcOpen(false); setFcReason(''); setFcErr(null) }} disabled={fcBusy}>Cancel</Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Audit log (admin) */}
      {Array.isArray(trade.auditLogs) && trade.auditLogs.length > 0 && (
        <div className="bg-surface shadow-card border border-border rounded-xl p-4">
          <p className="text-sm font-medium text-text-primary mb-2">Audit Log ({trade.auditLogs.length})</p>
          <ul className="divide-y divide-border">
            {trade.auditLogs.map((a: any) => (
              <li key={a.id} className="py-2 flex items-center justify-between gap-2 text-xs">
                <span className="font-mono text-text-secondary">{a.action.replace(/_/g, ' ')}</span>
                <span className="text-text-muted">{a.actorId?.slice(0, 8)}… · {fmtDt(a.createdAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
