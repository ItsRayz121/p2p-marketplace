'use client'
import { useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { instantBuyApi, apiRequest } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { CountdownTimer } from '@/components/ui/CountdownTimer'
import { CopyButton } from '@/components/ui/CopyButton'
import { Spinner } from '@/components/ui/Spinner'

// ─── Types ────────────────────────────────────────────────────────────────────

interface CryptoOrder {
  id: string
  status: string
  coin: string
  network: string
  amount: string
  depositAddress: string
  txHash?: string
  expiresAt: string
  createdAt: string
}

function statusVariant(s: string): 'warning' | 'success' | 'danger' | 'default' {
  if (s === 'completed') return 'success'
  if (s === 'failed' || s === 'expired') return 'danger'
  if (s === 'detected' || s === 'processing' || s === 'delivery_in_progress') return 'warning'
  return 'default'
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function CryptoDepositPage() {
  const { id } = useParams<{ id: string }>()
  const [order, setOrder] = useState<CryptoOrder | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [txHash, setTxHash] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [submitDone, setSubmitDone] = useState(false)

  const fetchOrder = useCallback(async () => {
    try {
      const o = await instantBuyApi.getOrder(id)
      setOrder(o as unknown as CryptoOrder)
    } catch (err) {
      if (loading) setError(err instanceof Error ? err.message : 'Failed to load order')
    } finally {
      setLoading(false)
    }
  }, [id, loading])

  const isDone = order?.status === 'completed' || order?.status === 'failed' || order?.status === 'expired'
  usePolling(fetchOrder, 15_000, !isDone)

  const handleConfirmDeposit = async () => {
    if (!txHash.trim()) return
    setSubmitting(true)
    setSubmitError('')
    try {
      await apiRequest(`/instant-buy/orders/${id}/confirm-deposit`, {
        method: 'POST',
        body: JSON.stringify({ txHash: txHash.trim() }),
      })
      setSubmitDone(true)
      setOrder((o) => o ? { ...o, status: 'detected', txHash: txHash.trim() } : o)
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to confirm deposit')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return <LoadingState message="Loading deposit details..." />
  if (error || !order) return <ErrorState title={error || 'Order not found'} onRetry={fetchOrder} />

  const explorerBase = order.network?.includes('TRC') ? 'https://tronscan.org/#/transaction/' :
    order.network?.includes('ERC') ? 'https://etherscan.io/tx/' :
    order.network?.includes('BEP') ? 'https://bscscan.com/tx/' : null

  return (
    <div className="max-w-lg mx-auto px-4 py-6 space-y-5">
      <div>
        <h1 className="text-xl font-bold text-text-primary">Crypto Deposit</h1>
        <p className="text-sm text-text-muted">Send exactly the required amount to the address below</p>
      </div>

      {/* Status + Timer */}
      <div className="bg-white border border-border rounded-xl p-5 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-text-primary">Order Status</span>
          <Badge variant={statusVariant(order.status)} size="sm">
            {order.status.replace(/_/g, ' ')}
          </Badge>
        </div>
        <div className="bg-surface rounded-lg p-3 flex items-center justify-between">
          <span className="text-xs text-text-muted">Expires In</span>
          <CountdownTimer expiresAt={order.expiresAt} showLabel={false} />
        </div>
      </div>

      {/* Deposit Instructions */}
      {order.status !== 'completed' && order.status !== 'expired' && (
        <div className="bg-white border border-border rounded-xl p-5 space-y-4">
          <h2 className="text-sm font-semibold text-text-primary">Deposit Instructions</h2>

          {/* Network Warning */}
          <div className="bg-warning/10 border border-warning/30 rounded-lg p-3">
            <p className="text-sm text-warning font-semibold">
              Send only on {order.network} network
            </p>
            <p className="text-xs text-text-muted mt-1">
              Sending on the wrong network will result in permanent loss of funds.
            </p>
          </div>

          {/* Amount */}
          <div className="bg-surface rounded-lg p-3">
            <p className="text-xs text-text-muted mb-1">Exact Amount to Send</p>
            <div className="flex items-center justify-between">
              <p className="text-lg font-bold text-text-primary">
                {parseFloat(order.amount).toFixed(6)} {order.coin}
              </p>
              <CopyButton text={order.amount} />
            </div>
          </div>

          {/* Address */}
          {order.depositAddress && (
            <div>
              <p className="text-xs font-medium text-text-muted mb-1.5">Deposit Address ({order.network})</p>
              <div className="bg-surface rounded-lg p-3 flex items-start gap-2">
                <p className="text-sm font-mono text-text-primary break-all flex-1">{order.depositAddress}</p>
                <CopyButton text={order.depositAddress} />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Already Sent? Manual TX Hash */}
      {!submitDone && order.status !== 'completed' && order.status !== 'expired' && order.status !== 'detected' && (
        <div className="bg-white border border-border rounded-xl p-5 space-y-4">
          <h2 className="text-sm font-semibold text-text-primary">Already Sent?</h2>
          <p className="text-xs text-text-muted">If you have already sent the crypto, enter the transaction hash to speed up processing.</p>
          <Input
            placeholder="Enter transaction hash (0x...)"
            value={txHash}
            onChange={(e) => setTxHash(e.target.value)}
          />
          {submitError && <p className="text-sm text-danger">{submitError}</p>}
          <Button
            className="w-full"
            variant="secondary"
            disabled={!txHash.trim() || submitting}
            onClick={handleConfirmDeposit}
          >
            {submitting ? <Spinner size="sm" /> : 'Submit Transaction Hash'}
          </Button>
        </div>
      )}

      {/* Processing */}
      {(order.status === 'detected' || order.status === 'processing' || order.status === 'delivery_in_progress') && (
        <div className="bg-warning/10 border border-warning/30 rounded-xl p-5 text-center">
          <Spinner size="md" />
          <p className="text-base font-bold text-text-primary mt-3 mb-1">Deposit Detected</p>
          <p className="text-sm text-text-muted">Processing your order — this usually takes 1–5 minutes.</p>
        </div>
      )}

      {/* Completed */}
      {order.status === 'completed' && (
        <div className="bg-success/10 border border-success/30 rounded-xl p-5 space-y-3">
          <div className="text-center">
            <svg className="w-10 h-10 mx-auto text-success mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-base font-bold text-success">Order Completed!</p>
            <p className="text-sm text-text-muted mt-1">Your {order.coin} has been processed.</p>
          </div>
          {order.txHash && explorerBase && (
            <a
              href={`${explorerBase}${order.txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-1.5 text-primary text-sm underline"
            >
              View on Explorer
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </a>
          )}
        </div>
      )}

      {order.status === 'expired' && (
        <div className="bg-danger/10 border border-danger/30 rounded-xl p-5 text-center">
          <p className="text-base font-bold text-danger">Order Expired</p>
          <p className="text-sm text-text-muted mt-1">This order has expired. Please create a new order.</p>
          <Button className="mt-4" onClick={() => window.location.href = '/instant-buy'}>
            Try Again
          </Button>
        </div>
      )}
    </div>
  )
}
