'use client'
import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { adminApi } from '@/lib/api'
import { fmtDateTime } from '@/lib/fmt'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { ArrowLeft, Copy, ExternalLink } from 'lucide-react'

const STATUS_LABELS: Record<string, string> = {
  payment_pending:   'Awaiting Payment',
  payment_uploaded:  'Proof Uploaded',
  payment_confirmed: 'Payment Confirmed',
  crypto_sent:       'Crypto Sent',
  crypto_released:   'Completed',
  released:          'Completed',
  completed:         'Completed',
  disputed:          'Disputed',
  cancelled:         'Cancelled',
  expired:           'Expired',
}

const statusVariant = (s: string): 'success' | 'danger' | 'warning' | 'default' => {
  if (s === 'crypto_released' || s === 'released' || s === 'completed') return 'success'
  if (s === 'disputed') return 'danger'
  if (s === 'cancelled' || s === 'expired') return 'warning'
  return 'default'
}

function Row({ label, value }: { label: string; value?: string | number | null }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 py-2 border-b border-border last:border-0">
      <dt className="text-sm text-text-muted w-44 flex-shrink-0">{label}</dt>
      <dd className="text-sm text-text-primary font-mono break-all flex-1">{value ?? 'N/A'}</dd>
    </div>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => { void navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
      className="ml-2 text-xs text-text-muted hover:text-primary transition-colors"
    >
      {copied ? '✓' : <Copy size={13} />}
    </button>
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
      <div className="px-5 py-3 border-b border-border">
        <h2 className="font-semibold text-text-primary">{title}</h2>
      </div>
      <div className="p-5">{children}</div>
    </div>
  )
}

export default function TradeDetailPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [trade, setTrade] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return
    adminApi.getTrade(id as string)
      .then((d) => { setTrade(d); setLoading(false) })
      .catch((e) => { setError(e instanceof Error ? e.message : 'Failed to load trade'); setLoading(false) })
  }, [id])

  if (loading) return <LoadingState message="Loading trade details…" />
  if (error || !trade) return <ErrorState title={error ?? 'Trade not found'} onRetry={() => router.back()} />

  const buyer = trade.buyer
  const seller = trade.seller

  return (
    <div className="space-y-5 max-w-4xl">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button onClick={() => router.back()} className="text-text-muted hover:text-text-primary transition-colors">
          <ArrowLeft size={18} />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-xl font-bold text-text-primary">Trade Detail</h1>
            <Badge variant={statusVariant(trade.status)} size="sm">
              {STATUS_LABELS[trade.status] ?? trade.status}
            </Badge>
          </div>
          <p className="text-xs text-text-muted font-mono mt-0.5 break-all">
            {trade.id}
            <CopyButton text={trade.id} />
          </p>
        </div>
      </div>

      {/* Core details */}
      <Section title="Trade Summary">
        <dl>
          <Row label="Order Ref" value={trade.orderRef} />
          <Row label="Coin / Network" value={`${trade.coin} / ${trade.network}`} />
          <Row label="Amount" value={`${trade.amount} ${trade.coin}`} />
          <Row label="PKR Value" value={`PKR ${Number(trade.fiatAmount).toLocaleString()}`} />
          <Row label="Price / Unit" value={`PKR ${Number(trade.price).toLocaleString()}`} />
          <Row label="Payment Method" value={trade.paymentMethod} />
          <Row label="Created" value={fmtDateTime(trade.createdAt)} />
          <Row label="Expires" value={fmtDateTime(trade.expiresAt)} />
          {trade.paymentUploadedAt && <Row label="Proof Uploaded" value={fmtDateTime(trade.paymentUploadedAt)} />}
          {trade.paymentConfirmedAt && <Row label="Payment Confirmed" value={fmtDateTime(trade.paymentConfirmedAt)} />}
          {trade.updatedAt && <Row label="Last Updated" value={fmtDateTime(trade.updatedAt)} />}
        </dl>
      </Section>

      {/* Parties */}
      <div className="grid sm:grid-cols-2 gap-4">
        <Section title="Buyer">
          <dl>
            <Row label="Username" value={buyer?.username} />
            <Row label="Email" value={buyer?.email} />
            <Row label="KYC" value={`${buyer?.kycStatus ?? 'N/A'} (L${buyer?.kycLevel === 'enhanced' ? 2 : buyer?.kycLevel === 'basic' ? 1 : 0})`} />
            <Row label="Delivery Method" value={trade.buyerDeliveryMethod} />
            <Row label="Delivery Address" value={trade.buyerDeliveryAddress} />
          </dl>
          {buyer?.id && (
            <div className="mt-3">
              <Link href={`/admin/users/${buyer.id}`} className="text-xs text-primary hover:underline inline-flex items-center gap-1">
                View User Profile <ExternalLink size={11} />
              </Link>
            </div>
          )}
        </Section>
        <Section title="Seller">
          <dl>
            <Row label="Username" value={seller?.username} />
            <Row label="Email" value={seller?.email} />
            <Row label="KYC" value={`${seller?.kycStatus ?? 'N/A'} (L${seller?.kycLevel === 'enhanced' ? 2 : seller?.kycLevel === 'basic' ? 1 : 0})`} />
          </dl>
          {seller?.id && (
            <div className="mt-3">
              <Link href={`/admin/users/${seller.id}`} className="text-xs text-primary hover:underline inline-flex items-center gap-1">
                View User Profile <ExternalLink size={11} />
              </Link>
            </div>
          )}
        </Section>
      </div>

      {/* Timeline */}
      {(() => {
        const events = [
          { label: 'Trade created', time: trade.createdAt },
          { label: 'Payment proof uploaded', time: trade.paymentUploadedAt },
          { label: 'Payment confirmed', time: trade.paymentConfirmedAt },
          trade.dispute ? { label: 'Dispute opened', time: trade.dispute.createdAt } : null,
          trade.cancelledAt ? { label: `Cancelled${trade.cancelledBy ? ` by ${trade.cancelledBy}` : ''}`, time: trade.cancelledAt } : null,
          ['crypto_released', 'released', 'completed'].includes(trade.status) ? { label: 'Completed', time: trade.updatedAt } : null,
          trade.expiresAt && ['expired'].includes(trade.status) ? { label: 'Expired', time: trade.expiresAt } : null,
        ].filter((e): e is { label: string; time: string } => !!e && !!e.time)
          .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime())
        return (
          <Section title="Timeline">
            <ol className="relative border-l border-border ml-2 space-y-4">
              {events.map((e, i) => (
                <li key={i} className="ml-4">
                  <span className="absolute -left-[5px] mt-1.5 w-2.5 h-2.5 rounded-full bg-primary" />
                  <p className="text-sm text-text-primary">{e.label}</p>
                  <p className="text-xs text-text-muted">{fmtDateTime(e.time)}</p>
                </li>
              ))}
            </ol>
          </Section>
        )
      })()}

      {/* Payment proof */}
      {trade.paymentProofUrl && (
        <Section title="Payment Proof">
          <a href={trade.paymentProofUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline text-sm inline-flex items-center gap-1">
            View Proof Image <ExternalLink size={13} />
          </a>
        </Section>
      )}

      {/* Transaction */}
      {(trade.sellerTxHash || trade.txVerificationStatus) && (
        <Section title="Token Delivery">
          <dl>
            <Row label="TX Hash" value={trade.sellerTxHash} />
            <Row label="Verification Status" value={trade.txVerificationStatus} />
            {trade.txVerificationDetails && (
              <div className="mt-3">
                <p className="text-xs text-text-muted mb-1">Verification Details</p>
                <pre className="text-xs bg-surface border border-border rounded-lg p-3 overflow-auto max-h-40 font-mono text-text-secondary whitespace-pre-wrap">
                  {JSON.stringify(trade.txVerificationDetails, null, 2)}
                </pre>
              </div>
            )}
          </dl>
        </Section>
      )}

      {/* Chat messages */}
      {trade.messages && trade.messages.length > 0 && (
        <Section title={`Chat (${trade.messages.length} messages)`}>
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {trade.messages.map((m: { id: string; senderId: string; message: string; createdAt: string }) => (
              <div key={m.id} className="text-sm border-b border-border pb-2 last:border-0">
                <div className="flex items-center justify-between gap-2 mb-0.5">
                  <span className="text-xs font-mono text-text-muted">{m.senderId.slice(0, 8)}…</span>
                  <span className="text-xs text-text-muted">{fmtDateTime(m.createdAt)}</span>
                </div>
                <p className="text-text-secondary">{m.message}</p>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Dispute */}
      {trade.dispute && (
        <Section title="Dispute">
          <dl className="mb-3">
            <Row label="Dispute ID" value={trade.dispute.id} />
            <Row label="Status" value={trade.dispute.status} />
            <Row label="Reason" value={trade.dispute.reason} />
            <Row label="Opened" value={fmtDateTime(trade.dispute.createdAt)} />
          </dl>
          {trade.dispute.messages && trade.dispute.messages.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-text-muted mb-2">Dispute Messages</p>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {trade.dispute.messages.map((m: { id: string; senderId: string; message: string; createdAt: string }) => (
                  <div key={m.id} className="text-sm border-b border-border pb-2 last:border-0">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-mono text-text-muted">{m.senderId.slice(0, 8)}…</span>
                      <span className="text-xs text-text-muted">{fmtDateTime(m.createdAt)}</span>
                    </div>
                    <p className="text-text-secondary mt-0.5">{m.message}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Section>
      )}

      {/* Ratings */}
      {trade.ratings && trade.ratings.length > 0 && (
        <Section title="Ratings">
          <div className="space-y-3">
            {trade.ratings.map((r: { id: string; rating: number; comment?: string; ratedByUserId: string }) => (
              <div key={r.id} className="flex items-start gap-3 text-sm">
                <span className="text-gold font-bold">{r.rating}/5</span>
                <div>
                  <p className="text-text-secondary">{r.comment || '(no comment)'}</p>
                  <p className="text-xs text-text-muted">By {r.ratedByUserId.slice(0, 8)}…</p>
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Cancel reason */}
      {trade.cancelReason && (
        <Section title="Cancellation">
          <Row label="Reason" value={trade.cancelReason} />
          <Row label="Cancelled By" value={trade.cancelledBy} />
          {trade.cancelledAt && <Row label="Cancelled At" value={fmtDateTime(trade.cancelledAt)} />}
        </Section>
      )}

      {/* Audit logs */}
      <Section title={`Audit Logs${trade.auditLogs?.length ? ` (${trade.auditLogs.length})` : ''}`}>
        {trade.auditLogs?.length ? (
          <ul className="divide-y divide-border -my-2">
            {trade.auditLogs.map((a: { id: string; action: string; actorId: string; ipAddress?: string; createdAt: string }) => (
              <li key={a.id} className="py-2.5 flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="font-mono text-xs text-text-secondary">{a.action}</span>
                <span className="text-xs text-text-muted">{a.actorId?.slice(0, 8)}… · {a.ipAddress ?? 'no IP'} · {fmtDateTime(a.createdAt)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-text-muted">No admin actions recorded for this trade.</p>
        )}
      </Section>

      {/* Actions */}
      <div className="flex gap-3">
        <Button variant="secondary" onClick={() => router.back()}>← Back to Trades</Button>
        {trade.dispute?.id && (
          <Link href={`/admin/disputes`}>
            <Button variant="secondary">View Dispute</Button>
          </Link>
        )}
      </div>
    </div>
  )
}
