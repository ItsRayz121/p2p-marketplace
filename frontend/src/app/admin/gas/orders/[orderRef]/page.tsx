'use client'
import { useState, useEffect, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { adminApi } from '@/lib/api'
import { fmtDateTime } from '@/lib/fmt'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { CopyButton } from '@/components/ui/CopyButton'
import { ConfirmModal } from '@/components/ui/ConfirmModal'

// ─── Types ────────────────────────────────────────────────────────────────────

interface GasOrderDetail {
  id: string
  orderRef: string
  chain: string
  tier: string | null
  gasAmountNative: string
  priceAtOrder: string | null
  paymentAmount: string
  paymentNetwork: string | null
  paymentTxHash: string | null
  toAddress: string
  fromHotWallet: string | null
  deliveryTxHash: string | null
  deliveryConfirmed: boolean
  deliveredAt: string | null
  failureReason: string | null
  status: string
  expiresAt: string | null
  refundedAt: string | null
  createdAt: string
  user: { username: string; email: string } | null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  payment_pending:  'Awaiting Payment',
  payment_detected: 'Payment Detected',
  sending:          'Delivering...',
  delivered:        'Delivered',
  expired:          'Expired',
  failed:           'Failed',
  refunded:         'Refunded',
}

function statusVariant(s: string): 'success' | 'danger' | 'warning' | 'default' | 'outline' {
  if (s === 'delivered') return 'success'
  if (s === 'failed' || s === 'expired') return 'danger'
  if (s === 'refunded') return 'warning'
  if (s === 'payment_detected' || s === 'sending') return 'default'
  return 'outline'
}

function tronscanTx(hash: string): string {
  return `https://tronscan.org/#/transaction/${hash}`
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-4 py-3 border-b border-border last:border-0">
      <span className="sm:w-44 shrink-0 text-sm text-text-muted font-medium">{label}</span>
      <span className="text-sm text-text-primary">{children}</span>
    </div>
  )
}

function TxLink({ hash }: { hash: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-xs">
      <a
        href={tronscanTx(hash)}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary hover:underline truncate max-w-xs"
        title={hash}
      >
        {hash.slice(0, 12)}...{hash.slice(-8)}
      </a>
      <CopyButton text={hash} size="sm" />
    </span>
  )
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-sm font-semibold text-text-muted uppercase tracking-wider mb-1 mt-6 first:mt-0">
      {children}
    </h2>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function GasOrderDetailPage() {
  const params = useParams()
  const router = useRouter()
  const orderRef = params.orderRef as string

  const [order, setOrder] = useState<GasOrderDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [retryOpen, setRetryOpen] = useState(false)
  const [refundOpen, setRefundOpen] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const fetchOrder = useCallback(async () => {
    try {
      const data = await adminApi.getGasOrder(orderRef)
      setOrder(data as GasOrderDetail)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load order')
    } finally {
      setLoading(false)
    }
  }, [orderRef])

  useEffect(() => { fetchOrder() }, [fetchOrder])

  async function handleRetry() {
    if (!order) return
    setActionError(null)
    try {
      await adminApi.retryGasOrder(order.id)
      setRetryOpen(false)
      await fetchOrder()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Retry failed')
      setRetryOpen(false)
    }
  }

  async function handleRefund() {
    if (!order) return
    setActionError(null)
    try {
      await adminApi.refundGasOrder(order.id)
      setRefundOpen(false)
      await fetchOrder()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Refund failed')
      setRefundOpen(false)
    }
  }

  if (loading) return <LoadingState message="Loading order..." />
  if (error || !order) return (
    <ErrorState
      title={error ?? 'Order not found'}
      onRetry={fetchOrder}
    />
  )

  const isFailed = order.status === 'failed'

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      {/* Back link */}
      <Link
        href="/admin/gas"
        className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary mb-6"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        Back to Gas Orders
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-text-primary font-mono">{order.orderRef}</h1>
          <p className="text-sm text-text-muted mt-0.5">Gas Fee Order</p>
        </div>
        <Badge variant={statusVariant(order.status)} size="md">
          {STATUS_LABELS[order.status] ?? order.status}
        </Badge>
      </div>

      {actionError && (
        <div className="mb-4 p-3 rounded-lg bg-danger/10 text-danger text-sm">{actionError}</div>
      )}

      {/* Actions (failed only) */}
      {isFailed && (
        <div className="flex gap-3 mb-6">
          <Button variant="primary" size="sm" onClick={() => setRetryOpen(true)}>
            Retry Delivery
          </Button>
          <Button variant="danger" size="sm" onClick={() => setRefundOpen(true)}>
            Refund
          </Button>
        </div>
      )}

      {/* Order Details */}
      <div className="rounded-xl border border-border bg-card p-5">
        <SectionHeading>Order</SectionHeading>
        <div>
          <InfoRow label="Reference">{order.orderRef}</InfoRow>
          <InfoRow label="Chain">{order.chain}</InfoRow>
          <InfoRow label="Tier">{order.tier ?? '—'}</InfoRow>
          <InfoRow label="TRX Amount">{parseFloat(order.gasAmountNative).toFixed(2)} TRX</InfoRow>
          <InfoRow label="Price at Order">
            {order.priceAtOrder ? `${parseFloat(order.priceAtOrder).toFixed(4)} USD/TRX` : '—'}
          </InfoRow>
        </div>

        <SectionHeading>Payment</SectionHeading>
        <div>
          <InfoRow label="Amount">{parseFloat(order.paymentAmount).toFixed(2)} USDT</InfoRow>
          <InfoRow label="Network">{order.paymentNetwork ?? 'TRC20'}</InfoRow>
          <InfoRow label="Payment Tx">
            {order.paymentTxHash ? <TxLink hash={order.paymentTxHash} /> : '—'}
          </InfoRow>
        </div>

        <SectionHeading>Delivery</SectionHeading>
        <div>
          <InfoRow label="Destination">
            <span className="inline-flex items-center gap-1.5">
              <span className="font-mono text-xs break-all">{order.toAddress}</span>
              <CopyButton text={order.toAddress} size="sm" />
            </span>
          </InfoRow>
          <InfoRow label="From Wallet">
            {order.fromHotWallet ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="font-mono text-xs">{order.fromHotWallet}</span>
                <CopyButton text={order.fromHotWallet} size="sm" />
              </span>
            ) : '—'}
          </InfoRow>
          <InfoRow label="Delivery Tx">
            {order.deliveryTxHash ? <TxLink hash={order.deliveryTxHash} /> : '—'}
          </InfoRow>
          <InfoRow label="Confirmed On-Chain">
            {order.deliveryTxHash ? (
              order.deliveryConfirmed
                ? <span className="text-success font-medium">Yes</span>
                : <span className="text-warning font-medium">Pending</span>
            ) : '—'}
          </InfoRow>
          <InfoRow label="Delivered At">{fmtDateTime(order.deliveredAt)}</InfoRow>
        </div>

        {order.failureReason && (
          <>
            <SectionHeading>Failure</SectionHeading>
            <div className="rounded-lg bg-danger/10 p-3 text-sm text-danger font-mono">
              {order.failureReason}
            </div>
          </>
        )}

        <SectionHeading>Account</SectionHeading>
        <div>
          <InfoRow label="User">
            {order.user
              ? `${order.user.username} (${order.user.email})`
              : <span className="text-text-muted italic">Guest</span>}
          </InfoRow>
        </div>

        <SectionHeading>Timestamps</SectionHeading>
        <div>
          <InfoRow label="Created">{fmtDateTime(order.createdAt)}</InfoRow>
          <InfoRow label="Expires">{fmtDateTime(order.expiresAt)}</InfoRow>
          <InfoRow label="Delivered">{fmtDateTime(order.deliveredAt)}</InfoRow>
          <InfoRow label="Refunded">{fmtDateTime(order.refundedAt)}</InfoRow>
        </div>
      </div>

      {/* Confirm modals */}
      <ConfirmModal
        isOpen={retryOpen}
        onClose={() => setRetryOpen(false)}
        onConfirm={handleRetry}
        title="Retry Delivery"
        description={`Re-queue delivery for order ${order.orderRef}. This will attempt to send ${parseFloat(order.gasAmountNative).toFixed(2)} TRX to ${order.toAddress}.`}
        confirmLabel="Retry"
        confirmVariant="primary"
      />
      <ConfirmModal
        isOpen={refundOpen}
        onClose={() => setRefundOpen(false)}
        onConfirm={handleRefund}
        title="Refund Order"
        description={`Mark order ${order.orderRef} as refunded. This will not automatically return USDT — record the manual refund separately.`}
        confirmLabel="Mark Refunded"
        confirmVariant="danger"
      />
    </div>
  )
}
