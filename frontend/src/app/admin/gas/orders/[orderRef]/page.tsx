'use client'
import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { adminApi } from '@/lib/api'
import { fmtDateTime } from '@/lib/fmt'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { CopyButton } from '@/components/ui/CopyButton'
import { ConfirmModal } from '@/components/ui/ConfirmModal'
import { Modal } from '@/components/ui/Modal'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { TokenChainLogo } from '@/components/ui/TokenChainLogo'

// ─── Types ────────────────────────────────────────────────────────────────────

interface GasOrderDetail {
  id: string
  orderRef: string
  chain: string
  tier: string | null
  gasAmountNative: string
  priceAtOrder: string | null
  paymentAmount: string
  paymentCoin: string | null
  paymentNetwork: string | null
  paymentTxHash: string | null
  pkrAmount: string | null
  pkrPaymentMethod: string | null
  paymentProofUrl: string | null
  paymentVerifiedAt: string | null
  verifiedAmount: string | null
  verifiedAsset: string | null
  verifiedConfirmations: number | null
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
  audit?: GasAuditEvent[]
}

interface GasAuditEvent {
  ts: string
  source: string
  event: string
  paymentNetwork?: string
  txHash?: string
  detectedAmount?: number
  detectedAsset?: string
  fromAddress?: string
  toAddress?: string
  expectedAmount?: number
  expectedChain?: string
  matchPass?: string
  confirmations?: number
  reason?: string
  detail?: string
}

// ─── Chain metadata ───────────────────────────────────────────────────────────

interface ChainMeta { symbol: string; explorerTx: string; name: string }

const CHAIN_META: Record<string, ChainMeta> = {
  TRON:  { symbol: 'TRX',  explorerTx: 'https://tronscan.org/#/transaction', name: 'TRON (TRC20)' },
  BSC:   { symbol: 'BNB',  explorerTx: 'https://bscscan.com/tx',             name: 'BNB Smart Chain' },
  ETH:   { symbol: 'ETH',  explorerTx: 'https://etherscan.io/tx',            name: 'Ethereum' },
  SOL:   { symbol: 'SOL',  explorerTx: 'https://solscan.io/tx',              name: 'Solana' },
  MATIC: { symbol: 'POL',  explorerTx: 'https://polygonscan.com/tx',         name: 'Polygon' },
  ARB:   { symbol: 'ETH',  explorerTx: 'https://arbiscan.io/tx',             name: 'Arbitrum' },
  BASE:  { symbol: 'ETH',  explorerTx: 'https://basescan.org/tx',            name: 'Base' },
  OP:    { symbol: 'ETH',  explorerTx: 'https://optimistic.etherscan.io/tx', name: 'Optimism' },
  AVAX:  { symbol: 'AVAX', explorerTx: 'https://snowtrace.io/tx',            name: 'Avalanche C-Chain' },
  TON:   { symbol: 'TON',  explorerTx: 'https://tonscan.org/tx',             name: 'TON' },
  SUI:   { symbol: 'SUI',  explorerTx: 'https://suiexplorer.com/txblock',    name: 'SUI' },
  APT:   { symbol: 'APT',  explorerTx: 'https://explorer.aptoslabs.com/txn', name: 'Aptos' },
}

function chainMeta(chain: string): ChainMeta {
  return CHAIN_META[chain.toUpperCase()] ?? { symbol: chain, explorerTx: '#', name: chain }
}

function explorerTxUrl(chain: string, hash: string): string {
  const meta = chainMeta(chain)
  if (meta.explorerTx === '#') return '#'
  // TRON uses /#/transaction/ path, all others use /tx/
  return `${meta.explorerTx}/${hash}`
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  payment_pending:  'Awaiting Payment',
  payment_uploaded: 'Proof Submitted',
  payment_verified: 'Payment Verified',
  payment_detected: 'Payment Confirmed',
  sending:          'Delivering...',
  delivered:        'Delivered',
  expired:          'Expired',
  failed:           'Failed',
  refunded:         'Refunded',
}

function statusVariant(s: string): 'success' | 'danger' | 'warning' | 'default' | 'outline' {
  if (s === 'delivered' || s === 'payment_verified') return 'success'
  if (s === 'failed' || s === 'expired') return 'danger'
  if (s === 'refunded') return 'warning'
  if (s === 'payment_uploaded') return 'warning'
  if (s === 'payment_detected' || s === 'sending') return 'default'
  return 'outline'
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

function TxLink({ chain, hash }: { chain: string; hash: string }) {
  const url = explorerTxUrl(chain, hash)
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-xs">
      <a
        href={url}
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
  const orderRef = params.orderRef as string

  const [order, setOrder] = useState<GasOrderDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [retryOpen, setRetryOpen] = useState(false)
  const [refundOpen, setRefundOpen] = useState(false)
  const [approvePkrOpen, setApprovePkrOpen] = useState(false)
  const [rejectPkrOpen, setRejectPkrOpen] = useState(false)
  const [markPaymentOpen, setMarkPaymentOpen] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)
  const [markPaymentTxHash, setMarkPaymentTxHash] = useState('')
  const [cancelReason, setCancelReason] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionSuccess, setActionSuccess] = useState<string | null>(null)

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

  async function handleApprovePkr() {
    if (!order) return
    setActionError(null)
    try {
      await adminApi.approvePkrOrder(order.id)
      setApprovePkrOpen(false)
      setActionSuccess('PKR payment approved — gas delivery queued.')
      await fetchOrder()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Approval failed')
      setApprovePkrOpen(false)
    }
  }

  async function handleRejectPkr() {
    if (!order) return
    setActionError(null)
    try {
      await adminApi.rejectPkrOrder(order.id)
      setRejectPkrOpen(false)
      setActionSuccess('PKR payment rejected.')
      await fetchOrder()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Rejection failed')
      setRejectPkrOpen(false)
    }
  }

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

  async function handleMarkPayment() {
    if (!order) return
    setActionError(null)
    try {
      await adminApi.markGasPaymentReceived(order.id, markPaymentTxHash.trim() || undefined)
      setMarkPaymentOpen(false)
      setMarkPaymentTxHash('')
      setActionSuccess('Payment marked as received — gas delivery queued.')
      await fetchOrder()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Action failed')
      setMarkPaymentOpen(false)
    }
  }

  async function handleCancel() {
    if (!order) return
    setActionError(null)
    try {
      await adminApi.cancelGasOrder(order.id, cancelReason.trim() || undefined)
      setCancelOpen(false)
      setCancelReason('')
      setActionSuccess('Order cancelled.')
      await fetchOrder()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Cancel failed')
      setCancelOpen(false)
    }
  }

  if (loading) return <LoadingState message="Loading order..." />
  if (error || !order) return (
    <ErrorState
      title={error ?? 'Order not found'}
      onRetry={fetchOrder}
    />
  )

  const meta = chainMeta(order.chain)
  const nativeSymbol = meta.symbol
  const chainName = meta.name

  const isFailed = order.status === 'failed'
  const isRefundPending = order.status === 'refund_pending'
  const isPkrProof = order.status === 'payment_uploaded' && order.paymentCoin === 'PKR'
  const isPaymentVerified = order.status === 'payment_verified'
  // USDT payment_uploaded = user submitted tx hash but deposit address wasn't configured for auto-verify
  const isUsdtProofPending = order.status === 'payment_uploaded' && order.paymentCoin !== 'PKR'
  const isAwaitingPayment = order.status === 'payment_pending' || order.status === 'expired' || isUsdtProofPending
  const isOrderExpired = order.expiresAt ? new Date(order.expiresAt) < new Date() : false

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

      {actionSuccess && (
        <div className="mb-4 p-3 rounded-lg bg-success/10 text-success text-sm">{actionSuccess}</div>
      )}
      {actionError && (
        <div className="mb-4 p-3 rounded-lg bg-danger/10 text-danger text-sm">{actionError}</div>
      )}

      {/* Actions — PKR proof review */}
      {isPkrProof && (
        <div className={`mb-6 p-4 rounded-xl border ${isOrderExpired ? 'bg-red-50 border-red-200' : 'bg-amber-50 border-amber-200'}`}>
          {isOrderExpired && (
            <div className="flex items-center gap-2 mb-3 p-2 rounded-lg bg-red-100 border border-red-200">
              <svg className="w-4 h-4 text-red-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <p className="text-xs font-semibold text-red-700">
                This order is expired. Approving it would queue gas delivery for an expired order. Reject it so the user can create a new order.
              </p>
            </div>
          )}
          <div className="flex gap-3 items-start">
            <div className="flex-1">
              <p className={`text-sm font-semibold mb-0.5 ${isOrderExpired ? 'text-red-900' : 'text-amber-900'}`}>PKR Payment Proof Submitted</p>
              <p className={`text-xs ${isOrderExpired ? 'text-red-700' : 'text-amber-700'}`}>
                {isOrderExpired ? 'Order expired — cannot approve. Reject to close this order.' : 'Verify the screenshot below, then approve or reject.'}
              </p>
            </div>
            <Button variant="primary" size="sm" onClick={() => setApprovePkrOpen(true)} disabled={isOrderExpired}>Approve</Button>
            <Button variant="danger" size="sm" onClick={() => setRejectPkrOpen(true)}>Reject</Button>
          </div>
        </div>
      )}

      {/* Actions — payment auto-verified by poller, awaiting admin release */}
      {isPaymentVerified && (
        <div className="mb-6 p-4 rounded-xl border bg-green-50 border-green-200">
          <div className="flex items-center gap-2 mb-3 p-2 rounded-lg bg-green-100 border border-green-200">
            <svg className="w-4 h-4 text-green-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-xs font-semibold text-green-800">
              Payment auto-verified on-chain by the payment poller.{' '}
              {order.verifiedAmount && order.verifiedAsset && (
                <span>{parseFloat(order.verifiedAmount).toFixed(4)} {order.verifiedAsset} confirmed</span>
              )}
              {order.verifiedConfirmations != null && (
                <span> · {order.verifiedConfirmations} block confirmations</span>
              )}
              . Click <strong>Release Gas</strong> to queue delivery.
            </p>
          </div>
          <div className="flex gap-3 items-start">
            <div className="flex-1">
              <p className="text-sm font-semibold mb-0.5 text-green-900">Payment Verified — Ready to Release Gas</p>
              {order.paymentTxHash && (
                <p className="text-xs font-mono text-green-700">
                  {order.paymentTxHash.slice(0, 20)}…{order.paymentTxHash.slice(-10)}
                </p>
              )}
            </div>
            <Button variant="primary" size="sm" onClick={() => setMarkPaymentOpen(true)}>Release Gas</Button>
            <Button variant="danger" size="sm" onClick={() => setCancelOpen(true)}>Cancel Order</Button>
          </div>
        </div>
      )}

      {/* Actions — awaiting payment / USDT proof submitted */}
      {isAwaitingPayment && (
        <div className={`mb-6 p-4 rounded-xl border ${
          isUsdtProofPending ? 'bg-purple-50 border-purple-200' :
          isOrderExpired ? 'bg-amber-50 border-amber-200' : 'bg-blue-50 border-blue-200'
        }`}>
          {isUsdtProofPending && (
            <div className="flex items-center gap-2 mb-3 p-2 rounded-lg bg-purple-100 border border-purple-200">
              <svg className="w-4 h-4 text-purple-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-xs font-semibold text-purple-800">
                User submitted a transaction hash for manual review. Verify the tx on-chain then confirm or reject below.
              </p>
            </div>
          )}
          {isOrderExpired && !isUsdtProofPending && (
            <div className="flex items-center gap-2 mb-3 p-2 rounded-lg bg-amber-100 border border-amber-200">
              <svg className="w-4 h-4 text-amber-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <p className="text-xs font-semibold text-amber-800">
                Order expired. If the user paid before expiry, mark it to still deliver gas.
              </p>
            </div>
          )}
          <div className="flex gap-3 items-start">
            <div className="flex-1">
              <p className={`text-sm font-semibold mb-0.5 ${
                isUsdtProofPending ? 'text-purple-900' : isOrderExpired ? 'text-amber-900' : 'text-blue-900'
              }`}>
                {isUsdtProofPending ? 'TX Hash Submitted — Pending Review' : isOrderExpired ? 'Order Expired' : 'Awaiting Payment'}
              </p>
              <p className={`text-xs font-mono ${
                isUsdtProofPending ? 'text-purple-700' : isOrderExpired ? 'text-amber-700' : 'text-blue-700'
              }`}>
                {isUsdtProofPending && order.paymentTxHash
                  ? `${order.paymentTxHash.slice(0, 20)}…${order.paymentTxHash.slice(-10)}`
                  : isOrderExpired
                  ? 'If payment was received off-chain, mark it to release gas. Otherwise cancel.'
                  : 'If you have received payment or auto-detection failed, mark it as received to release gas.'}
              </p>
            </div>
            <Button variant="primary" size="sm" onClick={() => setMarkPaymentOpen(true)}>
              {isUsdtProofPending ? 'Confirm & Release Gas' : 'Mark Payment Received'}
            </Button>
            <Button variant="danger" size="sm" onClick={() => setCancelOpen(true)}>
              {isUsdtProofPending ? 'Reject' : 'Cancel Order'}
            </Button>
          </div>
        </div>
      )}

      {/* Actions — failed or stuck-refund order */}
      {(isFailed || isRefundPending) && (
        <div className="flex gap-3 mb-6">
          {isFailed && (
            <Button variant="primary" size="sm" onClick={() => setRetryOpen(true)}>
              Retry Delivery
            </Button>
          )}
          <Button variant="danger" size="sm" onClick={() => setRefundOpen(true)}>
            {isRefundPending ? 'Send Refund Now' : 'Refund'}
          </Button>
        </div>
      )}

      {/* Order Details */}
      <div className="rounded-xl border border-border bg-card p-5">
        <SectionHeading>Order</SectionHeading>
        <div>
          <InfoRow label="Reference">{order.orderRef}</InfoRow>
          <InfoRow label="Chain">
            <span className="font-medium">{chainName}</span>
            <span className="ml-2 text-xs text-text-muted font-mono">({order.chain})</span>
          </InfoRow>
          <InfoRow label="Tier">{order.tier ?? '—'}</InfoRow>
          <InfoRow label={`${nativeSymbol} Amount`}>
            {parseFloat(order.gasAmountNative).toFixed(6)} {nativeSymbol}
          </InfoRow>
          <InfoRow label="Price at Order">
            {order.priceAtOrder ? `${parseFloat(order.priceAtOrder).toFixed(4)} USD/${nativeSymbol}` : '—'}
          </InfoRow>
        </div>

        <SectionHeading>Payment</SectionHeading>
        <div>
          <InfoRow label="Method">
            <span className="inline-flex items-center gap-2">
              {order.paymentCoin && order.paymentCoin !== 'PKR'
                ? <TokenChainLogo tokenSymbol={order.paymentCoin} chain={order.paymentNetwork === 'TRC20' ? 'TRON' : order.chain} size="sm" />
                : <EntityLogo type="payment_method" slug={order.pkrPaymentMethod ?? 'PKR'} size="sm" />}
              <span>{order.paymentCoin ?? 'USDT'}{order.paymentNetwork && order.paymentCoin !== 'PKR' ? ` · ${order.paymentNetwork}` : ''}</span>
            </span>
          </InfoRow>
          <InfoRow label="Amount">{parseFloat(order.paymentAmount).toFixed(2)} {order.paymentCoin ?? 'USDT'}</InfoRow>
          {order.paymentCoin === 'PKR' && (
            <>
              <InfoRow label="PKR Amount">PKR {order.pkrAmount ? parseFloat(order.pkrAmount).toFixed(0) : '—'}</InfoRow>
              <InfoRow label="PKR Method">{order.pkrPaymentMethod?.replace('_', ' ') ?? '—'}</InfoRow>
            </>
          )}
          <InfoRow label="Network">{order.paymentNetwork ?? '—'}</InfoRow>
          <InfoRow label="Payment Tx">
            {order.paymentTxHash
              ? <TxLink chain={order.paymentNetwork === 'TRC20' ? 'TRON' : order.chain} hash={order.paymentTxHash} />
              : '—'}
          </InfoRow>
          {order.paymentProofUrl && (
            <InfoRow label="Payment Proof">
              <a href={order.paymentProofUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline text-xs">
                View Screenshot ↗
              </a>
            </InfoRow>
          )}
          {order.verifiedAmount && order.verifiedAsset && (
            <InfoRow label="Verified Amount">
              <span className="text-green-700 font-semibold">{parseFloat(order.verifiedAmount).toFixed(4)} {order.verifiedAsset}</span>
            </InfoRow>
          )}
          {order.verifiedConfirmations != null && (
            <InfoRow label="Confirmations">{order.verifiedConfirmations} blocks</InfoRow>
          )}
          {order.paymentVerifiedAt && (
            <InfoRow label="Verified At">{fmtDateTime(order.paymentVerifiedAt)}</InfoRow>
          )}
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
            {order.deliveryTxHash ? <TxLink chain={order.chain} hash={order.deliveryTxHash} /> : '—'}
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

        {order.audit && order.audit.length > 0 && (
          <>
            <SectionHeading>Payment &amp; Delivery Audit</SectionHeading>
            <div className="space-y-2">
              {order.audit.map((a, i) => {
                const tone =
                  /matched|delivered|delivery_queued/.test(a.event) ? 'border-success/30 bg-success/5'
                  : /failed|parked|unattributed|rejected/.test(a.event) ? 'border-danger/30 bg-danger/5'
                  : 'border-border bg-surface'
                return (
                  <div key={i} className={`rounded-lg border p-2.5 text-xs ${tone}`}>
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <span className="font-bold uppercase tracking-wide">{a.event.replace(/_/g, ' ')}</span>
                      <span className="text-text-muted">{a.source} · {fmtDateTime(a.ts)}</span>
                    </div>
                    <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-text-secondary">
                      {a.matchPass        && <span>pass: <b>{a.matchPass}</b></span>}
                      {a.paymentNetwork   && <span>network: {a.paymentNetwork}</span>}
                      {a.detectedAmount != null && <span>detected: {a.detectedAmount} {a.detectedAsset ?? ''}</span>}
                      {a.expectedAmount != null && <span>expected: {a.expectedAmount}</span>}
                      {a.confirmations != null   && <span>confirmations: {a.confirmations}</span>}
                      {a.expectedChain    && <span>chain: {a.expectedChain}</span>}
                    </div>
                    {a.txHash && <p className="mt-1 font-mono text-[10px] text-text-muted truncate" title={a.txHash}>tx {a.txHash}</p>}
                    {a.reason && <p className="mt-0.5 text-danger">reason: {a.reason}</p>}
                    {a.detail && <p className="mt-0.5 text-text-muted">{a.detail}</p>}
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>

      {/* Confirm modals */}
      <ConfirmModal
        isOpen={approvePkrOpen}
        onClose={() => setApprovePkrOpen(false)}
        onConfirm={handleApprovePkr}
        title="Approve PKR Payment"
        description={`Confirm you have received PKR ${order.pkrAmount ? parseFloat(order.pkrAmount).toFixed(0) : ''} for order ${order.orderRef}. Gas delivery will be queued immediately.`}
        confirmLabel="Approve & Release Gas"
        confirmVariant="primary"
      />
      <ConfirmModal
        isOpen={rejectPkrOpen}
        onClose={() => setRejectPkrOpen(false)}
        onConfirm={handleRejectPkr}
        title="Reject PKR Payment"
        description={`Reject the PKR payment proof for order ${order.orderRef}. The order will be marked as failed.`}
        confirmLabel="Reject Payment"
        confirmVariant="danger"
      />
      <ConfirmModal
        isOpen={retryOpen}
        onClose={() => setRetryOpen(false)}
        onConfirm={handleRetry}
        title="Retry Delivery"
        description={`Re-queue delivery for order ${order.orderRef}. This will attempt to send ${parseFloat(order.gasAmountNative).toFixed(6)} ${nativeSymbol} to ${order.toAddress}.`}
        confirmLabel="Retry"
        confirmVariant="primary"
      />
      <ConfirmModal
        isOpen={refundOpen}
        onClose={() => setRefundOpen(false)}
        onConfirm={handleRefund}
        title="Send USDT Refund"
        description={`Send ${order.paymentAmount} USDT back to the payer for order ${order.orderRef} on the payment network (${order.paymentNetwork}). The system resolves the sender from the payment tx and transfers automatically from the hot wallet.`}
        confirmLabel="Send Refund"
        confirmVariant="danger"
      />

      {/* Mark Payment Received modal */}
      <Modal
        isOpen={markPaymentOpen}
        onClose={() => { setMarkPaymentOpen(false); setMarkPaymentTxHash('') }}
        title="Mark Payment Received"
        size="sm"
        footer={
          <div className="flex gap-3 justify-end">
            <Button variant="ghost" size="sm" onClick={() => { setMarkPaymentOpen(false); setMarkPaymentTxHash('') }}>Cancel</Button>
            <Button variant="primary" size="sm" onClick={handleMarkPayment}>Confirm &amp; Release Gas</Button>
          </div>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-text-muted">
            Confirm you have received payment for order <span className="font-mono font-medium">{order.orderRef}</span>. Gas delivery will be queued immediately.
          </p>
          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">
              Transaction Hash <span className="text-text-muted font-normal">(optional)</span>
            </label>
            <input
              type="text"
              placeholder="0x... or TRON tx hash"
              value={markPaymentTxHash}
              onChange={e => setMarkPaymentTxHash(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm text-text-primary font-mono placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
        </div>
      </Modal>

      {/* Cancel Order modal */}
      <Modal
        isOpen={cancelOpen}
        onClose={() => { setCancelOpen(false); setCancelReason('') }}
        title="Cancel Order"
        size="sm"
        footer={
          <div className="flex gap-3 justify-end">
            <Button variant="ghost" size="sm" onClick={() => { setCancelOpen(false); setCancelReason('') }}>Back</Button>
            <Button variant="danger" size="sm" onClick={handleCancel}>Cancel Order</Button>
          </div>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-text-muted">
            Cancel order <span className="font-mono font-medium">{order.orderRef}</span>. The order will be marked as failed.
          </p>
          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">
              Reason <span className="text-text-muted font-normal">(optional)</span>
            </label>
            <input
              type="text"
              placeholder="e.g. Expired, fraud suspected, user request…"
              value={cancelReason}
              onChange={e => setCancelReason(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-danger"
            />
          </div>
        </div>
      </Modal>
    </div>
  )
}
