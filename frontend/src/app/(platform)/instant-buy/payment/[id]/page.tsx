'use client'
import { useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { instantBuyApi, marketplaceApi, apiRequest } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'
import { useFileUpload } from '@/hooks/useFileUpload'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { CountdownTimer } from '@/components/ui/CountdownTimer'
import { Spinner } from '@/components/ui/Spinner'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Order {
  id: string
  status: string
  coin: string
  amount: string
  amountPkr: string
  expiresAt: string
  createdAt: string
}

interface PlatformConfig {
  jazzCashNumber?: string
  easypaisaNumber?: string
  bankName?: string
  bankAccount?: string
  bankIban?: string
  accountTitle?: string
}

function statusVariant(s: string): 'warning' | 'success' | 'danger' | 'default' {
  if (s === 'completed') return 'success'
  if (s === 'failed' || s === 'expired') return 'danger'
  if (s === 'payment_pending') return 'warning'
  return 'default'
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function InstantBuyPaymentPage() {
  const { id } = useParams<{ id: string }>()
  const [order, setOrder] = useState<Order | null>(null)
  const [config, setConfig] = useState<PlatformConfig>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [proofUrl, setProofUrl] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitDone, setSubmitDone] = useState(false)
  const [submitError, setSubmitError] = useState('')

  const { upload, uploading, error: uploadError } = useFileUpload('payment-proof')

  const fetchOrder = useCallback(async () => {
    try {
      const [o, cfg] = await Promise.all([
        instantBuyApi.getOrder(id),
        marketplaceApi.getConfig(),
      ])
      setOrder(o as Order)
      setConfig((cfg as PlatformConfig) ?? {})
    } catch (err) {
      if (loading) setError(err instanceof Error ? err.message : 'Failed to load order')
    } finally {
      setLoading(false)
    }
  }, [id, loading])

  usePolling(fetchOrder, 15_000, !submitDone && order?.status === 'payment_pending')

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const url = await upload(file)
      setProofUrl(url)
    } catch { /* handled by hook */ }
  }

  const handleSubmitProof = async () => {
    if (!proofUrl) return
    setSubmitting(true)
    setSubmitError('')
    try {
      await apiRequest(`/instant-buy/orders/${id}/proof`, {
        method: 'POST',
        body: JSON.stringify({ proofUrl }),
      })
      setSubmitDone(true)
      setOrder((o) => o ? { ...o, status: 'proof_submitted' } : o)
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to submit proof')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return <LoadingState message="Loading order..." />
  if (error || !order) return <ErrorState title={error || 'Order not found'} onRetry={fetchOrder} />

  const pkrAmount = parseFloat(order.amountPkr).toLocaleString()

  return (
    <div className="max-w-lg mx-auto px-4 py-6 pb-24 lg:pb-6 space-y-5">
      <div>
        <h1 className="text-xl font-bold text-text-primary">Payment Instructions</h1>
        <p className="text-sm text-text-muted">Complete payment within the time limit</p>
      </div>

      {/* Order Summary */}
      <div className="bg-white border border-border rounded-xl p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-primary">Order Summary</h2>
          <Badge variant={statusVariant(order.status)} size="sm">
            {order.status.replace(/_/g, ' ')}
          </Badge>
        </div>
        <div className="divide-y divide-border">
          {[
            { label: 'Order ID', value: order.id.slice(0, 8) + '...' },
            { label: 'Coin', value: order.coin },
            { label: 'Crypto Amount', value: `${parseFloat(order.amount).toFixed(6)} ${order.coin}` },
            { label: 'PKR to Pay', value: `PKR ${pkrAmount}` },
          ].map((row) => (
            <div key={row.label} className="flex justify-between py-2.5 text-sm">
              <span className="text-text-muted">{row.label}</span>
              <span className="font-semibold text-text-primary">{row.value}</span>
            </div>
          ))}
        </div>
        <div className="bg-surface rounded-lg p-3 flex items-center justify-between">
          <span className="text-xs text-text-muted">Time Remaining</span>
          <CountdownTimer expiresAt={order.expiresAt} showLabel={false} />
        </div>
      </div>

      {/* Payment Details */}
      <div className="bg-white border border-border rounded-xl p-5 space-y-4">
        <h2 className="text-sm font-semibold text-text-primary">Where to Send</h2>
        <div className="bg-primary/5 border border-primary/20 rounded-lg p-4 text-sm text-text-primary">
          <p className="font-bold text-base mb-3">Transfer <span className="text-primary">PKR {pkrAmount}</span> via:</p>
          <div className="space-y-2 text-sm">
            {config.jazzCashNumber && (
              <div className="flex justify-between">
                <span className="text-text-muted">JazzCash</span>
                <span className="font-mono font-semibold">{config.jazzCashNumber}</span>
              </div>
            )}
            {config.easypaisaNumber && (
              <div className="flex justify-between">
                <span className="text-text-muted">Easypaisa</span>
                <span className="font-mono font-semibold">{config.easypaisaNumber}</span>
              </div>
            )}
            {config.bankName && (
              <>
                <div className="flex justify-between">
                  <span className="text-text-muted">Bank</span>
                  <span className="font-semibold">{config.bankName}</span>
                </div>
                {config.accountTitle && (
                  <div className="flex justify-between">
                    <span className="text-text-muted">Account Title</span>
                    <span className="font-semibold">{config.accountTitle}</span>
                  </div>
                )}
                {config.bankAccount && (
                  <div className="flex justify-between">
                    <span className="text-text-muted">Account #</span>
                    <span className="font-mono font-semibold">{config.bankAccount}</span>
                  </div>
                )}
                {config.bankIban && (
                  <div className="flex justify-between">
                    <span className="text-text-muted">IBAN</span>
                    <span className="font-mono font-semibold text-xs">{config.bankIban}</span>
                  </div>
                )}
              </>
            )}
            {!config.jazzCashNumber && !config.easypaisaNumber && !config.bankName && (
              <p className="text-text-muted italic">Payment details will be provided by support. Please contact us.</p>
            )}
          </div>
        </div>
        <p className="text-xs text-warning font-medium">
          Important: Use your registered name as the transfer description
        </p>
      </div>

      {/* Upload Proof */}
      {!submitDone && order.status !== 'completed' && order.status !== 'failed' && (
        <div className="bg-white border border-border rounded-xl p-5 space-y-4">
          <h2 className="text-sm font-semibold text-text-primary">Upload Payment Proof</h2>
          <p className="text-xs text-text-muted">Take a screenshot of your payment confirmation and upload it here.</p>

          <label className="flex flex-col items-center justify-center border-2 border-dashed border-border rounded-xl p-6 cursor-pointer hover:border-primary/50 transition-colors">
            <div className="text-text-muted text-center">
              {uploading ? (
                <><Spinner size="sm" /><p className="text-sm mt-2">Uploading...</p></>
              ) : proofUrl ? (
                <>
                  <svg className="w-8 h-8 mx-auto text-success mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <p className="text-sm text-success font-medium">Screenshot uploaded</p>
                  <p className="text-xs text-text-muted mt-1">Click to change</p>
                </>
              ) : (
                <>
                  <svg className="w-8 h-8 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
                  <p className="text-sm">Tap to upload screenshot</p>
                  <p className="text-xs mt-1">JPEG, PNG, WebP — max 10MB</p>
                </>
              )}
            </div>
            <input type="file" accept="image/*" className="hidden" onChange={handleFileChange} disabled={uploading} />
          </label>

          {(uploadError || submitError) && (
            <p className="text-sm text-danger">{uploadError || submitError}</p>
          )}

          <Button
            className="w-full"
            disabled={!proofUrl || submitting || uploading}
            onClick={handleSubmitProof}
          >
            {submitting ? <Spinner size="sm" /> : 'Submit Payment Proof'}
          </Button>
        </div>
      )}

      {submitDone && (
        <div className="bg-success/10 border border-success/30 rounded-xl p-5 text-center">
          <svg className="w-10 h-10 mx-auto text-success mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-base font-bold text-text-primary mb-1">Proof Submitted!</p>
          <p className="text-sm text-text-muted">Our team will verify your payment and release crypto shortly.</p>
        </div>
      )}

      {order.status === 'completed' && (
        <div className="bg-success/10 border border-success/30 rounded-xl p-5 text-center">
          <p className="text-base font-bold text-success">Payment Confirmed!</p>
          <p className="text-sm text-text-muted mt-1">Your {order.coin} has been sent to your wallet.</p>
        </div>
      )}
    </div>
  )
}
