'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { gasApi, type GasChain, type GasToken, type GasTokensResponse, type GasOrder } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'
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

// ─── Address validation by addressType ────────────────────────────────────────

const ADDRESS_PATTERNS: Record<string, RegExp> = {
  TRC20: /^T[A-Za-z1-9]{33}$/,
  EVM:   /^0x[0-9a-fA-F]{40}$/,
  SOL:   /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  SUI:   /^0x[0-9a-fA-F]{64}$/,
}

function validateAddress(addr: string, addressType: string): boolean {
  const pattern = ADDRESS_PATTERNS[addressType]
  return pattern ? pattern.test(addr) : addr.length > 5
}

function addressPlaceholder(addressType: string): string {
  switch (addressType) {
    case 'TRC20': return 'T... (34 characters)'
    case 'EVM':   return '0x... (42 characters)'
    case 'SOL':   return 'Base58 address (32–44 characters)'
    case 'SUI':   return '0x... (66 characters)'
    default:      return 'Enter wallet address'
  }
}

// ─── Explorer URL helper ───────────────────────────────────────────────────────

function explorerTxUrl(chain: string, explorerBase: string | null, txHash: string): string {
  if (!explorerBase) return '#'
  if (chain === 'TRON') return `${explorerBase}/transaction/${txHash}`
  return `${explorerBase}/tx/${txHash}`
}

// ─── Status helpers ────────────────────────────────────────────────────────────

function statusVariant(s: string): 'warning' | 'success' | 'danger' | 'default' {
  if (s === 'delivered' || s === 'refunded') return 'success'
  if (s === 'failed' || s === 'expired') return 'danger'
  if (s === 'payment_detected' || s === 'sending' || s === 'refund_pending') return 'warning'
  return 'default'
}

const STATUS_LABELS: Record<string, string> = {
  payment_pending:  'Awaiting Payment',
  payment_detected: 'Payment Detected',
  sending:          'Delivering...',
  delivered:        'Completed',
  failed:           'Failed',
  expired:          'Expired',
  refund_pending:   'Refund Processing',
  refunded:         'Refunded',
}

// ─── Category color map ────────────────────────────────────────────────────────

const CATEGORY_COLORS: Record<string, { bg: string; text: string }> = {
  tron:     { bg: 'bg-red-100',    text: 'text-red-600' },
  bnb:      { bg: 'bg-yellow-100', text: 'text-yellow-600' },
  ethereum: { bg: 'bg-blue-100',   text: 'text-blue-600' },
  solana:   { bg: 'bg-purple-100', text: 'text-purple-600' },
  sui:      { bg: 'bg-cyan-100',   text: 'text-cyan-600' },
}

function chainColor(category: string) {
  return CATEGORY_COLORS[category] ?? { bg: 'bg-surface', text: 'text-text-secondary' }
}

// ─── Step Indicator ───────────────────────────────────────────────────────────

function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center justify-center gap-2 mb-6">
      {Array.from({ length: total }).map((_, i) => (
        <div key={i} className="flex items-center gap-2">
          <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
            i < current
              ? 'bg-primary text-white'
              : i === current
              ? 'bg-primary text-white ring-2 ring-primary/30'
              : 'bg-surface text-text-muted border border-border'
          }`}>
            {i < current ? (
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
              </svg>
            ) : (i + 1)}
          </div>
          {i < total - 1 && <div className={`w-8 h-0.5 ${i < current ? 'bg-primary' : 'bg-border'}`} />}
        </div>
      ))}
    </div>
  )
}

// ─── Chain Logo ───────────────────────────────────────────────────────────────

function ChainLogo({ chain }: { chain: GasChain }) {
  const { bg, text } = chainColor(chain.category)
  if (chain.logoUrl) {
    return (
      <img
        src={chain.logoUrl}
        alt={chain.symbol}
        className="w-10 h-10 rounded-full object-contain"
        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
      />
    )
  }
  return (
    <div className={`w-10 h-10 rounded-full ${bg} ${text} font-bold text-xs flex items-center justify-center flex-shrink-0`}>
      {chain.symbol.slice(0, 3)}
    </div>
  )
}

// ─── Token Logo ───────────────────────────────────────────────────────────────

function TokenLogo({ token, chainCategory }: { token: GasToken; chainCategory: string }) {
  const { bg, text } = chainColor(chainCategory)
  if (token.logoUrl) {
    return (
      <img
        src={token.logoUrl}
        alt={token.symbol}
        className="w-9 h-9 rounded-full object-contain"
        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
      />
    )
  }
  return (
    <div className={`w-9 h-9 rounded-full ${bg} ${text} font-bold text-xs flex items-center justify-center flex-shrink-0`}>
      {token.symbol.slice(0, 3)}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function GasPage() {
  const { user } = useAuth()

  // Step: 0=chain select, 1=token+amount, 2=address, 3=payment
  const [step, setStep] = useState(0)

  // Step 0 — chains
  const [chains, setChains] = useState<GasChain[]>([])
  const [chainsLoading, setChainsLoading] = useState(true)
  const [chainsError, setChainsError] = useState('')
  const [selectedChain, setSelectedChain] = useState<GasChain | null>(null)

  // Step 1 — tokens + amount
  const [tokenData, setTokenData] = useState<GasTokensResponse | null>(null)
  const [tokensLoading, setTokensLoading] = useState(false)
  const [tokensError, setTokensError] = useState('')
  const [selectedToken, setSelectedToken] = useState<GasToken | null>(null)
  const [amount, setAmount] = useState('')
  const [amountError, setAmountError] = useState('')

  // Step 2 — address
  const [address, setAddress] = useState('')
  const [addressError, setAddressError] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')

  // Step 3 — order tracking
  const [order, setOrder] = useState<GasOrder | null>(null)
  const [pollErrorCount, setPollErrorCount] = useState(0)
  const idempKeyRef = useRef(`gas_${Date.now()}_${Math.random().toString(36).slice(2)}`)

  // Computed values
  const currentToken = selectedToken
  const priceUsd = currentToken?.priceUsd ?? 0
  const markup = currentToken?.markup ?? 1.5
  const amountNum = parseFloat(amount) || 0
  const computedUsd = amountNum * priceUsd * markup
  const maxUsd = currentToken?.maxUsdValue ?? 10
  const minAmount = currentToken?.minAmount ?? 0.1
  const usdExceeded = computedUsd > maxUsd && amountNum > 0

  // Load chains on mount
  useEffect(() => {
    setChainsLoading(true)
    gasApi.getChains()
      .then(({ chains: c }) => setChains(c))
      .catch((e: Error) => setChainsError(e.message || 'Failed to load chains'))
      .finally(() => setChainsLoading(false))
  }, [])

  // Load tokens when chain selected
  const fetchTokens = useCallback(async (chain: GasChain) => {
    setTokensLoading(true)
    setTokensError('')
    setTokenData(null)
    setSelectedToken(null)
    setAmount('')
    setAmountError('')
    try {
      const data = await gasApi.getChainTokens(chain.slug)
      setTokenData(data)
      if (data.tokens.length === 1) setSelectedToken(data.tokens[0])
    } catch (e: unknown) {
      setTokensError(e instanceof Error ? e.message : 'Failed to load tokens')
    } finally {
      setTokensLoading(false)
    }
  }, [])

  function handleSelectChain(chain: GasChain) {
    if (!chain.isAvailable && !chain.isActive) return
    setSelectedChain(chain)
    fetchTokens(chain)
    setStep(1)
  }

  function validateAmount(val: string): boolean {
    const n = parseFloat(val)
    if (!val || isNaN(n) || n <= 0) {
      setAmountError('Enter a valid amount')
      return false
    }
    if (n < minAmount) {
      setAmountError(`Minimum is ${minAmount} ${currentToken?.symbol ?? ''}`)
      return false
    }
    const usdVal = n * priceUsd * markup
    if (usdVal > maxUsd) {
      setAmountError(`Exceeds $${maxUsd} USD limit. Reduce amount.`)
      return false
    }
    setAmountError('')
    return true
  }

  function handlePreset(preset: number) {
    setAmount(String(preset))
    const usdVal = preset * priceUsd * markup
    if (usdVal > maxUsd) {
      setAmountError(`Exceeds $${maxUsd} USD limit.`)
    } else {
      setAmountError('')
    }
  }

  function handleAddressChange(val: string) {
    setAddress(val)
    if (addressError && selectedChain) validateAddressField(val)
  }

  function validateAddressField(val: string): boolean {
    if (!val) { setAddressError('Address is required'); return false }
    if (!selectedChain) return false
    if (!validateAddress(val, selectedChain.addressType)) {
      setAddressError(`Invalid ${selectedChain.networkLabel} address format`)
      return false
    }
    setAddressError('')
    return true
  }

  async function handleCreateOrder() {
    if (!currentToken || !selectedChain) return
    if (!validateAddressField(address)) return
    if (!validateAmount(amount)) return

    setCreating(true)
    setCreateError('')
    try {
      const o = await gasApi.createOrder({
        tokenConfigId: currentToken.id,
        amount: parseFloat(amount),
        toAddress: address,
        idempotencyKey: idempKeyRef.current,
      })
      setOrder(o)
      setPollErrorCount(0)
      setStep(3)
    } catch (e: unknown) {
      setCreateError(e instanceof Error ? e.message : 'Failed to create order')
    } finally {
      setCreating(false)
    }
  }

  const pollOrder = useCallback(async () => {
    if (!order?.orderRef) return
    try {
      const o = await gasApi.getOrder(order.orderRef)
      setOrder(o)
      setPollErrorCount(0)
    } catch {
      setPollErrorCount((c) => c + 1)
    }
  }, [order?.orderRef])

  const isDone = order?.status === 'delivered' || order?.status === 'failed' || order?.status === 'expired' || order?.status === 'refund_pending' || order?.status === 'refunded'

  usePolling(pollOrder, 10_000, step === 3 && !isDone)

  function resetFlow() {
    setStep(0)
    setSelectedChain(null)
    setSelectedToken(null)
    setTokenData(null)
    setAmount('')
    setAmountError('')
    setAddress('')
    setAddressError('')
    setOrder(null)
    setPollErrorCount(0)
    setCreateError('')
    idempKeyRef.current = `gas_${Date.now()}_${Math.random().toString(36).slice(2)}`
  }

  // Group chains by category for display
  const chainGroups: Record<string, GasChain[]> = {}
  chains.forEach((c) => {
    if (!chainGroups[c.category]) chainGroups[c.category] = []
    chainGroups[c.category].push(c)
  })

  const categoryLabels: Record<string, string> = {
    tron: 'TRON',
    bnb: 'BNB Chain',
    ethereum: 'Ethereum Ecosystem',
    solana: 'Solana',
    sui: 'SUI',
  }

  const explorerBase = tokenData?.chain?.explorerBase ?? null

  return (
    <div className="min-h-screen bg-surface">
      <div className="max-w-lg mx-auto px-4 py-8 pb-12 space-y-6">

        {/* Header */}
        <div className="text-center">
          <div className="w-14 h-14 rounded-full bg-warning/10 text-warning text-2xl flex items-center justify-center mx-auto mb-3">
            ⚡
          </div>
          <h1 className="text-2xl font-bold text-text-primary">Buy Gas Instantly</h1>
          <p className="text-sm text-text-muted mt-1">
            Get native blockchain gas tokens — pay with USDT
          </p>
          {user && (
            <Link href="/gas/orders" className="inline-block mt-2 text-xs text-primary hover:underline">
              View order history →
            </Link>
          )}
        </div>

        <StepIndicator current={step} total={4} />

        {/* ── Step 0: Chain Selection ─────────────────────────────────────────── */}
        {step === 0 && (
          <div className="space-y-5">
            <h2 className="text-base font-semibold text-text-primary text-center">Select Blockchain</h2>

            {chainsLoading && <LoadingState message="Loading networks..." />}
            {chainsError && <ErrorState title={chainsError} onRetry={() => { setChainsError(''); setChainsLoading(true); gasApi.getChains().then(({ chains: c }) => setChains(c)).catch((e: Error) => setChainsError(e.message)).finally(() => setChainsLoading(false)) }} />}

            {!chainsLoading && !chainsError && Object.entries(chainGroups).map(([cat, catChains]) => (
              <div key={cat} className="space-y-2">
                <p className="text-xs font-semibold text-text-muted uppercase tracking-wide px-1">
                  {categoryLabels[cat] ?? cat}
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {catChains.map((chain) => {
                    const { bg, text } = chainColor(chain.category)
                    const available = chain.isAvailable
                    const inactive = !chain.isActive
                    return (
                      <button
                        key={chain.id}
                        onClick={() => handleSelectChain(chain)}
                        disabled={inactive}
                        className={`flex flex-col items-center gap-2 p-3 rounded-xl border-2 transition-all text-center
                          ${inactive
                            ? 'opacity-40 cursor-not-allowed border-border bg-white'
                            : selectedChain?.id === chain.id
                            ? 'border-primary bg-primary/5 shadow-sm'
                            : 'border-border bg-white hover:border-primary/60 hover:shadow-sm'
                          }`}
                      >
                        <div className={`w-10 h-10 rounded-full ${bg} ${text} font-bold text-xs flex items-center justify-center flex-shrink-0`}>
                          {chain.logoUrl
                            ? <img src={chain.logoUrl} alt={chain.symbol} className="w-10 h-10 rounded-full object-contain" />
                            : chain.symbol.slice(0, 3)}
                        </div>
                        <span className="text-xs font-semibold text-text-primary leading-tight">{chain.name}</span>
                        {inactive
                          ? <Badge variant="default" size="sm">Soon</Badge>
                          : available
                          ? <Badge variant="success" size="sm">Active</Badge>
                          : <Badge variant="warning" size="sm">Setup</Badge>
                        }
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── Step 1: Token + Amount ──────────────────────────────────────────── */}
        {step === 1 && selectedChain && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-text-primary">Choose Amount</h2>
              {tokenData && <StalenessBadge updatedAt={tokenData.updatedAt} />}
            </div>

            {tokensLoading && <LoadingState message="Loading tokens..." />}
            {tokensError && <ErrorState title={tokensError} onRetry={() => fetchTokens(selectedChain)} />}

            {!tokensLoading && !tokensError && tokenData && (
              <>
                {/* Token selector (only if multiple tokens) */}
                {tokenData.tokens.length > 1 && (
                  <div className="flex gap-2 flex-wrap">
                    {tokenData.tokens.map((t) => (
                      <button
                        key={t.id}
                        onClick={() => { setSelectedToken(t); setAmount(''); setAmountError('') }}
                        className={`flex items-center gap-2 px-3 py-2 rounded-lg border-2 text-sm font-medium transition-all ${
                          selectedToken?.id === t.id
                            ? 'border-primary bg-primary/5 text-primary'
                            : 'border-border bg-white text-text-secondary hover:border-primary/50'
                        }`}
                      >
                        <TokenLogo token={t} chainCategory={selectedChain.category} />
                        {t.symbol}
                      </button>
                    ))}
                  </div>
                )}

                {currentToken && (
                  <>
                    {/* Price info */}
                    <div className="bg-surface border border-border rounded-lg px-3 py-2 flex items-center justify-between text-sm">
                      <span className="text-text-muted">1 {currentToken.symbol}</span>
                      <span className="font-semibold text-text-primary">
                        ≈ ${(priceUsd * markup).toFixed(4)} USDT
                        {currentToken.rateStale && <span className="text-warning ml-1 text-xs">(rate stale)</span>}
                      </span>
                    </div>

                    {/* Preset quick-select amounts */}
                    <div>
                      <p className="text-xs font-medium text-text-muted mb-2">Quick Select</p>
                      <div className="flex gap-2 flex-wrap">
                        {currentToken.presetAmounts.map((preset) => {
                          const presetUsd = preset * priceUsd * markup
                          const tooHigh = presetUsd > maxUsd
                          return (
                            <button
                              key={preset}
                              onClick={() => !tooHigh && handlePreset(preset)}
                              disabled={tooHigh}
                              className={`px-3 py-1.5 rounded-lg text-sm font-semibold border-2 transition-all ${
                                amount === String(preset) && !tooHigh
                                  ? 'border-primary bg-primary text-white'
                                  : tooHigh
                                  ? 'border-border text-text-muted opacity-40 cursor-not-allowed bg-white'
                                  : 'border-border bg-white text-text-primary hover:border-primary/60'
                              }`}
                            >
                              {preset} {currentToken.symbol}
                            </button>
                          )
                        })}
                      </div>
                    </div>

                    {/* Custom amount input */}
                    <div>
                      <label className="text-sm font-medium text-text-primary block mb-1.5">
                        Custom Amount ({currentToken.symbol})
                      </label>
                      <Input
                        type="number"
                        placeholder={`Min ${minAmount}`}
                        value={amount}
                        onChange={(e) => {
                          const v = e.target.value
                          setAmount(v)
                          if (v) validateAmount(v)
                          else setAmountError('')
                        }}
                        onBlur={() => { if (amount) validateAmount(amount) }}
                        min={minAmount}
                        step="any"
                      />
                      {amountError && <p className="text-sm text-danger mt-1">{amountError}</p>}
                      {amountNum > 0 && !amountError && (
                        <p className={`text-sm mt-1 ${usdExceeded ? 'text-danger' : 'text-text-muted'}`}>
                          ≈ ${computedUsd.toFixed(2)} USDT
                          {usdExceeded && ` — exceeds $${maxUsd} limit`}
                        </p>
                      )}
                    </div>

                    {/* Max cap info */}
                    <div className="bg-surface border border-border rounded-lg px-3 py-2 text-xs text-text-muted">
                      Max order value: <span className="font-semibold text-text-primary">${maxUsd} USDT</span> per transaction
                    </div>
                  </>
                )}
              </>
            )}

            <div className="flex gap-3 pt-1">
              <Button variant="secondary" className="flex-1" onClick={() => { setStep(0); setSelectedChain(null) }}>Back</Button>
              <Button
                className="flex-1"
                disabled={!currentToken || !amount || !!amountError || usdExceeded || tokensLoading}
                onClick={() => {
                  if (validateAmount(amount)) setStep(2)
                }}
              >
                Continue
              </Button>
            </div>
          </div>
        )}

        {/* ── Step 2: Enter Address ───────────────────────────────────────────── */}
        {step === 2 && selectedChain && currentToken && (
          <div className="space-y-5">
            <h2 className="text-base font-semibold text-text-primary">
              Enter {selectedChain.networkLabel} Address
            </h2>
            <p className="text-sm text-text-muted">
              Enter the {selectedChain.name} wallet address that needs {currentToken.symbol} for gas.
            </p>

            <div>
              <label className="text-sm font-medium text-text-primary block mb-1.5">
                {selectedChain.name} Wallet Address
              </label>
              <Input
                placeholder={addressPlaceholder(selectedChain.addressType)}
                value={address}
                onChange={(e) => handleAddressChange(e.target.value)}
                onBlur={() => validateAddressField(address)}
              />
              {addressError && <p className="text-sm text-danger mt-1.5">{addressError}</p>}
              {address && !addressError && validateAddress(address, selectedChain.addressType) && (
                <p className="text-sm text-success mt-1.5">Valid {selectedChain.networkLabel} address</p>
              )}
            </div>

            {/* Order summary */}
            <div className="bg-surface border border-border rounded-lg p-3 text-sm space-y-1">
              <p className="font-semibold text-text-primary mb-2">Order Summary</p>
              <div className="flex justify-between text-text-muted">
                <span>Network</span><span className="text-text-primary font-medium">{selectedChain.name}</span>
              </div>
              <div className="flex justify-between text-text-muted">
                <span>Token</span><span className="text-text-primary font-medium">{currentToken.symbol}</span>
              </div>
              <div className="flex justify-between text-text-muted">
                <span>Amount</span><span className="text-text-primary font-medium">{amount} {currentToken.symbol}</span>
              </div>
              <div className="flex justify-between text-text-muted border-t border-border pt-1 mt-1">
                <span>You Pay</span>
                <span className="text-text-primary font-bold">{computedUsd.toFixed(2)} USDT</span>
              </div>
            </div>

            {createError && <p className="text-sm text-danger">{createError}</p>}

            <div className="flex gap-3">
              <Button variant="secondary" className="flex-1" onClick={() => setStep(1)} disabled={creating}>Back</Button>
              <Button
                className="flex-1"
                disabled={!validateAddress(address, selectedChain.addressType) || creating}
                onClick={handleCreateOrder}
              >
                {creating ? <Spinner size="sm" /> : 'Proceed to Payment'}
              </Button>
            </div>
          </div>
        )}

        {/* ── Step 3: Payment & Status ────────────────────────────────────────── */}
        {step === 3 && order && (
          <div className="space-y-5">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-text-primary">Complete Payment</h2>
              <Badge variant={statusVariant(order.status)} size="sm">
                {STATUS_LABELS[order.status] ?? order.status}
              </Badge>
            </div>

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

            {pollErrorCount >= 3 && !isDone && (
              <div className="bg-warning/10 border border-warning/30 rounded-lg p-3 text-sm text-warning">
                Having trouble connecting. Your order is safe —{' '}
                <button className="underline font-medium" onClick={() => { setPollErrorCount(0); pollOrder() }}>
                  tap to refresh
                </button>
              </div>
            )}

            {/* Payment details */}
            {order.status === 'payment_pending' && (
              <div className="bg-white border border-border rounded-xl p-5 space-y-4">
                <p className="text-sm font-semibold text-text-primary">
                  Send USDT ({order.paymentNetwork}) to this address:
                </p>

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
                    <p className="text-lg font-bold text-text-primary">{order.paymentAmount} USDT</p>
                    <CopyButton text={order.paymentAmount} />
                  </div>
                </div>

                <div className="bg-danger/10 border border-danger/20 rounded-lg p-3">
                  <p className="text-xs text-danger font-semibold">
                    Send ONLY USDT on {order.paymentNetwork} network. Sending other tokens or wrong network = permanent loss.
                  </p>
                </div>
              </div>
            )}

            {/* Processing */}
            {(order.status === 'payment_detected' || order.status === 'sending') && (
              <div className="bg-warning/10 border border-warning/30 rounded-xl p-5 text-center">
                <Spinner size="md" />
                <p className="text-base font-bold text-text-primary mt-3 mb-1">
                  {order.status === 'payment_detected' ? 'Payment Detected!' : `Delivering ${currentToken?.symbol ?? ''}...`}
                </p>
                <p className="text-sm text-text-muted">
                  {order.status === 'payment_detected'
                    ? `Preparing your ${currentToken?.symbol ?? 'gas'}...`
                    : `Sending ${amount} ${currentToken?.symbol ?? ''} to your wallet.`}
                </p>
              </div>
            )}

            {/* Success */}
            {order.status === 'delivered' && (
              <div className="bg-success/10 border border-success/30 rounded-xl p-5 space-y-3">
                <div className="text-center">
                  <svg className="w-12 h-12 mx-auto text-success mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <p className="text-lg font-bold text-success">{currentToken?.symbol ?? 'Gas'} Delivered!</p>
                  <p className="text-sm text-text-muted mt-1">
                    {amount} {currentToken?.symbol} sent to {order.toAddress.slice(0, 10)}...
                  </p>
                </div>
                {order.deliveryTxHash && selectedChain && (
                  <a
                    href={explorerTxUrl(selectedChain.slug, explorerBase, order.deliveryTxHash)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center gap-1.5 text-primary text-sm underline"
                  >
                    View Transaction
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </a>
                )}
                <Button className="w-full" variant="secondary" onClick={resetFlow}>Buy More Gas</Button>
              </div>
            )}

            {/* Refund */}
            {(order.status === 'refund_pending' || order.status === 'refunded') && (
              <div className="bg-warning/10 border border-warning/30 rounded-xl p-5 text-center space-y-2">
                <p className="text-base font-bold text-warning">
                  {order.status === 'refund_pending' ? 'Refund Processing' : 'Refunded'}
                </p>
                <p className="text-sm text-text-muted">
                  {order.status === 'refund_pending'
                    ? 'Your USDT refund is being processed. It will arrive shortly.'
                    : 'Your USDT has been refunded to your payment address.'}
                </p>
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
                    ? 'Payment was not received in time. Please try again.'
                    : 'Something went wrong. Please contact support.'}
                </p>
                <Button onClick={resetFlow}>Try Again</Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
