'use client'
import { useState, useEffect, useCallback, Suspense } from 'react'
import Link from 'next/link'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { Fuel } from 'lucide-react'
import { gasApi, type GasOrder, ApiError } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'
import { usePolling } from '@/hooks/usePolling'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { CopyButton } from '@/components/ui/CopyButton'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { GasOrderActions } from './GasOrderActions'

// ─── Constants ────────────────────────────────────────────────────────────────

const EXPLORER_TX: Record<string, string> = {
  BEP20:  'https://bscscan.com/tx',
  ERC20:  'https://etherscan.io/tx',
  TRC20:  'https://tronscan.org/#/transaction',
  APTOS:  'https://explorer.aptoslabs.com/txn',
  BSC:    'https://bscscan.com/tx',
  ETH:    'https://etherscan.io/tx',
  TRON:   'https://tronscan.org/#/transaction',
  SOL:    'https://solscan.io/tx',
  MATIC:  'https://polygonscan.com/tx',
  ARB:    'https://arbiscan.io/tx',
  BASE:   'https://basescan.org/tx',
  OP:     'https://optimistic.etherscan.io/tx',
  AVAX:   'https://snowtrace.io/tx',
  TON:    'https://tonscan.org/tx',
  SUI:    'https://suiexplorer.com/txblock',
}

const NATIVE_SYMBOLS: Record<string, string> = {
  TRON: 'TRX', BSC: 'BNB', ETH: 'ETH', SOL: 'SOL',
  MATIC: 'POL', ARB: 'ETH', BASE: 'ETH', OP: 'ETH',
  AVAX: 'AVAX', TON: 'TON', SUI: 'SUI', APT: 'APT',
}

const STATUS_LABELS: Record<string, string> = {
  payment_pending:  'Awaiting Payment',
  payment_uploaded: 'Proof Submitted',
  payment_verified: 'Payment Verified',
  payment_detected: 'Payment Confirmed',
  sending:          'Delivering Gas...',
  delivered:        'Completed',
  failed:           'Failed',
  expired:          'Expired',
  refund_pending:   'Refund Processing',
  refunded:         'Refunded',
}

const TIMELINE_STEPS = [
  { label: 'Order Created',     desc: 'Order placed successfully' },
  { label: 'Payment Submitted', desc: 'Proof or transaction hash received' },
  { label: 'Payment Verified',  desc: 'Payment confirmed' },
  { label: 'Releasing Gas',     desc: 'Gas fee being sent to your wallet' },
  { label: 'Completed',         desc: 'Gas delivered to your wallet' },
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

function explorerUrl(network: string, hash: string): string {
  const base = EXPLORER_TX[network?.toUpperCase()]
  if (!base) return '#'
  // Aptos payment tx hashes are synthetic (aptos:{version}:{idx}); link by version.
  const aptosVer = /^aptos:(\d+):/.exec(hash)
  if (aptosVer) return `${base}/${aptosVer[1]}`
  return `${base}/${hash}`
}

function truncateHash(hash: string): string {
  if (hash.length <= 20) return hash
  return `${hash.slice(0, 10)}...${hash.slice(-8)}`
}

function statusVariant(s: string): 'success' | 'danger' | 'warning' | 'default' {
  if (s === 'delivered' || s === 'refunded') return 'success'
  if (s === 'failed' || s === 'expired') return 'danger'
  if (['payment_uploaded', 'payment_verified', 'payment_detected', 'sending', 'refund_pending'].includes(s)) return 'warning'
  return 'default'
}

function isActiveStatus(s: string): boolean {
  return ['payment_pending', 'payment_uploaded', 'payment_verified', 'payment_detected', 'sending', 'refund_pending'].includes(s)
}

function getTimelineStep(status: string): number {
  if (status === 'payment_pending') return 0
  if (status === 'payment_uploaded') return 1
  if (status === 'payment_verified') return 2
  if (status === 'payment_detected') return 2
  if (status === 'sending') return 3
  if (status === 'delivered') return 4
  return 0
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function TxRow({ label, hash, network }: { label: string; hash: string; network: string }) {
  const url = explorerUrl(network, hash)
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3 py-3 border-b border-border last:border-0">
      <span className="sm:w-36 shrink-0 text-xs text-text-muted font-medium">{label}</span>
      <div className="flex items-center gap-2 min-w-0 flex-wrap">
        <span className="text-xs font-mono text-text-primary break-all" title={hash}>{truncateHash(hash)}</span>
        <CopyButton text={hash} size="sm" />
        {url !== '#' && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 font-medium whitespace-nowrap"
          >
            View on Explorer
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
        )}
      </div>
    </div>
  )
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-start gap-0.5 sm:gap-4 py-2.5 border-b border-border last:border-0">
      <span className="sm:w-36 shrink-0 text-xs text-text-muted font-medium">{label}</span>
      <span className="text-sm text-text-primary break-words">{value}</span>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function GasOrderTrackingPageInner() {
  const params = useParams()
  const router = useRouter()
  const searchParams = useSearchParams()
  const orderRef = params.orderRef as string
  const trackingToken = searchParams.get('token') ?? undefined
  const { user, isLoading: authLoading } = useAuth()

  const [order, setOrder] = useState<GasOrder | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [accessDenied, setAccessDenied] = useState(false)

  const fetchOrder = useCallback(async () => {
    try {
      const data = await gasApi.getOrder(orderRef, trackingToken)
      setOrder(data)
      setError('')
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setAccessDenied(true)
      } else {
        setError(err instanceof Error ? err.message : 'Failed to load order')
      }
    } finally {
      setLoading(false)
    }
  }, [orderRef, trackingToken])

  useEffect(() => { fetchOrder() }, [fetchOrder])

  // Ownership check: if logged in and order belongs to a different user, deny access
  useEffect(() => {
    if (!authLoading && order && user && order.userId && order.userId !== user.id) {
      setAccessDenied(true)
    }
  }, [authLoading, order, user])

  const isActive = order ? isActiveStatus(order.status) : false
  usePolling(fetchOrder, 10_000, isActive && !accessDenied)

  if (loading) return <LoadingState message="Loading order..." />

  if (accessDenied) return (
    <div className="min-h-screen bg-canvas flex items-center justify-center px-4">
      <div className="bg-surface shadow-card rounded-xl border border-border p-8 max-w-sm w-full text-center space-y-4">
        <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center mx-auto">
          <svg className="w-6 h-6 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
          </svg>
        </div>
        <h2 className="text-lg font-bold text-text-primary">Access Denied</h2>
        <p className="text-sm text-text-muted">You don&apos;t have permission to view this order. Please use the original tracking link.</p>
        <Link href="/gas/orders">
          <Button variant="secondary" className="w-full">My Orders</Button>
        </Link>
      </div>
    </div>
  )

  if (error || !order) return <ErrorState title={error || 'Order not found'} onRetry={fetchOrder} />

  const isPkr = order.paymentCoin === 'PKR'
  const nativeSymbol = order.nativeSymbol ?? NATIVE_SYMBOLS[order.chain] ?? order.chain
  const step = getTimelineStep(order.status)
  const isTerminal = ['failed', 'expired', 'refunded'].includes(order.status)
  const paymentNetwork = isPkr ? null : (order.paymentNetwork ?? order.chain)

  return (
    <div className="min-h-screen bg-canvas">
      <div className="max-w-2xl mx-auto px-4 py-8 space-y-5">

        {/* Nav row */}
        <div className="flex items-center justify-between">
          <Link
            href="/gas/orders"
            className="flex items-center gap-1.5 text-sm text-text-muted hover:text-text-secondary transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Back to Gas Orders
          </Link>
          <Link href="/gas" className="text-xs text-primary font-semibold hover:underline">
            New Order
          </Link>
        </div>

        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-orange-400 to-amber-500 flex items-center justify-center text-white shrink-0">
              <Fuel size={20} />
            </div>
            <div>
              <h1 className="text-xl font-bold text-text-primary font-mono">{order.orderRef}</h1>
              <p className="text-sm text-text-muted mt-0.5">
                {order.status === 'delivered' ? '⛽ Gas delivered to your wallet' : 'Gas Fee Order'}
              </p>
            </div>
          </div>
          <Badge variant={statusVariant(order.status)} size="md">
            {STATUS_LABELS[order.status] ?? order.status}
          </Badge>
        </div>

        {/* Timeline */}
        <div className="bg-surface shadow-card rounded-xl border border-border p-5">
          <h2 className="text-xs font-bold text-text-muted uppercase tracking-wider mb-4">Order Status</h2>

          {order.status === 'expired' && (
            <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-sm text-red-700 dark:text-red-300">
              This order expired before payment was received. Please create a new order.
            </div>
          )}
          {order.status === 'failed' && (
            <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-sm text-red-700 dark:text-red-300">
              This order failed. Contact support if you already sent payment.
            </div>
          )}
          {order.status === 'refunded' && (
            <div className="mb-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-sm text-amber-700 dark:text-amber-300">
              This order has been refunded.
            </div>
          )}

          {order.status === 'payment_uploaded' && (
            <div className="mb-4 p-3 rounded-lg bg-warning/10 border border-warning/20 text-sm text-warning">
              Your payment is under review. An admin will verify and release your gas shortly (usually 30–60 min during business hours).
            </div>
          )}

          <div>
            {TIMELINE_STEPS.map((s, i) => {
              const done = !isTerminal && i < step
              const cur  = !isTerminal && i === step
              return (
                <div key={s.label} className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 transition-all ${
                      done ? 'bg-green-500 text-white'
                      : cur  ? 'bg-primary text-white ring-4 ring-primary/20'
                      : 'bg-surface-alt text-text-disabled'
                    }`}>
                      {done
                        ? <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                        : cur
                        ? <div className="w-3 h-3 rounded-full bg-white animate-pulse" />
                        : <span className="text-xs font-bold">{i + 1}</span>
                      }
                    </div>
                    {i < TIMELINE_STEPS.length - 1 && (
                      <div className={`w-0.5 h-8 my-0.5 ${done ? 'bg-green-300' : 'bg-border'}`} />
                    )}
                  </div>
                  <div className="pb-3 flex-1 min-w-0 pt-1">
                    <p className={`text-sm font-semibold ${
                      done ? 'text-green-700 dark:text-green-300'
                      : cur  ? 'text-primary'
                      : 'text-text-muted'
                    }`}>
                      {s.label}
                    </p>
                    {(done || cur) && (
                      <p className="text-xs text-text-muted mt-0.5">{s.desc}</p>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Resume payment / cancel — only for unpaid orders */}
        <GasOrderActions order={order} trackingToken={trackingToken} onChanged={fetchOrder} />

        {/* Order Details */}
        <div className="bg-surface shadow-card rounded-xl border border-border p-5">
          <h2 className="text-xs font-bold text-text-muted uppercase tracking-wider mb-3">Order Details</h2>
          <DetailRow label="Reference" value={<span className="font-mono text-xs">{order.orderRef}</span>} />
          <DetailRow label="Chain" value={<span className="font-medium">{order.chain}</span>} />
          <DetailRow
            label="Gas Amount"
            value={`${parseFloat(order.gasAmountNative).toFixed(6)} ${nativeSymbol}`}
          />
          <DetailRow
            label="Payment Method"
            value={
              <span className="inline-flex items-center gap-1.5">
                {isPkr && order.pkrPaymentMethod ? (
                  <EntityLogo type="payment_method" slug={order.pkrPaymentMethod} size="xs" />
                ) : !isPkr ? (
                  <EntityLogo type="chain" slug={order.chain} size="xs" />
                ) : null}
                <span>{isPkr
                  ? `PKR · ${(order.pkrPaymentMethod ?? '').replace(/_/g, ' ')}`
                  : `USDT · ${order.paymentNetwork ?? order.chain}`}
                </span>
              </span>
            }
          />
          <DetailRow
            label="Amount Paid"
            value={isPkr
              ? `PKR ${order.pkrAmount ? parseFloat(order.pkrAmount).toFixed(0) : '—'} (≈ ${parseFloat(order.paymentAmount).toFixed(2)} USDT)`
              : `${parseFloat(order.paymentAmount).toFixed(4)} USDT`}
          />
          <DetailRow
            label="Receiving Wallet"
            value={
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono text-xs break-all">{order.toAddress}</span>
                <CopyButton text={order.toAddress} size="sm" />
              </div>
            }
          />
          {order.createdAt && (
            <DetailRow
              label="Created"
              value={new Date(order.createdAt).toLocaleString('en-PK', { dateStyle: 'medium', timeStyle: 'short' })}
            />
          )}
        </div>

        {/* Transactions */}
        {(order.paymentTxHash || order.deliveryTxHash || order.refundTxHash) && (
          <div className="bg-surface shadow-card rounded-xl border border-border p-5">
            <h2 className="text-xs font-bold text-text-muted uppercase tracking-wider mb-2">Transactions</h2>
            {order.paymentTxHash && paymentNetwork && (
              <TxRow label="Payment Tx" hash={order.paymentTxHash} network={paymentNetwork} />
            )}
            {order.deliveryTxHash && (
              <TxRow label="Delivery Tx" hash={order.deliveryTxHash} network={order.chain} />
            )}
            {order.refundTxHash && (
              <TxRow label="Refund Tx" hash={order.refundTxHash} network={order.paymentNetwork ?? order.chain} />
            )}
          </div>
        )}

        {/* PKR payment proof */}
        {isPkr && order.paymentProofUrl && (
          <div className="bg-surface shadow-card rounded-xl border border-border p-5">
            <h2 className="text-xs font-bold text-text-muted uppercase tracking-wider mb-3">Payment Proof</h2>
            <a
              href={order.paymentProofUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline font-medium"
            >
              View Screenshot
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </a>
          </div>
        )}

        {/* Footer actions */}
        <div className="flex gap-3 pb-6">
          <Link href="/gas/orders" className="flex-1">
            <Button variant="secondary" className="w-full">All Orders</Button>
          </Link>
          <Link href="/gas" className="flex-1">
            <Button className="w-full">New Order</Button>
          </Link>
        </div>
      </div>
    </div>
  )
}

// useSearchParams requires Suspense in Next.js App Router
export default function GasOrderTrackingPage() {
  return (
    <Suspense fallback={<LoadingState message="Loading order..." />}>
      <GasOrderTrackingPageInner />
    </Suspense>
  )
}
