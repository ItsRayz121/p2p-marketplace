'use client'
import { useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { instantBuyApi } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Badge } from '@/components/ui/Badge'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Order {
  id: string
  status: string
  coin: string
  amount: string
  amountPkr: string
  txHash?: string
  createdAt: string
}

const STATUS_STEPS = [
  { key: 'order_created', label: 'Order Created' },
  { key: 'payment_received', label: 'Payment Received' },
  { key: 'processing', label: 'Processing' },
  { key: 'completed', label: 'Completed' },
]

function getStepIndex(status: string): number {
  if (status === 'completed') return 3
  if (status === 'processing' || status === 'delivery_in_progress') return 2
  if (status === 'payment_received' || status === 'proof_submitted') return 1
  return 0
}

function statusVariant(s: string): 'warning' | 'success' | 'danger' | 'default' {
  if (s === 'completed') return 'success'
  if (s === 'failed' || s === 'expired') return 'danger'
  if (s === 'processing' || s === 'delivery_in_progress') return 'warning'
  return 'default'
}

function explorerLink(txHash: string, coin: string): string {
  if (coin === 'TRX' || coin === 'USDT') return `https://tronscan.org/#/transaction/${txHash}`
  if (coin === 'BTC') return `https://blockstream.info/tx/${txHash}`
  if (coin === 'ETH') return `https://etherscan.io/tx/${txHash}`
  if (coin === 'BNB') return `https://bscscan.com/tx/${txHash}`
  return '#'
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function InstantBuyStatusPage() {
  const { id } = useParams<{ id: string }>()
  const [order, setOrder] = useState<Order | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const fetchOrder = useCallback(async () => {
    try {
      const o = await instantBuyApi.getOrder(id)
      setOrder(o as Order)
    } catch (err) {
      if (loading) setError(err instanceof Error ? err.message : 'Failed to load order')
    } finally {
      setLoading(false)
    }
  }, [id, loading])

  const isDone = order?.status === 'completed' || order?.status === 'failed' || order?.status === 'expired'
  usePolling(fetchOrder, 15_000, !isDone)

  if (loading) return <LoadingState message="Loading order status..." />
  if (error || !order) return <ErrorState title={error || 'Order not found'} onRetry={fetchOrder} />

  const stepIdx = getStepIndex(order.status)

  return (
    <div className="max-w-lg mx-auto px-4 py-6 space-y-5">
      <div>
        <h1 className="text-xl font-bold text-text-primary">Order Status</h1>
        <p className="text-sm text-text-muted">Order #{order.id.slice(0, 8)}</p>
      </div>

      {/* Progress Bar */}
      <div className="bg-surface shadow-card border border-border rounded-xl p-5">
        <div className="relative flex justify-between">
          {/* Connecting line */}
          <div className="absolute top-4 left-4 right-4 h-0.5 bg-border" />
          <div
            className="absolute top-4 left-4 h-0.5 bg-primary transition-all duration-500"
            style={{ width: `${(stepIdx / (STATUS_STEPS.length - 1)) * (100 - (8 / STATUS_STEPS.length) * 100)}%` }}
          />
          {STATUS_STEPS.map((step, i) => {
            const done = i < stepIdx
            const active = i === stepIdx
            return (
              <div key={step.key} className="relative flex flex-col items-center gap-2 z-10">
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold border-2 transition-colors ${
                    done
                      ? 'bg-primary border-primary text-white'
                      : active
                      ? 'bg-surface border-primary text-primary'
                      : 'bg-surface border-border text-text-muted'
                  }`}
                >
                  {done ? (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    i + 1
                  )}
                </div>
                <span className={`text-xs text-center max-w-[60px] ${active ? 'text-primary font-semibold' : done ? 'text-text-primary' : 'text-text-muted'}`}>
                  {step.label}
                </span>
              </div>
            )
          })}
        </div>
      </div>

      {/* Order Details */}
      <div className="bg-surface shadow-card border border-border rounded-xl p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-primary">Order Details</h2>
          <Badge variant={statusVariant(order.status)} size="sm">
            {order.status.replace(/_/g, ' ')}
          </Badge>
        </div>
        <div className="divide-y divide-border">
          {[
            { label: 'Coin', value: order.coin },
            { label: 'Amount', value: `${parseFloat(order.amount).toFixed(6)} ${order.coin}` },
            { label: 'PKR Amount', value: `PKR ${parseFloat(order.amountPkr).toLocaleString()}` },
            { label: 'Created', value: new Date(order.createdAt).toLocaleString() },
          ].map((row) => (
            <div key={row.label} className="flex justify-between py-2.5 text-sm">
              <span className="text-text-muted">{row.label}</span>
              <span className="font-semibold text-text-primary">{row.value}</span>
            </div>
          ))}
        </div>
      </div>

      {/* TX Hash */}
      {order.txHash && (
        <div className="bg-surface shadow-card border border-border rounded-xl p-5 space-y-2">
          <h2 className="text-sm font-semibold text-text-primary">Transaction Hash</h2>
          <p className="text-xs font-mono text-text-primary break-all">{order.txHash}</p>
          <a
            href={explorerLink(order.txHash, order.coin)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-primary text-sm underline"
          >
            View on Block Explorer
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
        </div>
      )}

      {order.status === 'completed' && (
        <div className="bg-success/10 border border-success/30 rounded-xl p-5 text-center">
          <svg className="w-10 h-10 mx-auto text-success mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-base font-bold text-success">Order Completed!</p>
          <p className="text-sm text-text-muted mt-1">Your {order.coin} has been delivered successfully.</p>
        </div>
      )}
    </div>
  )
}
