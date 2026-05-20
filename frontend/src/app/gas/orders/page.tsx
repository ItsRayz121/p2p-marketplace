'use client'
import { useEffect, useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@/hooks/useAuth'
import { apiRequest } from '@/lib/api'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { usePolling } from '@/hooks/usePolling'

// ─── Types ────────────────────────────────────────────────────────────────────

interface GasHistoryOrder {
  orderRef: string
  chain: string
  tier: string
  gasAmountNative: string
  paymentAmount: string
  paymentNetwork: string
  toAddress: string
  deliveryTxHash?: string
  refundTxHash?: string
  status: string
  createdAt: string
  deliveredAt?: string
  refundedAt?: string
}

interface HistoryResponse {
  orders: GasHistoryOrder[]
  pagination: {
    page: number
    limit: number
    total: number
    totalPages: number
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function statusVariant(s: string): 'warning' | 'success' | 'danger' | 'default' {
  if (s === 'delivered') return 'success'
  if (s === 'refunded') return 'success'
  if (s === 'failed' || s === 'expired') return 'danger'
  if (s === 'payment_detected' || s === 'sending' || s === 'refund_pending') return 'warning'
  return 'default'
}

const STATUS_LABELS: Record<string, string> = {
  payment_pending:  'Awaiting Payment',
  payment_detected: 'Payment Detected',
  sending:          'Delivering...',
  delivered:        'Delivered',
  failed:           'Failed',
  expired:          'Expired',
  refund_pending:   'Refund Processing',
  refunded:         'Refunded',
}

const NATIVE_SYMBOLS: Record<string, string> = {
  TRON:  'TRX',
  BSC:   'BNB',
  ETH:   'ETH',
  SOL:   'SOL',
  MATIC: 'POL',
  ARB:   'ETH',
  BASE:  'ETH',
  OP:    'ETH',
  AVAX:  'AVAX',
  TON:   'TON',
  SUI:   'SUI',
  APT:   'APT',
}

const EXPLORER_TX: Record<string, string> = {
  TRON:  'https://tronscan.org/#/transaction',
  BSC:   'https://bscscan.com/tx',
  ETH:   'https://etherscan.io/tx',
  SOL:   'https://solscan.io/tx',
  MATIC: 'https://polygonscan.com/tx',
  ARB:   'https://arbiscan.io/tx',
  BASE:  'https://basescan.org/tx',
  OP:    'https://optimistic.etherscan.io/tx',
  AVAX:  'https://snowtrace.io/tx',
  TON:   'https://tonscan.org/tx',
  SUI:   'https://suiexplorer.com/txblock',
  APT:   'https://explorer.aptoslabs.com/txn',
}

function explorerTxUrl(chain: string, txHash: string): string {
  const base = EXPLORER_TX[chain.toUpperCase()]
  if (!base) return '#'
  return `${base}/${txHash}`
}

function isInProgress(status: string): boolean {
  return ['payment_pending', 'payment_detected', 'sending', 'refund_pending'].includes(status)
}

// ─── Row ─────────────────────────────────────────────────────────────────────

function OrderRow({ order }: { order: GasHistoryOrder }) {
  const symbol = NATIVE_SYMBOLS[order.chain] ?? order.chain
  const date = new Date(order.createdAt).toLocaleDateString('en-PK', {
    day: '2-digit', month: 'short', year: 'numeric',
  })

  return (
    <div className="grid grid-cols-[1fr_auto_auto_auto] sm:grid-cols-[1.5fr_1fr_1fr_1fr_auto] gap-2 sm:gap-4 items-center p-4 border-b border-border last:border-0 hover:bg-surface transition-colors">
      {/* Date + ref + address */}
      <div className="min-w-0">
        <p className="text-xs text-text-muted">{date}</p>
        <p className="text-sm font-mono font-medium text-text-primary truncate">{order.orderRef}</p>
        <p className="text-xs text-text-muted truncate">{order.toAddress}</p>
      </div>

      {/* Chain + tier — hidden on mobile */}
      <div className="hidden sm:block text-sm text-text-secondary">
        <span className="font-medium">{order.chain}</span>
        <span className="text-text-muted ml-1 text-xs">/ {order.tier}</span>
      </div>

      {/* Amount */}
      <div className="text-right sm:text-left">
        <p className="text-sm font-semibold text-text-primary">{parseFloat(order.gasAmountNative).toFixed(2)} {symbol}</p>
        <p className="text-xs text-text-muted">{parseFloat(order.paymentAmount).toFixed(2)} USDT</p>
      </div>

      {/* Status */}
      <div>
        <Badge variant={statusVariant(order.status)} size="sm">
          {STATUS_LABELS[order.status] ?? order.status}
        </Badge>
      </div>

      {/* Tx links */}
      <div className="flex flex-col gap-1 items-end">
        {order.deliveryTxHash && (
          <a
            href={explorerTxUrl(order.chain, order.deliveryTxHash)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-primary hover:underline flex items-center gap-1"
          >
            TX
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
        )}
        {order.refundTxHash && (
          <a
            href={explorerTxUrl(order.chain, order.refundTxHash)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-success hover:underline flex items-center gap-1"
          >
            Refund TX
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
        )}
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function GasOrdersPage() {
  const router = useRouter()
  const { user, isLoading: authLoading } = useAuth()

  const [data, setData] = useState<HistoryResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [page, setPage] = useState(1)

  const fetchHistory = useCallback(async (p = page) => {
    if (!user) return
    setLoading(true)
    setError('')
    try {
      const res = await apiRequest<HistoryResponse>(`/gas-fee/orders/history?page=${p}&limit=20`)
      setData(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load order history')
    } finally {
      setLoading(false)
    }
  }, [user, page])

  // Redirect unauthenticated visitors
  useEffect(() => {
    if (!authLoading && !user) {
      router.replace('/login?next=/gas/orders')
    }
  }, [authLoading, user, router])

  useEffect(() => {
    if (user) fetchHistory(page)
  }, [user, page]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-refresh while any order is in progress
  const hasInProgress = data?.orders.some((o) => isInProgress(o.status)) ?? false
  usePolling(() => fetchHistory(page), 30_000, hasInProgress)

  if (authLoading) {
    return <LoadingState message="Loading..." />
  }

  if (!user) return null

  const pagination = data?.pagination

  return (
    <div className="min-h-screen bg-surface">
      <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-text-primary">Gas Order History</h1>
            <p className="text-sm text-text-muted mt-0.5">All your past gas fee orders</p>
          </div>
          <Link href="/gas">
            <Button variant="secondary" size="sm">New Order</Button>
          </Link>
        </div>

        {/* Table */}
        <div className="bg-white rounded-xl border border-border overflow-hidden">
          {/* Column headers — hidden on mobile */}
          <div className="hidden sm:grid sm:grid-cols-[1.5fr_1fr_1fr_1fr_auto] gap-4 px-4 py-3 bg-surface border-b border-border text-xs font-medium text-text-muted uppercase tracking-wider">
            <span>Order</span>
            <span>Chain / Tier</span>
            <span>Amount</span>
            <span>Status</span>
            <span>Links</span>
          </div>

          {loading && !data && <LoadingState message="Loading orders..." />}
          {error && <ErrorState title={error} onRetry={() => fetchHistory(page)} />}

          {data && data.orders.length === 0 && (
            <div className="py-16 text-center">
              <p className="text-text-muted text-sm">No gas orders yet.</p>
              <Link href="/gas" className="mt-3 inline-block text-primary text-sm hover:underline">
                Place your first order →
              </Link>
            </div>
          )}

          {data?.orders.map((order) => (
            <OrderRow key={order.orderRef} order={order} />
          ))}
        </div>

        {/* Pagination */}
        {pagination && pagination.totalPages > 1 && (
          <div className="flex items-center justify-between">
            <p className="text-sm text-text-muted">
              {pagination.total} orders · Page {pagination.page} of {pagination.totalPages}
            </p>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={page >= pagination.totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
