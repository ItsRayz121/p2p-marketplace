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

import {
  PHASE, GasFlowProvider, type Phase, type PkrMethodKey,
} from './GasContext'
import { StepIndicator, validateAddress } from './GasPrimitives'
import { GasChainGrid }          from './GasChainGrid'
import { GasTokenStep }          from './GasTokenStep'
import { GasAmountStep }         from './GasAmountStep'
import { GasAddressStep }        from './GasAddressStep'
import { GasPaymentChoice }      from './GasPaymentChoice'
import { GasPkrMethodStep }      from './GasPkrMethodStep'
import { GasPkrProofStep }       from './GasPkrProofStep'
import { GasPkrReviewStep }      from './GasPkrReviewStep'
import { GasCryptoNetworkStep }  from './GasCryptoNetworkStep'
import { GasCryptoQRStep }       from './GasCryptoQRStep'
import { GasProcessingView }     from './GasProcessingView'
import { GasCompleteView }       from './GasCompleteView'

// localStorage pointer to the in-progress crypto order so a page refresh
// restores the payment screen instead of dumping the user back to step 1.
const ACTIVE_ORDER_KEY = 'gas_active_crypto_order'

/**
 * The gas order wizard. Rendered bare at /gas, and with an initial chain/token
 * seed by the pretty share routes (/gas/<chain>[/<token>]) — the seed is applied
 * exactly like a ?chain=/?token= deep link (see the resolver effect below).
 */
export function GasFlowClient({ initialChainSlug, initialTokenSymbol }: {
  initialChainSlug?: string
  initialTokenSymbol?: string
} = {}) {
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

  const { upload, uploading, error: uploadError, progress: uploadProgress } = useFileUpload('payment-proof')
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

  // ── Promo code (gas marketing — box only renders when the feature flag is live) ──
  const [promoEnabled, setPromoEnabled]   = useState(false)
  const [referralEnabled, setReferralEnabled] = useState(false)
  const [promoCode, setPromoCode]         = useState('')
  const [promoApplied, setPromoApplied]   = useState<{ code: string; discountUsdt: number; discountPct: number; slotsLeft: number | null; message: string } | null>(null)
  const [promoError, setPromoError]       = useState('')
  const [promoChecking, setPromoChecking] = useState(false)
  // ── KOL free-gas code (100% free — box only renders when the feature flag is live) ──
  const [freeCodeEnabled, setFreeCodeEnabled] = useState(false)
  const [freeCode, setFreeCode]               = useState('')
  const [freeCodeApplied, setFreeCodeApplied] = useState<{ code: string; kolLabel: string; amountNative: number; slotsLeft: number; budgetLeftUsdt: number; message: string } | null>(null)
  const [freeCodeError, setFreeCodeError]     = useState('')
  const [freeCodeChecking, setFreeCodeChecking] = useState(false)
  // Affiliate buyer auto-discount preview (margin-only, fetched for the logged-in buyer).
  const [affiliateQuote, setAffiliateQuote] = useState<{ discountUsdt: number; discountPct: number; referrerLabel: string } | null>(null)

  // ── Order tracking ─────────────────────────────────────────────────────────
  const [order, setOrder]               = useState<GasOrder | null>(null)
  const [pollErrCount, setPollErrCount] = useState(0)
  const idempKeyRef = useRef(`gas_${Date.now()}_${Math.random().toString(36).slice(2)}`)

  // ── Shareable deep link ────────────────────────────────────────────────────
  // /gas?chain=<slug>[&token=<symbol>] — opens the wizard pre-selected to that
  // chain (and token), skipping straight to the amount step. Fed by shared links
  // (web + Telegram startapp=G_… via parseStartParamToPath). Applied once.
  const deepLinkAppliedRef = useRef(false)
  const pendingTokenRef    = useRef<string | null>(null)

  // ── Cancellation ─────────────────────────────────────────────────────────────
  const [cancelling, setCancelling]       = useState(false)
  const [cancelError, setCancelError]     = useState('')
  const [cancelPreview, setCancelPreview] = useState<{ cancellable: boolean; priorCancels: number; thisCancelNumber: number; cooldownMs: number; cooldownLabel: string | null } | null>(null)
  const [cancelResult, setCancelResult]   = useState<{ cooldownLabel: string | null } | null>(null)
  const [requestingRefund, setRequestingRefund] = useState(false)
  const [refundReqError, setRefundReqError]     = useState('')

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
  // Effective (post-promo) totals — the discount only ever reduces the platform
  // margin, never below the base gas cost (enforced server-side). When no promo is
  // applied these equal the computed totals.
  const promoDiscountUsd = promoApplied ? Math.min(promoApplied.discountUsdt, computedUsd) : 0
  // Affiliate buyer discount fills the margin REMAINING after any promo — mirrors the
  // server (affiliateOrderDiscount), so the previewed total matches the charged total.
  const affiliateDiscountUsd = affiliateQuote
    ? Math.max(0, Math.min(affiliateQuote.discountUsdt, platformFeeUsdt - promoDiscountUsd))
    : 0
  const totalDiscountUsd = promoDiscountUsd + affiliateDiscountUsd
  const effectiveUsd     = Math.max(0, computedUsd - totalDiscountUsd)
  const effectivePkr     = effectiveUsd * usdPkrRate
  const maxUsd          = selectedToken?.maxUsdValue ?? 10
  const minAmount       = selectedToken?.minAmount ?? 0.1
  const usdExceeded     = gasValueUsd > maxUsd && amountNum > 0
  const isPkrOrder      = order?.paymentCoin === 'PKR'
  const explorerBase    = tokenData?.chain?.explorerBase ?? null

  // ── Effects ────────────────────────────────────────────────────────────────

  useEffect(() => {
    gasApi.getChains()
      .then(({ chains: c, promoEnabled: pe, referralEnabled: re, freeCodeEnabled: fe }) => { setChains(c); setPromoEnabled(!!pe); setReferralEnabled(!!re); setFreeCodeEnabled(!!fe) })
      .catch((e: Error) => setChainsError(e.message || 'Failed to load chains'))
      .finally(() => setChainsLoading(false))
  }, [])

  // Apply the deep link once the chain list is in. The selection comes from the
  // pretty route props (/gas/<chain>[/<token>]) when present, else the ?chain=/
  // ?token= query params. An in-progress ?order= restore (handled separately
  // below) always wins. An unknown / inactive chain silently falls back to the
  // chain grid with a cleaned URL.
  useEffect(() => {
    if (deepLinkAppliedRef.current || chains.length === 0) return

    let qs: URLSearchParams
    try { qs = new URLSearchParams(window.location.search) } catch { qs = new URLSearchParams() }
    if (qs.get('order')) return                       // order-restore owns this load

    const fromProps  = !!initialChainSlug
    const chainParam = initialChainSlug ?? qs.get('chain')
    if (!chainParam) { deepLinkAppliedRef.current = true; return }

    deepLinkAppliedRef.current = true

    // A shared gas link doubles as a referral link — mirror ReferralCapture here
    // so the code is stashed before we strip the query string (no mount-order race).
    try {
      const ref = qs.get('ref')
      const isAuthed = document.cookie.split('; ').some((c) => c.startsWith('rupchain_auth='))
      if (ref && !isAuthed && !localStorage.getItem('referralCode') && /^[A-Za-z0-9_-]{1,64}$/.test(ref)) {
        localStorage.setItem('referralCode', ref)
      }
    } catch { /* best-effort */ }

    // Strip the query string. Keep the pretty path (/gas/<chain>/<token>) as-is —
    // a refresh there just re-seeds identically; only /gas?… collapses to /gas.
    const cleanUrl = () => {
      try { window.history.replaceState(null, '', fromProps ? window.location.pathname : '/gas') } catch { /* */ }
    }

    const chain = chains.find((c) => c.slug.toLowerCase() === chainParam.toLowerCase())
    if (!chain || !chain.isActive) { cleanUrl(); return }

    const tokenParam = initialTokenSymbol ?? qs.get('token')
    if (tokenParam) pendingTokenRef.current = tokenParam
    handleSelectChain(chain)                          // sets chain, fetches tokens, → TOKEN step
    cleanUrl()
  // handleSelectChain is stable enough for this one-shot; re-running on its identity
  // would be a no-op thanks to deepLinkAppliedRef.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chains])

  // Second half of the deep link: once the chain's tokens load, select the one
  // named in ?token= (case-insensitive symbol match) and jump to the amount step.
  // An unmatched symbol just leaves the user on the token picker.
  useEffect(() => {
    const want = pendingTokenRef.current
    if (!want || !tokenData) return
    pendingTokenRef.current = null
    const t = tokenData.tokens.find((x) => x.symbol.toLowerCase() === want.toLowerCase() && x.isActive)
    if (t) { setSelectedToken(t); setPhase(PHASE.AMOUNT) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenData])

  // Any change to the order parameters invalidates a previously-applied promo, so it
  // is re-validated server-side (the source of truth) before it can affect the price.
  useEffect(() => { setPromoApplied(null); setPromoError('') }, [amount, selectedToken?.id])
  // Free-code eligibility only depends on the selected chain/token (the gift
  // amount is fixed by the code, not by whatever the user typed) — so, unlike
  // promo, this does NOT reset when `amount` changes.
  useEffect(() => { setFreeCodeApplied(null); setFreeCodeError('') }, [selectedToken?.id])

  // Fetch the logged-in buyer's affiliate auto-discount for the selected token so the
  // checkout breakdown can surface it. No-op for guests / unbound users (returns null).
  useEffect(() => {
    // The affiliate program rides on the referral engine — skip the lookup entirely when
    // referrals are off (the whole program is then inert), for guests, or with no token.
    if (!user || !selectedToken || !referralEnabled) { setAffiliateQuote(null); return }
    let cancelled = false
    gasApi.getAffiliateQuote(selectedToken.id)
      .then((q) => { if (!cancelled) setAffiliateQuote(q) })
      .catch(() => { if (!cancelled) setAffiliateQuote(null) })
    return () => { cancelled = true }
  }, [user, selectedToken?.id, referralEnabled])

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

  async function applyPromo() {
    if (!selectedToken || !promoCode.trim() || !(parseFloat(amount) > 0)) return
    setPromoChecking(true); setPromoError(''); setPromoApplied(null)
    try {
      const res = await gasApi.previewPromo({
        promoCode: promoCode.trim(), tokenConfigId: selectedToken.id, amount: parseFloat(amount),
      })
      setPromoApplied(res)
    } catch (e: unknown) {
      setPromoError(e instanceof Error ? e.message : 'Invalid promo code')
    } finally { setPromoChecking(false) }
  }

  function clearPromo() { setPromoApplied(null); setPromoCode(''); setPromoError('') }

  async function applyFreeCode() {
    if (!selectedToken || !freeCode.trim()) return
    setFreeCodeChecking(true); setFreeCodeError(''); setFreeCodeApplied(null)
    try {
      const res = await gasApi.previewFreeCode({
        freeCode: freeCode.trim(), tokenConfigId: selectedToken.id,
      })
      setFreeCodeApplied(res)
    } catch (e: unknown) {
      setFreeCodeError(e instanceof Error ? e.message : 'Invalid code')
    } finally { setFreeCodeChecking(false) }
  }

  function clearFreeCode() { setFreeCodeApplied(null); setFreeCode(''); setFreeCodeError('') }

  async function handleCreatePkrOrder() {
    if (!selectedToken || !selectedChain || !selectedPkrMethod) return
    setCreatingPkr(true); setPkrError('')
    try {
      const o = await gasApi.createPkrOrder({
        tokenConfigId: selectedToken.id, amount: parseFloat(amount),
        toAddress: address, pkrPaymentMethod: selectedPkrMethod,
        idempotencyKey: `${idempKeyRef.current}_pkr`,
        ...(freeCodeApplied ? { freeCode: freeCodeApplied.code } : promoApplied ? { promoCode: promoApplied.code } : {}),
      })
      setOrder(o); setPollErrCount(0)
      // A free-code order is created already delivering (no payment step) — skip
      // straight to the processing/tracking screen instead of the PKR proof screen.
      setPhase(o.isFreeGrant ? PHASE.PROCESSING : PHASE.PKR_PROOF)
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
        ...(freeCodeApplied ? { freeCode: freeCodeApplied.code } : promoApplied ? { promoCode: promoApplied.code } : {}),
      })
      setOrder(o); setPollErrCount(0); setQrFailed(false); setPaymentSent(false)
      if (o.isFreeGrant) {
        // A free-code order is created already delivering (no payment/QR step) —
        // skip straight to the processing/tracking screen.
        setPhase(PHASE.PROCESSING)
      } else {
        setPhase(PHASE.CRYPTO_QR)
        try { localStorage.setItem(ACTIVE_ORDER_KEY, JSON.stringify({ orderRef: o.orderRef, trackingToken: o.trackingToken ?? null })) } catch { /* storage unavailable */ }
      }
    } catch (e: unknown) { setCryptoError(e instanceof Error ? e.message : 'Failed to create order') }
    finally { setCreatingCrypto(false) }
  }

  // A free-code order has nothing to pay, so there is no payment method to pick —
  // claim it directly on the "Choose How You Want to Pay" screen with one button.
  // Routed through the crypto order path (no PKR method to ask for either); the
  // network only matters for a real payment, so it's picked automatically —
  // BEP20 when configured, else Aptos, which is always available.
  async function handleClaimFreeCode() {
    if (!selectedToken || !freeCodeApplied) return
    setCreatingCrypto(true); setCryptoError('')
    try {
      const network: 'BEP20' | 'APTOS' = cryptoMethods?.bep20?.address ? 'BEP20' : 'APTOS'
      const o = await gasApi.createCryptoOrder({
        tokenConfigId: selectedToken.id, amount: parseFloat(amount),
        toAddress: address, paymentNetwork: network,
        idempotencyKey: `${idempKeyRef.current}_crypto`,
        freeCode: freeCodeApplied.code,
      })
      setOrder(o); setPollErrCount(0)
      setPhase(PHASE.PROCESSING)
    } catch (e: unknown) { setCryptoError(e instanceof Error ? e.message : 'Failed to claim free gas') }
    finally { setCreatingCrypto(false) }
  }

  // Restore an in-progress crypto order so the user lands back on the EXACT payment
  // screen they left (QR + countdown / processing) instead of a read-only summary.
  // Two entry points:
  //   1. ?order=<ref>[&token=<t>] — deep link from "My Orders" (resume an order).
  //   2. ACTIVE_ORDER_KEY localStorage — same-browser refresh of /gas mid-payment.
  // The detection timer itself is persisted per-order so the countdown survives too.
  useEffect(() => {
    let cancelled = false

    // Prefer an explicit ?order= deep link, else the refresh-restore pointer.
    let orderRef: string | undefined
    let trackingToken: string | null | undefined
    let fromUrl = false
    try {
      const qs = new URLSearchParams(window.location.search)
      const qOrder = qs.get('order')
      if (qOrder) { orderRef = qOrder; trackingToken = qs.get('token'); fromUrl = true }
    } catch { /* window/URL unavailable */ }

    if (!orderRef) {
      let raw: string | null = null
      try { raw = localStorage.getItem(ACTIVE_ORDER_KEY) } catch { /* storage unavailable */ }
      if (!raw) return
      try {
        const saved = JSON.parse(raw) as { orderRef?: string; trackingToken?: string | null }
        orderRef = saved.orderRef
        trackingToken = saved.trackingToken
      } catch { try { localStorage.removeItem(ACTIVE_ORDER_KEY) } catch { /* */ } return }
    }
    if (!orderRef) return

    // Strip the ?order= param so a refresh/back doesn't keep forcing a restore and
    // the address bar stays clean — the localStorage pointer keeps refresh working.
    if (fromUrl) {
      try { window.history.replaceState(null, '', '/gas') } catch { /* */ }
    }

    ;(async () => {
      try {
        const o = await gasApi.getOrder(orderRef!, trackingToken ?? undefined)
        if (cancelled) return
        if (o.status === 'payment_pending') {
          setOrder(o); setPhase(PHASE.CRYPTO_QR)
          // Re-arm the refresh-restore pointer when resuming from a deep link.
          try { localStorage.setItem(ACTIVE_ORDER_KEY, JSON.stringify({ orderRef: o.orderRef, trackingToken: o.trackingToken ?? null })) } catch { /* */ }
        } else if (['payment_detected', 'sending', 'payment_verified'].includes(o.status)) {
          setOrder(o); setPhase(PHASE.PROCESSING)
        } else {
          // Terminal, or proof already submitted → tracking page owns it from here.
          try { localStorage.removeItem(ACTIVE_ORDER_KEY) } catch { /* */ }
          if (fromUrl || o.status === 'payment_uploaded') {
            const t = o.trackingToken ? `?token=${encodeURIComponent(o.trackingToken)}` : ''
            router.replace(`/gas/orders/${o.orderRef}${t}`)
          }
        }
      } catch {
        try { localStorage.removeItem(ACTIVE_ORDER_KEY) } catch { /* */ }
        // A failed deep-link restore (e.g. not found) → send to the tracking page.
        if (fromUrl && orderRef) router.replace(`/gas/orders/${orderRef}`)
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

  const loadCancelPreview = useCallback(async () => {
    if (!order?.orderRef) return
    try {
      const p = await gasApi.getCancelPreview(order.orderRef, order.trackingToken ?? undefined)
      setCancelPreview(p)
    } catch { /* preview is best-effort; the confirm dialog still works without it */ }
  }, [order?.orderRef, order?.trackingToken])

  async function handleCancelOrder() {
    if (!order?.orderRef) return
    setCancelling(true); setCancelError('')
    try {
      const res = await gasApi.cancelOrder(order.orderRef, order.trackingToken ?? undefined)
      setCancelResult({ cooldownLabel: res.cooldownLabel })
      setOrder(prev => prev ? { ...prev, status: 'cancelled' } : prev)
      try { localStorage.removeItem(ACTIVE_ORDER_KEY) } catch { /* */ }
    } catch (e: unknown) {
      setCancelError(e instanceof Error ? e.message : 'Failed to cancel order')
    } finally { setCancelling(false) }
  }

  async function handleRequestRefund() {
    if (!order?.orderRef) return
    setRequestingRefund(true); setRefundReqError('')
    try {
      await gasApi.requestRefund(order.orderRef, order.trackingToken ?? undefined)
      setOrder(prev => prev ? { ...prev, status: 'refund_pending' } : prev)
    } catch (e: unknown) {
      setRefundReqError(e instanceof Error ? e.message : 'Failed to request refund')
    } finally { setRequestingRefund(false) }
  }

  const isTerminal = order && ['delivered', 'failed', 'expired', 'refunded', 'cancelled'].includes(order.status)
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
    setCancelling(false); setCancelError(''); setCancelPreview(null); setCancelResult(null)
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
    proofUrl, setProofUrl, submittingProof, proofError, uploading, uploadProgress, uploadError,
    handleCreatePkrOrder, handleUploadFile, handleSubmitProof,
    selectedCryptoNetwork, setSelectedCryptoNetwork, creatingCrypto, cryptoError,
    qrFailed, setQrFailed, paymentSent, setPaymentSent,
    verifyOpen, setVerifyOpen, verifyTxHash, setVerifyTxHash,
    verifying, verifyError, verifySuccess,
    handleCreateCryptoOrder, handleVerifyPayment, pollOrder, handleClaimFreeCode,
    cancelling, cancelError, cancelPreview, cancelResult, loadCancelPreview, handleCancelOrder,
    requestingRefund, refundReqError, handleRequestRefund,
    order, setOrder, pollErrCount, setPollErrCount,
    priceUsd, pricePkr, platformFeeUsdt, amountNum, gasValueUsd, usdPkrRate,
    totalUsd, computedUsd, computedPkr, effectiveUsd, effectivePkr, promoDiscountUsd, maxUsd, minAmount, usdExceeded,
    affiliateDiscountUsd, affiliateQuote,
    isPkrOrder, explorerBase, chainGroups, getPkrDetails,
    promoEnabled, promoCode, setPromoCode, promoApplied, promoError, promoChecking, applyPromo, clearPromo,
    freeCodeEnabled, freeCode, setFreeCode, freeCodeApplied, freeCodeError, freeCodeChecking, applyFreeCode, clearFreeCode,
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <GasFlowProvider value={ctx}>
      <div className="bg-canvas">

        {/* Slim quick-action bar — the page title now lives in the global navbar
            (above) and the "Select Blockchain" heading below, so this bar just
            carries the gas quick-actions (Earn / My Orders), right-aligned so
            they sit tucked under the avatar on both desktop and mobile. Renders
            only when there's at least one action to show. */}
        {(user || referralEnabled) && (
          <div className="bg-surface border-b border-border">
            <div className="max-w-5xl mx-auto px-4 py-2 flex items-center justify-end gap-2">
              {referralEnabled && (
                <Link href="/referral" className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-secondary transition-colors px-2 py-1.5">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8V6m0 8v2" /></svg>
                  Earn
                </Link>
              )}
              {user && (
                <Link href="/gas/orders" className="flex items-center gap-1.5 text-xs text-primary font-semibold border border-primary/20 rounded-lg px-3 py-1.5 hover:bg-primary/5 transition-colors">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
                  My Orders
                </Link>
              )}
            </div>
          </div>
        )}

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
