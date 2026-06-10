'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  gasApi,
  type GasChain, type GasToken, type GasTokensResponse, type GasOrder,
  type GasPkrMethods, type GasCryptoMethods, type GasNetworkFee,
} from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'
import { usePolling } from '@/hooks/usePolling'
import { useFileUpload } from '@/hooks/useFileUpload'
import { Fuel } from 'lucide-react'

import {
  PHASE, GasFlowProvider, type Phase, type PkrMethodKey,
} from './_components/GasContext'
import { StepIndicator, validateAddress } from './_components/GasPrimitives'
import { GasChainGrid }          from './_components/GasChainGrid'
import { GasTokenStep }          from './_components/GasTokenStep'
import { GasAmountStep }         from './_components/GasAmountStep'
import { GasAddressStep }        from './_components/GasAddressStep'
import { GasPaymentChoice }      from './_components/GasPaymentChoice'
import { GasPkrMethodStep }      from './_components/GasPkrMethodStep'
import { GasPkrProofStep }       from './_components/GasPkrProofStep'
import { GasPkrReviewStep }      from './_components/GasPkrReviewStep'
import { GasCryptoNetworkStep }  from './_components/GasCryptoNetworkStep'
import { GasCryptoQRStep }       from './_components/GasCryptoQRStep'
import { GasProcessingView }     from './_components/GasProcessingView'
import { GasCompleteView }       from './_components/GasCompleteView'

// localStorage pointer to the in-progress crypto order so a page refresh
// restores the payment screen instead of dumping the user back to step 1.
const ACTIVE_ORDER_KEY = 'gas_active_crypto_order'

export default function GasPage() {
  const { user }  = useAuth()
  const router    = useRouter()

  // ── Phase ──────────────────────────────────────────────────────────────────
  const [phase, setPhase] = useState<Phase>(PHASE.CHAINS)

  // ── Step 0: Chains ─────────────────────────────────────────────────────────
  const [chains, setChains]               = useState<GasChain[]>([])
  const [chainsLoading, setChainsLoading] = useState(true)
  const [chainsError, setChainsError]     = useState('')
  const [selectedChain, setSelectedChain] = useState<GasChain | null>(null)

  // ── Step 1: Tokens ─────────────────────────────────────────────────────────
  const [tokenData, setTokenData]         = useState<GasTokensResponse | null>(null)
  const [tokensLoading, setTokensLoading] = useState(false)
  const [tokensError, setTokensError]     = useState('')
  const [selectedToken, setSelectedToken] = useState<GasToken | null>(null)

  // ── Step 2: Amount ─────────────────────────────────────────────────────────
  const [amount, setAmount]           = useState('')
  const [amountError, setAmountError] = useState('')

  // ── Step 3: Address ────────────────────────────────────────────────────────
  const [address, setAddress]             = useState('')
  const [addressError, setAddressError]   = useState('')

  // ── Step 4: Payment methods ────────────────────────────────────────────────
  const [pkrMethods, setPkrMethods]         = useState<GasPkrMethods | null>(null)
  const [cryptoMethods, setCryptoMethods]   = useState<GasCryptoMethods | null>(null)
  const [methodsLoading, setMethodsLoading] = useState(false)

  // ── PKR flow ───────────────────────────────────────────────────────────────
  const [selectedPkrMethod, setSelectedPkrMethod] = useState<PkrMethodKey | null>(null)
  const [creatingPkr, setCreatingPkr]   = useState(false)
  const [pkrError, setPkrError]         = useState('')
  const [networkFee, setNetworkFee]     = useState<GasNetworkFee | null>(null)

  const { upload, uploading, error: uploadError } = useFileUpload('payment-proof')
  const [proofUrl, setProofUrl]             = useState('')
  const [submittingProof, setSubmittingProof] = useState(false)
  const [proofError, setProofError]         = useState('')

  // ── Crypto flow ────────────────────────────────────────────────────────────
  const [selectedCryptoNetwork, setSelectedCryptoNetwork] = useState<'BEP20' | 'APTOS' | null>(null)
  const [creatingCrypto, setCreatingCrypto] = useState(false)
  const [cryptoError, setCryptoError]       = useState('')
  const [qrFailed, setQrFailed]             = useState(false)

  const [paymentSent, setPaymentSent]   = useState(false)
  const [verifyOpen, setVerifyOpen]     = useState(false)
  const [verifyTxHash, setVerifyTxHash] = useState('')
  const [verifying, setVerifying]       = useState(false)
  const [verifyError, setVerifyError]   = useState('')
  const [verifySuccess, setVerifySuccess] = useState('')

  // ── Order tracking ─────────────────────────────────────────────────────────
  const [order, setOrder]               = useState<GasOrder | null>(null)
  const [pollErrCount, setPollErrCount] = useState(0)
  const idempKeyRef = useRef(`gas_${Date.now()}_${Math.random().toString(36).slice(2)}`)

  // ── Computed ───────────────────────────────────────────────────────────────
  const rawUsdPrice     = selectedToken?.rawUsdPrice ?? selectedToken?.priceUsd ?? 0
  const priceUsd        = rawUsdPrice
  const pricePkr        = selectedToken?.pricePkr ?? 0
  const platformFeeUsdt = selectedToken?.platformFeeUsdt ?? 0.25
  const amountNum       = parseFloat(amount) || 0
  const gasValueUsd     = amountNum * priceUsd
  const usdPkrRate      = priceUsd > 0 ? pricePkr / priceUsd : 0
  const totalUsd        = gasValueUsd + platformFeeUsdt
  const computedUsd     = totalUsd
  const computedPkr     = totalUsd * usdPkrRate
  const maxUsd          = selectedToken?.maxUsdValue ?? 10
  const minAmount       = selectedToken?.minAmount ?? 0.1
  const usdExceeded     = gasValueUsd > maxUsd && amountNum > 0
  const isPkrOrder      = order?.paymentCoin === 'PKR'
  const explorerBase    = tokenData?.chain?.explorerBase ?? null

  // ── Effects ────────────────────────────────────────────────────────────────

  useEffect(() => {
    gasApi.getChains()
      .then(({ chains: c }) => setChains(c))
      .catch((e: Error) => setChainsError(e.message || 'Failed to load chains'))
      .finally(() => setChainsLoading(false))
  }, [])

  useEffect(() => {
    if (phase !== PHASE.PAY_METHOD || pkrMethods || cryptoMethods) return
    setMethodsLoading(true)
    Promise.allSettled([gasApi.getPkrMethods(), gasApi.getCryptoMethods()])
      .then(([pkr, crypto]) => {
        if (pkr.status === 'fulfilled')    setPkrMethods(pkr.value)
        if (crypto.status === 'fulfilled') setCryptoMethods(crypto.value)
      })
      .finally(() => setMethodsLoading(false))
  }, [phase, pkrMethods, cryptoMethods])

  useEffect(() => {
    if (phase !== PHASE.ADDRESS || !selectedChain) return
    setNetworkFee(null)
    gasApi.getNetworkFee(selectedChain.slug)
      .then(fee => setNetworkFee(fee))
      .catch(() => setNetworkFee(null))
  }, [phase, selectedChain])

  // ── Handlers ───────────────────────────────────────────────────────────────

  const fetchTokens = useCallback(async (chain: GasChain) => {
    setTokensLoading(true); setTokensError(''); setTokenData(null); setSelectedToken(null)
    try {
      const data = await gasApi.getChainTokens(chain.slug)
      setTokenData(data)
      const active = data.tokens.filter((t) => t.isActive)
      if (active.length === 1) setSelectedToken(active[0])
    } catch (e: unknown) { setTokensError(e instanceof Error ? e.message : 'Failed to load tokens') }
    finally { setTokensLoading(false) }
  }, [])

  function handleSelectChain(chain: GasChain) {
    if (!chain.isActive) return
    setSelectedChain(chain)
    fetchTokens(chain)
    setPhase(PHASE.TOKEN)
  }

  function validateAmountField(val: string): boolean {
    const n = parseFloat(val)
    if (!val || isNaN(n) || n <= 0) { setAmountError('Enter a valid amount'); return false }
    if (n < minAmount) { setAmountError(`Minimum is ${minAmount} ${selectedToken?.symbol ?? ''}`); return false }
    if (n * priceUsd > maxUsd) { setAmountError(`Exceeds $${maxUsd} USD limit`); return false }
    setAmountError(''); return true
  }

  function validateAddressField(val: string): boolean {
    if (!val) { setAddressError('Address is required'); return false }
    if (!selectedChain || !validateAddress(val, selectedChain.addressType)) {
      setAddressError(`Invalid ${selectedChain?.networkLabel ?? ''} address format`)
      return false
    }
    setAddressError(''); return true
  }

  async function handleCreatePkrOrder() {
    if (!selectedToken || !selectedChain || !selectedPkrMethod) return
    setCreatingPkr(true); setPkrError('')
    try {
      const o = await gasApi.createPkrOrder({
        tokenConfigId: selectedToken.id, amount: parseFloat(amount),
        toAddress: address, pkrPaymentMethod: selectedPkrMethod,
        idempotencyKey: `${idempKeyRef.current}_pkr`,
      })
      setOrder(o); setPollErrCount(0); setPhase(PHASE.PKR_PROOF)
    } catch (e: unknown) { setPkrError(e instanceof Error ? e.message : 'Failed to create order') }
    finally { setCreatingPkr(false) }
  }

  async function handleUploadFile(file: File) {
    setProofError('')
    try {
      const url = await upload(file)
      setProofUrl(url)
    } catch { /* error in uploadError */ }
  }

  async function handleSubmitProof() {
    if (!order || !proofUrl) return
    setSubmittingProof(true); setProofError('')
    try {
      await gasApi.submitProof(order.orderRef, proofUrl)
      const token = order.trackingToken ? `?token=${encodeURIComponent(order.trackingToken)}` : ''
      router.push(`/gas/orders/${order.orderRef}${token}`)
    } catch (e: unknown) { setProofError(e instanceof Error ? e.message : 'Failed to submit proof') }
    finally { setSubmittingProof(false) }
  }

  async function handleCreateCryptoOrder() {
    if (!selectedToken || !selectedCryptoNetwork) return
    setCreatingCrypto(true); setCryptoError('')
    try {
      const o = await gasApi.createCryptoOrder({
        tokenConfigId: selectedToken.id, amount: parseFloat(amount),
        toAddress: address, paymentNetwork: selectedCryptoNetwork,
        idempotencyKey: `${idempKeyRef.current}_crypto`,
      })
      setOrder(o); setPollErrCount(0); setQrFailed(false); setPaymentSent(false); setPhase(PHASE.CRYPTO_QR)
      try { localStorage.setItem(ACTIVE_ORDER_KEY, JSON.stringify({ orderRef: o.orderRef, trackingToken: o.trackingToken ?? null })) } catch { /* storage unavailable */ }
    } catch (e: unknown) { setCryptoError(e instanceof Error ? e.message : 'Failed to create order') }
    finally { setCreatingCrypto(false) }
  }

  // Restore an in-progress crypto order after a refresh so the user keeps their
  // payment screen and detection timer (the timer itself is persisted per-order).
  useEffect(() => {
    let cancelled = false
    let raw: string | null = null
    try { raw = localStorage.getItem(ACTIVE_ORDER_KEY) } catch { /* storage unavailable */ }
    if (!raw) return
    let saved: { orderRef?: string; trackingToken?: string | null }
    try { saved = JSON.parse(raw) } catch { try { localStorage.removeItem(ACTIVE_ORDER_KEY) } catch { /* */ } return }
    if (!saved.orderRef) return
    ;(async () => {
      try {
        const o = await gasApi.getOrder(saved.orderRef!, saved.trackingToken ?? undefined)
        if (cancelled) return
        if (o.status === 'payment_pending') {
          setOrder(o); setPhase(PHASE.CRYPTO_QR)
        } else if (['payment_detected', 'sending', 'payment_verified'].includes(o.status)) {
          setOrder(o); setPhase(PHASE.PROCESSING)
        } else {
          // Terminal, or proof already submitted → tracking page owns it from here.
          try { localStorage.removeItem(ACTIVE_ORDER_KEY) } catch { /* */ }
          if (o.status === 'payment_uploaded') {
            const t = o.trackingToken ? `?token=${encodeURIComponent(o.trackingToken)}` : ''
            router.replace(`/gas/orders/${o.orderRef}${t}`)
          }
        }
      } catch {
        try { localStorage.removeItem(ACTIVE_ORDER_KEY) } catch { /* */ }
      }
    })()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleVerifyPayment() {
    if (!order?.orderRef || !verifyTxHash.trim()) return
    setVerifying(true); setVerifyError(''); setVerifySuccess('')
    try {
      const res = await gasApi.verifyPayment(order.orderRef, verifyTxHash.trim())
      setVerifySuccess(res.message ?? 'Payment verified!')
      setOrder(prev => prev ? { ...prev, status: res.status as GasOrder['status'] } : prev)
      setVerifyOpen(false); setVerifyTxHash('')
      try { localStorage.removeItem(ACTIVE_ORDER_KEY) } catch { /* */ }
      const token = order.trackingToken ? `?token=${encodeURIComponent(order.trackingToken)}` : ''
      router.push(`/gas/orders/${order.orderRef}${token}`)
    } catch (e: unknown) {
      setVerifyError(e instanceof Error ? e.message : 'Verification failed. Please check your transaction hash and try again.')
    } finally { setVerifying(false) }
  }

  const pollOrder = useCallback(async () => {
    if (!order?.orderRef) return
    try {
      const o = await gasApi.getOrder(order.orderRef, order.trackingToken ?? undefined)
      setOrder(prev => ({ ...o, paymentAddress: o.paymentAddress || prev?.paymentAddress || '' }))
      setPollErrCount(0)
      // Once the order leaves the payment screen, drop the refresh-restore pointer.
      if (['delivered', 'failed', 'expired', 'refunded', 'payment_uploaded'].includes(o.status)) {
        try { localStorage.removeItem(ACTIVE_ORDER_KEY) } catch { /* */ }
      }
      if (o.status === 'delivered') setPhase(PHASE.COMPLETE)
      else if (['payment_detected', 'sending', 'payment_verified'].includes(o.status)) setPhase(PHASE.PROCESSING)
      else if (o.status === 'payment_uploaded') {
        const token = o.trackingToken ? `?token=${encodeURIComponent(o.trackingToken)}` : ''
        router.push(`/gas/orders/${o.orderRef}${token}`)
      }
    } catch { setPollErrCount(c => c + 1) }
  }, [order?.orderRef, order?.trackingToken, router])

  const isTerminal = order && ['delivered', 'failed', 'expired', 'refunded'].includes(order.status)
  usePolling(
    pollOrder, 8_000,
    !!(order?.orderRef) && !isTerminal &&
    ([PHASE.CRYPTO_QR, PHASE.PKR_REVIEW, PHASE.PROCESSING] as Phase[]).includes(phase)
  )

  function resetFlow() {
    setPhase(PHASE.CHAINS)
    setSelectedChain(null); setSelectedToken(null); setTokenData(null)
    setAmount(''); setAmountError(''); setAddress(''); setAddressError('')
    setSelectedPkrMethod(null); setSelectedCryptoNetwork(null)
    setOrder(null); setPollErrCount(0)
    setPaymentSent(false)
    setPkrError(''); setCryptoError(''); setProofUrl(''); setProofError('')
    try { localStorage.removeItem(ACTIVE_ORDER_KEY) } catch { /* */ }
    idempKeyRef.current = `gas_${Date.now()}_${Math.random().toString(36).slice(2)}`
  }

  // Group chains by category
  const chainGroups: Record<string, GasChain[]> = {}
  chains.forEach(c => { if (!chainGroups[c.category]) chainGroups[c.category] = []; chainGroups[c.category].push(c) })

  function getPkrDetails() {
    if (!pkrMethods || !selectedPkrMethod) return null
    if (selectedPkrMethod === 'bank_transfer') {
      const b = pkrMethods.bank
      return [
        { label: 'Bank Name', value: b.bankName },
        { label: 'Account Name', value: b.accountName },
        { label: 'IBAN', value: b.iban },
        { label: 'Account Number', value: b.accountNumber },
      ].filter(r => r.value)
    }
    const m = pkrMethods[selectedPkrMethod as 'jazzcash' | 'easypaisa' | 'nayapay' | 'sadapay']
    return [
      { label: 'Account Name', value: m.name },
      { label: 'Mobile Number', value: m.number },
    ].filter(r => r.value)
  }

  // ── Context value ──────────────────────────────────────────────────────────

  const ctx = {
    user, phase, setPhase, resetFlow,
    chains, chainsLoading, chainsError, setChainsError, setChainsLoading, setChains,
    selectedChain, handleSelectChain,
    tokenData, tokensLoading, tokensError, selectedToken, setSelectedToken, fetchTokens,
    amount, setAmount, amountError, setAmountError, validateAmountField,
    address, setAddress, addressError, setAddressError, validateAddressField, networkFee,
    pkrMethods, cryptoMethods, methodsLoading,
    selectedPkrMethod, setSelectedPkrMethod, creatingPkr, pkrError,
    proofUrl, setProofUrl, submittingProof, proofError, uploading, uploadError,
    handleCreatePkrOrder, handleUploadFile, handleSubmitProof,
    selectedCryptoNetwork, setSelectedCryptoNetwork, creatingCrypto, cryptoError,
    qrFailed, setQrFailed, paymentSent, setPaymentSent,
    verifyOpen, setVerifyOpen, verifyTxHash, setVerifyTxHash,
    verifying, verifyError, verifySuccess,
    handleCreateCryptoOrder, handleVerifyPayment, pollOrder,
    order, setOrder, pollErrCount, setPollErrCount,
    priceUsd, pricePkr, platformFeeUsdt, amountNum, gasValueUsd, usdPkrRate,
    totalUsd, computedUsd, computedPkr, maxUsd, minAmount, usdExceeded,
    isPkrOrder, explorerBase, chainGroups, getPkrDetails,
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <GasFlowProvider value={ctx}>
      <div className="min-h-screen bg-canvas">

        {/* Sticky header */}
        <div className="bg-surface border-b border-border">
          <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-orange-400 to-amber-500 flex items-center justify-center text-white">
                <Fuel size={18} />
              </div>
              <div>
                <h1 className="text-base font-bold text-text-primary leading-tight">Buy Gas Instantly</h1>
                <p className="text-xs text-text-muted">Pay with PKR or USDT</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Link href="/dashboard" className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-secondary transition-colors px-2 py-1.5">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" /></svg>
                Dashboard
              </Link>
              {user && (
                <Link href="/gas/orders" className="flex items-center gap-1.5 text-xs text-primary font-semibold border border-primary/20 rounded-lg px-3 py-1.5 hover:bg-primary/5 transition-colors">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
                  My Orders
                </Link>
              )}
            </div>
          </div>
        </div>

        <div className={`mx-auto px-4 py-6 pb-16 ${phase === PHASE.CHAINS ? 'max-w-5xl' : 'max-w-xl'}`}>

          {/* Phase 0 — Chain grid */}
          {phase === PHASE.CHAINS && <GasChainGrid />}

          {/* Phases 1–12 — Order flow card */}
          {phase > PHASE.CHAINS && (
            <div>
              <StepIndicator phase={phase} />
              <div className="bg-surface rounded-xl shadow-card border border-border overflow-hidden">
                {phase === PHASE.TOKEN          && <GasTokenStep />}
                {phase === PHASE.AMOUNT         && <GasAmountStep />}
                {phase === PHASE.ADDRESS        && <GasAddressStep />}
                {phase === PHASE.PAY_METHOD     && <GasPaymentChoice />}
                {phase === PHASE.PKR_METHOD     && <GasPkrMethodStep />}
                {phase === PHASE.PKR_PROOF      && <GasPkrProofStep />}
                {phase === PHASE.PKR_REVIEW     && <GasPkrReviewStep />}
                {phase === PHASE.CRYPTO_NETWORK && <GasCryptoNetworkStep />}
                {phase === PHASE.CRYPTO_QR      && <GasCryptoQRStep />}
                {phase === PHASE.PROCESSING     && <GasProcessingView />}
                {phase === PHASE.COMPLETE       && <GasCompleteView />}
              </div>
            </div>
          )}

        </div>
      </div>
    </GasFlowProvider>
  )
}
