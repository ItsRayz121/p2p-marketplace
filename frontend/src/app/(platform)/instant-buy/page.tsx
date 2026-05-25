'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { isAddress } from 'viem'
import { marketplaceApi, instantBuyApi, apiRequest } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Spinner } from '@/components/ui/Spinner'
import { StalenessBadge } from '@/components/ui/StalenessBadge'

// ─── Address validation per network ──────────────────────────────────────────
const EVM_NETWORKS = new Set(['ERC20', 'BEP20', 'POLYGON', 'ARBITRUM', 'OPTIMISM', 'BASE'])

function validateDestinationAddress(network: string, address: string): string | null {
  const trimmed = address.trim()
  if (!trimmed) return 'Address is required'
  if (EVM_NETWORKS.has(network)) {
    if (!isAddress(trimmed)) return 'Invalid address — expected a 0x… EVM address (42 chars)'
    return null
  }
  if (network === 'TRC20') {
    if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(trimmed)) return 'Invalid TRON address — expected base58, starts with T, 34 chars'
    return null
  }
  if (network === 'Bitcoin') {
    const okBase58 = /^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(trimmed)
    const okBech32 = /^bc1[02-9ac-hj-np-z]{6,87}$/i.test(trimmed)
    if (!okBase58 && !okBech32) return 'Invalid Bitcoin address'
    return null
  }
  // Unknown network — accept and let the backend validate.
  return null
}

// ─── Rate source attribution ──────────────────────────────────────────────────

const SOURCE_LABELS: Record<string, { label: string; url: string }> = {
  coingecko: { label: 'CoinGecko', url: 'https://www.coingecko.com' },
  kraken:    { label: 'Kraken',    url: 'https://www.kraken.com' },
  bybit:     { label: 'Bybit',     url: 'https://www.bybit.com' },
  binance:   { label: 'Binance',   url: 'https://www.binance.com' },
}

function RateSourceBadge({ source }: { source: string }) {
  const info = SOURCE_LABELS[source]
  if (!info) return null
  return (
    <a
      href={info.url}
      target="_blank"
      rel="noopener noreferrer"
      className="text-[10px] text-text-muted border border-border rounded px-1.5 py-0.5 hover:text-primary transition-colors"
    >
      via {info.label}
    </a>
  )
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface InstantOrder {
  id: string
  status: string
  coin: string
  network: string
  paymentMode: string
  amount: string
  amountPkr: string
  destinationAddress: string
  expiresAt: string
  createdAt: string
}

const COINS = [
  { id: 'USDT', name: 'Tether', abbr: 'USDT' },
  { id: 'BTC', name: 'Bitcoin', abbr: 'BTC' },
  { id: 'ETH', name: 'Ethereum', abbr: 'ETH' },
  { id: 'BNB', name: 'BNB', abbr: 'BNB' },
  { id: 'TRX', name: 'TRON', abbr: 'TRX' },
]

const NETWORKS: Record<string, string[]> = {
  USDT: ['TRC20', 'ERC20', 'BEP20'],
  BTC: ['Bitcoin'],
  ETH: ['ERC20'],
  BNB: ['BEP20'],
  TRX: ['TRC20'],
}

const PAYMENT_MODES = [
  { id: 'pkr', label: 'PKR Bank Transfer' },
  { id: 'crypto', label: 'Crypto Deposit' },
]

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

// ─── Page ────────────────────────────────────────────────────────────────────

export default function InstantBuyPage() {
  const router = useRouter()
  const [step, setStep] = useState(0)

  // Step 1
  const [selectedCoin, setSelectedCoin] = useState('')

  // Step 2
  const [selectedNetwork, setSelectedNetwork] = useState('')
  const [paymentMode, setPaymentMode] = useState('pkr')
  const [feeInfo, setFeeInfo] = useState<{ fee: string; feePkr: string } | null>(null)
  const [feeLoading, setFeeLoading] = useState(false)

  // Step 3
  const [amount, setAmount] = useState('')
  const [destAddress, setDestAddress] = useState('')
  const [rate, setRate] = useState<number>(0)
  const [rateSource, setRateSource] = useState<string>('')
  const [rateUpdatedAt, setRateUpdatedAt] = useState<string>('')
  const [rateLoading, setRateLoading] = useState(false)
  const [dailyLimit, setDailyLimit] = useState<number>(0)
  const [dailyUsed, setDailyUsed] = useState<number>(0)

  const addressError = destAddress ? validateDestinationAddress(selectedNetwork, destAddress) : null

  // Step 4
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')

  // Fetch fee when network/coin changes
  useEffect(() => {
    if (!selectedCoin || !selectedNetwork) return
    setFeeLoading(true)
    apiRequest<{ fee: string; feePkr: string; estimatedTime: string }>('/gas-fee/estimate', {
      method: 'POST',
      body: JSON.stringify({ coin: selectedCoin, network: selectedNetwork }),
    })
      .then((r) => setFeeInfo(r))
      .catch(() => setFeeInfo(null))
      .finally(() => setFeeLoading(false))
  }, [selectedCoin, selectedNetwork])

  // Fetch rate when entering step 3
  const fetchRate = useCallback(async () => {
    if (!selectedCoin) return
    setRateLoading(true)
    try {
      const r = await marketplaceApi.getRate(selectedCoin)
      setRate(r.rate)
      setRateSource(r.source ?? '')
      setRateUpdatedAt(new Date().toISOString())
    } catch {
      // ignore
    } finally {
      setRateLoading(false)
    }
  }, [selectedCoin])

  // Auto-refresh the rate every 30s while the user is in step 2 or 3 so the
  // "you will receive" quote doesn't go stale while they're typing.
  usePolling(fetchRate, 30_000, step >= 2 && !!selectedCoin)

  // Fetch daily limits
  useEffect(() => {
    if (step === 2) {
      fetchRate()
      apiRequest<{ dailyLimit: number; dailyUsed: number }>('/instant-buy/limits')
        .then((r) => { setDailyLimit(r.dailyLimit); setDailyUsed(r.dailyUsed) })
        .catch(() => {})
    }
  }, [step, fetchRate])

  const convertedAmount =
    rate > 0 && amount
      ? paymentMode === 'pkr'
        ? (parseFloat(amount) / rate).toFixed(6)
        : (parseFloat(amount) * rate).toFixed(2)
      : null

  const handleSubmit = async () => {
    setSubmitting(true)
    setSubmitError('')
    try {
      const payload = {
        coin: selectedCoin,
        network: selectedNetwork,
        paymentMode,
        amount: parseFloat(amount),
        destinationAddress: destAddress,
      }
      const order = await apiRequest<InstantOrder>('/instant-buy/orders', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      if (paymentMode === 'pkr') {
        router.push(`/instant-buy/payment/${order.id}`)
      } else {
        router.push(`/instant-buy/crypto-deposit/${order.id}`)
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to create order')
      setSubmitting(false)
    }
  }

  const stepLabels = ['Choose Coin', 'Network & Payment', 'Enter Amount', 'Confirm']

  return (
    <div className="max-w-lg mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold text-text-primary mb-2">Instant Buy</h1>
      <p className="text-sm text-text-muted mb-6">Buy crypto instantly with PKR or crypto deposit</p>

      <StepIndicator current={step} total={4} />

      <p className="text-center text-xs text-text-muted mb-6 font-medium uppercase tracking-wide">
        Step {step + 1}: {stepLabels[step]}
      </p>

      {/* ── Step 1: Choose Coin ── */}
      {step === 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {COINS.map((c) => (
            <button
              key={c.id}
              onClick={() => { setSelectedCoin(c.id); setSelectedNetwork(''); setStep(1) }}
              className="flex flex-col items-center gap-3 p-4 bg-white border border-border rounded-xl hover:border-primary/50 hover:shadow-sm transition-all text-center group"
            >
              <div className="w-12 h-12 rounded-full bg-primary/10 text-primary font-bold text-sm flex items-center justify-center group-hover:bg-primary group-hover:text-white transition-colors">
                {c.abbr.slice(0, 3)}
              </div>
              <div>
                <p className="text-sm font-semibold text-text-primary">{c.abbr}</p>
                <p className="text-xs text-text-muted">{c.name}</p>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* ── Step 2: Network + Payment Mode ── */}
      {step === 1 && (
        <div className="space-y-5">
          <div className="bg-white border border-border rounded-xl p-4">
            <p className="text-sm font-semibold text-text-primary mb-3">Select Network</p>
            <div className="grid grid-cols-2 gap-2">
              {(NETWORKS[selectedCoin] ?? []).map((net) => (
                <button
                  key={net}
                  onClick={() => setSelectedNetwork(net)}
                  className={`py-2.5 px-3 rounded-lg border text-sm font-medium transition-colors ${
                    selectedNetwork === net
                      ? 'bg-primary text-white border-primary'
                      : 'bg-surface text-text-primary border-border hover:border-primary/50'
                  }`}
                >
                  {net}
                </button>
              ))}
            </div>
          </div>

          <div className="bg-white border border-border rounded-xl p-4">
            <p className="text-sm font-semibold text-text-primary mb-3">Payment Mode</p>
            <div className="grid grid-cols-2 gap-2">
              {PAYMENT_MODES.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setPaymentMode(m.id)}
                  className={`py-2.5 px-3 rounded-lg border text-sm font-medium transition-colors ${
                    paymentMode === m.id
                      ? 'bg-primary text-white border-primary'
                      : 'bg-surface text-text-primary border-border hover:border-primary/50'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {selectedNetwork && (
            <div className="bg-surface border border-border rounded-xl p-4">
              <p className="text-xs text-text-muted font-medium mb-1">Estimated Network Fee</p>
              {feeLoading ? (
                <Spinner size="sm" />
              ) : feeInfo ? (
                <p className="text-sm font-semibold text-text-primary">
                  {feeInfo.fee} {selectedCoin} ≈ PKR {feeInfo.feePkr}
                </p>
              ) : (
                <p className="text-sm text-text-muted">Fee info unavailable</p>
              )}
            </div>
          )}

          <div className="flex gap-3">
            <Button variant="secondary" className="flex-1" onClick={() => setStep(0)}>Back</Button>
            <Button
              className="flex-1"
              disabled={!selectedNetwork}
              onClick={() => setStep(2)}
            >
              Continue
            </Button>
          </div>
        </div>
      )}

      {/* ── Step 3: Amount + Address ── */}
      {step === 2 && (
        <div className="space-y-5">
          <div className="bg-white border border-border rounded-xl p-4 space-y-4">
            <div>
              <label className="text-sm font-medium text-text-primary block mb-1.5">
                {paymentMode === 'pkr' ? 'Amount (PKR)' : `Amount (${selectedCoin})`}
              </label>
              <Input
                type="number"
                placeholder={paymentMode === 'pkr' ? 'e.g. 5000' : 'e.g. 10'}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>

            {amount && (
              <div className="bg-surface rounded-lg p-3">
                <p className="text-xs text-text-muted mb-0.5">You will receive approximately</p>
                {rateLoading ? (
                  <Spinner size="sm" />
                ) : convertedAmount ? (
                  <p className="text-base font-bold text-primary">
                    {paymentMode === 'pkr'
                      ? `${convertedAmount} ${selectedCoin}`
                      : `PKR ${parseFloat(convertedAmount).toLocaleString()}`}
                  </p>
                ) : (
                  <p className="text-sm text-text-muted">Rate unavailable</p>
                )}
                {rate > 0 && (
                  <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                    <p className="text-xs text-text-muted">
                      Rate: 1 {selectedCoin} = PKR {rate.toLocaleString()}
                    </p>
                    <RateSourceBadge source={rateSource} />
                    {rateUpdatedAt && <StalenessBadge updatedAt={rateUpdatedAt} thresholdMinutes={1} />}
                  </div>
                )}
              </div>
            )}

            {dailyLimit > 0 && (
              <div className="bg-surface rounded-lg p-3">
                <p className="text-xs text-text-muted mb-1">Daily Limit Remaining</p>
                <p className="text-sm font-semibold text-text-primary">
                  PKR {(dailyLimit - dailyUsed).toLocaleString()} of {dailyLimit.toLocaleString()}
                </p>
                <div className="h-1.5 bg-border rounded-full mt-2 overflow-hidden">
                  <div
                    className="h-full bg-primary rounded-full"
                    style={{ width: `${Math.min((dailyUsed / dailyLimit) * 100, 100)}%` }}
                  />
                </div>
              </div>
            )}

            <div>
              <label className="text-sm font-medium text-text-primary block mb-1.5">
                Destination {selectedCoin} Address ({selectedNetwork})
              </label>
              <Input
                placeholder="Enter wallet address"
                value={destAddress}
                onChange={(e) => setDestAddress(e.target.value)}
              />
              {addressError && (
                <p className="text-xs text-danger mt-1">{addressError}</p>
              )}
            </div>
          </div>

          <div className="flex gap-3">
            <Button variant="secondary" className="flex-1" onClick={() => setStep(1)}>Back</Button>
            <Button
              className="flex-1"
              disabled={!amount || !destAddress || !!addressError}
              onClick={() => setStep(3)}
            >
              Proceed
            </Button>
          </div>
        </div>
      )}

      {/* ── Step 4: Confirm & Submit ── */}
      {step === 3 && (
        <div className="space-y-5">
          <div className="bg-white border border-border rounded-xl p-5 space-y-3">
            <h2 className="text-base font-bold text-text-primary">Order Summary</h2>
            <div className="divide-y divide-border">
              {[
                { label: 'Coin', value: selectedCoin },
                { label: 'Network', value: selectedNetwork },
                { label: 'Payment Mode', value: paymentMode === 'pkr' ? 'PKR Bank Transfer' : 'Crypto Deposit' },
                { label: paymentMode === 'pkr' ? 'PKR Amount' : `${selectedCoin} Amount`, value: `${amount} ${paymentMode === 'pkr' ? 'PKR' : selectedCoin}` },
                { label: 'Destination Address', value: destAddress.slice(0, 12) + '...' + destAddress.slice(-6) },
              ].map((row) => (
                <div key={row.label} className="flex justify-between py-2.5 text-sm">
                  <span className="text-text-muted">{row.label}</span>
                  <span className="font-medium text-text-primary text-right max-w-[60%] break-all">{row.value}</span>
                </div>
              ))}
            </div>
          </div>

          {submitError && (
            <div className="bg-danger/10 border border-danger/30 rounded-lg p-3 text-sm text-danger">
              {submitError}
            </div>
          )}

          <div className="flex gap-3">
            <Button variant="secondary" className="flex-1" onClick={() => setStep(2)} disabled={submitting}>
              Back
            </Button>
            <Button className="flex-1" onClick={handleSubmit} disabled={submitting}>
              {submitting ? <Spinner size="sm" /> : 'Create Order'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
