'use client'
import { useState, useEffect, useCallback } from 'react'
import { apiRequest } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Badge } from '@/components/ui/Badge'
import { CountdownTimer } from '@/components/ui/CountdownTimer'
import { CopyButton } from '@/components/ui/CopyButton'
import { StalenessBadge } from '@/components/ui/StalenessBadge'
import { Spinner } from '@/components/ui/Spinner'
import { usePolling } from '@/hooks/usePolling'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Tier {
  id: string
  name: 'SMALL' | 'MEDIUM' | 'LARGE'
  trxAmount: number
  usdtPrice: string
  pkrPrice: string
}

// Status values match the backend GasFeeOrderStatus enum exactly
interface GasOrder {
  id: string
  orderRef: string
  status: 'payment_pending' | 'payment_detected' | 'sending' | 'delivered' | 'expired' | 'failed' | 'refunded'
  toAddress: string
  tier: string
  paymentAddress: string
  paymentAmount: string      // backend field name (was usdtAmount — fixed)
  deliveryTxHash?: string   // backend field name (was txHash — fixed)
  expiresAt: string
  createdAt: string
}

interface PricesResponse {
  tiers: Tier[]
  updatedAt: string
}

const TIER_ICONS: Record<string, string> = { SMALL: 'S', MEDIUM: 'M', LARGE: 'L' }
const TRC20_REGEX = /^T[A-Za-z1-9]{33}$/

// ─── Status helpers — keyed on real backend enum values ───────────────────────

function statusVariant(s: string): 'warning' | 'success' | 'danger' | 'default' {
  if (s === 'delivered') return 'success'
  if (s === 'failed' || s === 'expired') return 'danger'
  if (s === 'payment_detected' || s === 'sending') return 'warning'
  return 'default'
}

const STATUS_LABELS: Record<string, string> = {
  payment_pending:  'Awaiting Payment',
  payment_detected: 'Payment Detected',
  sending:          'Delivering TRX...',
  delivered:        'Completed',
  failed:           'Failed',
  expired:          'Expired',
  refunded:         'Refunded',
}

// ─── Step Indicator ───────────────────────────────────────────────────────────

function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center justify-center gap-2 mb-6">
      {Array.from({ length: total }).map((_, i) => (
        <div key={i} className="flex items-center gap-2">
          <div
            className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
              i < current
                ? 'bg-primary text-white'
                : i === current
                ? 'bg-primary text-white ring-2 ring-primary/30'
                : 'bg-surface text-text-muted border border-border'
            }`}
          >
            {i < current ? (
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              i + 1
            )}
          </div>
          {i < total - 1 && (
            <div className={`w-8 h-0.5 ${i < current ? 'bg-primary' : 'bg-border'}`} />
          )}
        </div>
      ))}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function GasPage() {
  const [step, setStep] = useState(0)
  const [tiers, setTiers] = useState<Tier[]>([])
  const [tiersUpdatedAt, setTiersUpdatedAt] = useState('')
  const [tiersLoading, setTiersLoading] = useState(false)
  const [tiersError, setTiersError] = useState('')

  // Step 1
  const [selectedChain] = useState('TRON')

  // Step 2
  const [selectedTier, setSelectedTier] = useState<Tier | null>(null)

  // Step 3
  const [address, setAddress] = useState('')
  const [addressError, setAddressError] = useState('')

  // Step 4
  const [order, setOrder] = useState<GasOrder | null>(null)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')

  // Poll failure tracking — surface connection errors after 3 consecutive failures
  const [pollErrorCount, setPollErrorCount] = useState(0)

  const fetchTiers = useCallback(async () => {
    setTiersLoading(true)
    setTiersError('')
    try {
      const res = await apiRequest<PricesResponse>('/gas-fee/prices')
      setTiers(res.tiers)
      setTiersUpdatedAt(res.updatedAt)
    } catch (err) {
      setTiersError(err instanceof Error ? err.message : 'Failed to load prices')
    } finally {
      setTiersLoading(false)
    }
  }, [])

  useEffect(() => {
    if (step === 1) fetchTiers()
  }, [step, fetchTiers])

  const validateAddress = (val: string) => {
    if (!val) { setAddressError('Address is required'); return false }
    if (!TRC20_REGEX.test(val)) { setAddressError('Invalid TRC20 address format (must start with T, 34 characters)'); return false }
    setAddressError('')
    return true
  }

  const handleCreateOrder = async () => {
    if (!selectedTier) return
    setCreating(true)
    setCreateError('')
    try {
      const o = await apiRequest<GasOrder>('/gas-fee/orders', {
        method: 'POST',
        body: JSON.stringify({ toAddress: address, tier: selectedTier.id, chain: selectedChain }),
      })
      setOrder(o)
      setPollErrorCount(0)
      setStep(3)
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create order')
    } finally {
      setCreating(false)
    }
  }

  const pollOrder = useCallback(async () => {
    if (!order?.orderRef) return
    try {
      const o = await apiRequest<GasOrder>(`/gas-fee/orders/${order.orderRef}`)
      setOrder(o)
      setPollErrorCount(0) // reset on success
    } catch {
      setPollErrorCount(c => c + 1)
    }
  }, [order?.orderRef])

  // isDone uses real backend status values — polling stops correctly on 'delivered'
  const isDone =
    order?.status === 'delivered' ||
    order?.status === 'failed' ||
    order?.status === 'expired' ||
    order?.status === 'refunded'

  usePolling(pollOrder, 10_000, step === 3 && !isDone)

  return (
    <div className="min-h-screen bg-surface">
      <div className="max-w-lg mx-auto px-4 py-8 pb-12 space-y-6">
        {/* Header */}
        <div className="text-center">
          <div className="w-14 h-14 rounded-full bg-warning/10 text-warning text-2xl flex items-center justify-center mx-auto mb-3">
            ⚡
          </div>
          <h1 className="text-2xl font-bold text-text-primary">TRX Gas Refill</h1>
          <p className="text-sm text-text-muted mt-1">Get TRX for TRON network fees — pay with USDT</p>
        </div>

        <StepIndicator current={step} total={4} />

        {/* ── Step 0: Chain Selector ── */}
        {step === 0 && (
          <div className="space-y-4">
            <h2 className="text-base font-semibold text-text-primary text-center">Select Blockchain</h2>
            <div className="grid grid-cols-3 gap-3">
              {/* TRON — Active */}
              <button
                onClick={() => setStep(1)}
                className="flex flex-col items-center gap-2 p-4 bg-white border-2 border-primary rounded-xl hover:shadow-sm transition-all"
              >
                <div className="w-10 h-10 rounded-full bg-warning/10 text-warning font-bold text-sm flex items-center justify-center">TRX</div>
                <span className="text-sm font-semibold text-text-primary">TRON</span>
                <Badge variant="success" size="sm">Active</Badge>
              </button>
              {/* ETH — Coming Soon */}
              <div className="flex flex-col items-center gap-2 p-4 bg-white border border-border rounded-xl opacity-60 cursor-not-allowed">
                <div className="w-10 h-10 rounded-full bg-surface text-text-muted font-bold text-sm flex items-center justify-center">ETH</div>
                <span className="text-sm font-medium text-text-muted">Ethereum</span>
                <Badge variant="default" size="sm">Soon</Badge>
              </div>
              {/* BSC — Coming Soon */}
              <div className="flex flex-col items-center gap-2 p-4 bg-white border border-border rounded-xl opacity-60 cursor-not-allowed">
                <div className="w-10 h-10 rounded-full bg-surface text-text-muted font-bold text-sm flex items-center justify-center">BNB</div>
                <span className="text-sm font-medium text-text-muted">BSC</span>
                <Badge variant="default" size="sm">Soon</Badge>
              </div>
            </div>
          </div>
        )}

        {/* ── Step 1: Tier Selector ── */}
        {step === 1 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-text-primary">Choose TRX Amount</h2>
              {tiersUpdatedAt && <StalenessBadge updatedAt={tiersUpdatedAt} />}
            </div>

            {tiersLoading && <LoadingState message="Loading prices..." />}
            {tiersError && <ErrorState title={tiersError} onRetry={fetchTiers} />}

            {!tiersLoading && !tiersError && (
              <div className="grid grid-cols-1 gap-3">
                {(tiers.length > 0 ? tiers : [
                  { id: 'small', name: 'SMALL' as const, trxAmount: 10, usdtPrice: '1.00', pkrPrice: '280' },
                  { id: 'medium', name: 'MEDIUM' as const, trxAmount: 50, usdtPrice: '4.50', pkrPrice: '1260' },
                  { id: 'large', name: 'LARGE' as const, trxAmount: 100, usdtPrice: '8.50', pkrPrice: '2380' },
                ]).map((tier) => (
                  <button
                    key={tier.id}
                    onClick={() => setSelectedTier(tier)}
                    className={`flex items-center gap-4 p-4 bg-white border-2 rounded-xl text-left hover:shadow-sm transition-all ${
                      selectedTier?.id === tier.id ? 'border-primary' : 'border-border hover:border-primary/50'
                    }`}
                  >
                    <div className={`w-12 h-12 rounded-full flex items-center justify-center font-bold text-lg flex-shrink-0 ${
                      tier.name === 'SMALL' ? 'bg-success/10 text-success' :
                      tier.name === 'MEDIUM' ? 'bg-warning/10 text-warning' :
                      'bg-primary/10 text-primary'
                    }`}>
                      {TIER_ICONS[tier.name] ?? tier.name[0]}
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-text-primary">{tier.trxAmount} TRX</span>
                        <Badge variant="default" size="sm">{tier.name}</Badge>
                      </div>
                      <p className="text-sm text-text-muted mt-0.5">
                        {tier.usdtPrice} USDT ≈ PKR {parseFloat(tier.pkrPrice).toLocaleString()}
                      </p>
                    </div>
                    <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                      selectedTier?.id === tier.id ? 'border-primary bg-primary' : 'border-border'
                    }`}>
                      {selectedTier?.id === tier.id && (
                        <div className="w-2 h-2 rounded-full bg-white" />
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}

            <div className="flex gap-3">
              <Button variant="secondary" className="flex-1" onClick={() => setStep(0)}>Back</Button>
              <Button className="flex-1" disabled={!selectedTier} onClick={() => setStep(2)}>Continue</Button>
            </div>
          </div>
        )}

        {/* ── Step 2: Enter Address ── */}
        {step === 2 && (
          <div className="space-y-5">
            <h2 className="text-base font-semibold text-text-primary">Enter TRC20 Address</h2>
            <p className="text-sm text-text-muted">Enter the TRON wallet address that needs TRX for gas fees.</p>

            <div>
              <label className="text-sm font-medium text-text-primary block mb-1.5">TRC20 Wallet Address</label>
              <Input
                placeholder="T... (34 characters)"
                value={address}
                onChange={(e) => { setAddress(e.target.value); if (addressError) validateAddress(e.target.value) }}
                onBlur={() => validateAddress(address)}
              />
              {addressError && <p className="text-sm text-danger mt-1.5">{addressError}</p>}
              {address && !addressError && TRC20_REGEX.test(address) && (
                <p className="text-sm text-success mt-1.5">Valid TRC20 address</p>
              )}
            </div>

            <div className="bg-surface border border-border rounded-lg p-3 text-sm text-text-muted">
              <p className="font-medium text-text-primary mb-1">Order Summary</p>
              <p>Chain: TRON</p>
              <p>Amount: {selectedTier?.trxAmount} TRX</p>
              <p>Price: {selectedTier?.usdtPrice} USDT ≈ PKR {selectedTier ? parseFloat(selectedTier.pkrPrice).toLocaleString() : 0}</p>
            </div>

            {createError && <p className="text-sm text-danger">{createError}</p>}

            <div className="flex gap-3">
              <Button variant="secondary" className="flex-1" onClick={() => setStep(1)} disabled={creating}>Back</Button>
              <Button
                className="flex-1"
                disabled={!TRC20_REGEX.test(address) || creating}
                onClick={handleCreateOrder}
              >
                {creating ? <Spinner size="sm" /> : 'Proceed to Payment'}
              </Button>
            </div>
          </div>
        )}

        {/* ── Step 3: Payment & Status ── */}
        {step === 3 && order && (
          <div className="space-y-5">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-text-primary">Complete Payment</h2>
              <Badge variant={statusVariant(order.status)} size="sm">
                {STATUS_LABELS[order.status] ?? order.status}
              </Badge>
            </div>

            {/* Countdown timer — only while waiting for payment */}
            {order.status === 'payment_pending' && (
              <div className="bg-warning/10 border border-warning/30 rounded-lg p-3 flex items-center justify-between">
                <span className="text-sm font-medium text-warning">Pay within</span>
                <CountdownTimer
                  expiresAt={order.expiresAt}
                  showLabel={false}
                  onExpire={() => setOrder((o) => o ? { ...o, status: 'expired' } : o)}
                />
              </div>
            )}

            {/* Poll connection error warning */}
            {pollErrorCount >= 3 && !isDone && (
              <div className="bg-warning/10 border border-warning/30 rounded-lg p-3 text-sm text-warning">
                Having trouble connecting. Your order is safe —{' '}
                <button className="underline font-medium" onClick={() => { setPollErrorCount(0); pollOrder() }}>
                  tap to refresh
                </button>
              </div>
            )}

            {/* Payment Details — shown while awaiting payment */}
            {order.status === 'payment_pending' && (
              <div className="bg-white border border-border rounded-xl p-5 space-y-4">
                <p className="text-sm font-semibold text-text-primary">Send USDT (TRC20) to this address:</p>

                <div>
                  <p className="text-xs text-text-muted mb-1.5">Payment Address</p>
                  <div className="bg-surface rounded-lg p-3 flex items-start gap-2">
                    <p className="text-sm font-mono text-text-primary break-all flex-1">{order.paymentAddress}</p>
                    <CopyButton text={order.paymentAddress} />
                  </div>
                </div>

                <div className="bg-surface rounded-lg p-3">
                  <p className="text-xs text-text-muted mb-1">Exact Amount</p>
                  <div className="flex items-center justify-between">
                    {/* paymentAmount is the correct backend field (was usdtAmount) */}
                    <p className="text-lg font-bold text-text-primary">{order.paymentAmount} USDT</p>
                    <CopyButton text={order.paymentAmount} />
                  </div>
                </div>

                <div className="bg-danger/10 border border-danger/20 rounded-lg p-3">
                  <p className="text-xs text-danger font-semibold">
                    Send ONLY USDT on TRC20 network. Sending other tokens or on different networks will result in permanent loss.
                  </p>
                </div>
              </div>
            )}

            {/* Processing — payment detected or delivery in progress */}
            {(order.status === 'payment_detected' || order.status === 'sending') && (
              <div className="bg-warning/10 border border-warning/30 rounded-xl p-5 text-center">
                <Spinner size="md" />
                <p className="text-base font-bold text-text-primary mt-3 mb-1">
                  {order.status === 'payment_detected' ? 'Payment Detected!' : 'Delivering TRX...'}
                </p>
                <p className="text-sm text-text-muted">
                  {order.status === 'payment_detected'
                    ? 'Preparing your TRX...'
                    : `Sending ${selectedTier?.trxAmount} TRX to your wallet.`}
                </p>
              </div>
            )}

            {/* Success — real backend status is 'delivered' not 'completed' */}
            {order.status === 'delivered' && (
              <div className="bg-success/10 border border-success/30 rounded-xl p-5 space-y-3">
                <div className="text-center">
                  <svg className="w-12 h-12 mx-auto text-success mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <p className="text-lg font-bold text-success">TRX Delivered!</p>
                  <p className="text-sm text-text-muted mt-1">
                    {selectedTier?.trxAmount} TRX has been sent to {order.toAddress.slice(0, 10)}...
                  </p>
                </div>
                {/* deliveryTxHash is the correct backend field (was txHash) */}
                {order.deliveryTxHash && (
                  <a
                    href={`https://tronscan.org/#/transaction/${order.deliveryTxHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center gap-1.5 text-primary text-sm underline"
                  >
                    View on TronScan
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </a>
                )}
              </div>
            )}

            {/* Expired or Failed */}
            {(order.status === 'expired' || order.status === 'failed') && (
              <div className="bg-danger/10 border border-danger/30 rounded-xl p-5 text-center">
                <p className="text-base font-bold text-danger">
                  {order.status === 'expired' ? 'Order Expired' : 'Order Failed'}
                </p>
                <p className="text-sm text-text-muted mt-1 mb-4">
                  {order.status === 'expired'
                    ? 'Payment was not received in time.'
                    : 'Something went wrong. Please contact support.'}
                </p>
                <Button onClick={() => { setOrder(null); setAddress(''); setSelectedTier(null); setPollErrorCount(0); setStep(0) }}>
                  Try Again
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
