'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import {
  gasApi,
  type GasChain, type GasToken, type GasTokensResponse, type GasOrder,
  type GasPkrMethods, type GasCryptoMethods, type GasNetworkFee,
} from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Badge } from '@/components/ui/Badge'
import { CountdownTimer } from '@/components/ui/CountdownTimer'
import { CopyButton } from '@/components/ui/CopyButton'
import { Spinner } from '@/components/ui/Spinner'
import { usePolling } from '@/hooks/usePolling'
import { useFileUpload } from '@/hooks/useFileUpload'

// ─── Constants ────────────────────────────────────────────────────────────────

const PHASE = {
  CHAINS:         0,
  TOKEN:          1,
  AMOUNT:         2,
  ADDRESS:        3,
  PAY_METHOD:     4,
  PKR_METHOD:     5,
  PKR_DETAILS:    6,
  PKR_PROOF:      7,
  PKR_REVIEW:     8,
  CRYPTO_NETWORK: 9,
  CRYPTO_QR:      10,
  PROCESSING:     11,
  COMPLETE:       12,
} as const

type Phase = typeof PHASE[keyof typeof PHASE]

// ─── Address validation ───────────────────────────────────────────────────────

const ADDRESS_PATTERNS: Record<string, RegExp> = {
  TRC20: /^T[A-Za-z1-9]{33}$/,
  EVM:   /^0x[0-9a-fA-F]{40}$/,
  SOL:   /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  SUI:   /^0x[0-9a-fA-F]{64}$/,
  TON:   /^[UE][Qq][A-Za-z0-9+/\-_]{46}$/,
}

function validateAddress(addr: string, addressType: string): boolean {
  const p = ADDRESS_PATTERNS[addressType]
  return p ? p.test(addr) : addr.length > 5
}

function addressPlaceholder(addressType: string): string {
  switch (addressType) {
    case 'TRC20': return 'T... (34 characters)'
    case 'EVM':   return '0x... (42 characters)'
    case 'SOL':   return 'Base58 address (32–44 characters)'
    case 'SUI':   return '0x... (66 characters)'
    case 'TON':   return 'UQ... or EQ... (48 characters)'
    default:      return 'Enter wallet address'
  }
}

// ─── Explorer URL helper ───────────────────────────────────────────────────────

function explorerUrl(chain: string, explorerBase: string | null, txHash: string): string {
  if (!explorerBase) return '#'
  return chain === 'TRON' ? `${explorerBase}/transaction/${txHash}` : `${explorerBase}/tx/${txHash}`
}


// ─── Status labels ────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  payment_pending:  'Awaiting Payment',
  payment_uploaded: 'Proof Submitted',
  payment_detected: 'Payment Confirmed',
  sending:          'Delivering...',
  delivered:        'Completed',
  failed:           'Failed',
  expired:          'Expired',
  refund_pending:   'Refund Processing',
  refunded:         'Refunded',
}

function statusVariant(s: string): 'warning' | 'success' | 'danger' | 'default' {
  if (s === 'delivered' || s === 'refunded') return 'success'
  if (s === 'failed' || s === 'expired') return 'danger'
  if (['payment_detected', 'sending', 'refund_pending', 'payment_uploaded'].includes(s)) return 'warning'
  return 'default'
}

// ─── Chain category colours ───────────────────────────────────────────────────

const CAT_COLORS: Record<string, { gradient: string }> = {
  tron:      { gradient: 'from-red-400 to-red-600' },
  bnb:       { gradient: 'from-yellow-400 to-yellow-600' },
  ethereum:  { gradient: 'from-blue-400 to-blue-600' },
  solana:    { gradient: 'from-purple-400 to-purple-600' },
  sui:       { gradient: 'from-cyan-400 to-cyan-600' },
  ton:       { gradient: 'from-sky-400 to-sky-600' },
  avalanche: { gradient: 'from-red-400 to-red-600' },
  polygon:   { gradient: 'from-violet-400 to-violet-600' },
  arbitrum:  { gradient: 'from-blue-500 to-indigo-600' },
  optimism:  { gradient: 'from-rose-400 to-red-600' },
  base:      { gradient: 'from-blue-600 to-blue-800' },
  bitcoin:   { gradient: 'from-orange-400 to-orange-600' },
  xrp:       { gradient: 'from-slate-400 to-slate-600' },
  cosmos:    { gradient: 'from-indigo-400 to-purple-600' },
}

const CAT_LABELS: Record<string, string> = {
  tron: 'TRON', bnb: 'BNB Chain', ethereum: 'Ethereum',
  solana: 'Solana', sui: 'SUI', ton: 'TON', avalanche: 'Avalanche', polygon: 'Polygon',
  arbitrum: 'Arbitrum', optimism: 'Optimism', base: 'Base',
  bitcoin: 'Bitcoin', xrp: 'XRP Ledger', cosmos: 'Cosmos',
}

function catGradient(cat: string) {
  return CAT_COLORS[cat]?.gradient ?? 'from-gray-400 to-gray-600'
}

// ─── Processing steps ──────────────────────────────────────────────────────────

const STEPS_CRYPTO = ['Payment Received', 'Verifying Payment', 'Processing Order', 'Releasing Gas Fee', 'Completed']
const STEPS_PKR    = ['Order Created', 'Proof Submitted', 'Payment Verified', 'Releasing Gas Fee', 'Completed']

function getActiveStep(status: string): number {
  if (status === 'payment_pending')  return 0
  if (status === 'payment_uploaded') return 1
  if (status === 'payment_detected') return 2
  if (status === 'sending')          return 3
  if (status === 'delivered')        return 4
  return 0
}

// ─── Chain Logo ───────────────────────────────────────────────────────────────

function ChainLogo({ chain, sizeCls = 'w-11 h-11' }: { chain: GasChain; sizeCls?: string }) {
  if (chain.logoUrl) {
    return <img src={chain.logoUrl} alt={chain.symbol} className={`${sizeCls} rounded-full object-contain`} onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
  }
  return (
    <div className={`${sizeCls} rounded-full bg-gradient-to-br ${catGradient(chain.category)} text-white font-bold text-xs flex items-center justify-center flex-shrink-0`}>
      {chain.symbol.slice(0, 3)}
    </div>
  )
}

function TokenLogo({ token, cat, sizeCls = 'w-10 h-10' }: { token: GasToken; cat: string; sizeCls?: string }) {
  if (token.logoUrl) {
    return <img src={token.logoUrl} alt={token.symbol} className={`${sizeCls} rounded-full object-contain`} onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
  }
  return (
    <div className={`${sizeCls} rounded-full bg-gradient-to-br ${catGradient(cat)} text-white font-bold text-xs flex items-center justify-center flex-shrink-0`}>
      {token.symbol.slice(0, 3)}
    </div>
  )
}

// ─── Step indicator ───────────────────────────────────────────────────────────

const STEP_NAMES = ['Chain', 'Token', 'Amount', 'Address', 'Payment']

function StepIndicator({ phase }: { phase: Phase }) {
  const idx = Math.min(Math.max(phase - 1, 0), 4)
  return (
    <div className="flex items-center justify-center gap-1 mb-5">
      {STEP_NAMES.map((name, i) => (
        <div key={name} className="flex items-center gap-1">
          <div className={`flex items-center gap-1.5 transition-opacity ${i <= idx ? 'opacity-100' : 'opacity-35'}`}>
            <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
              i < idx ? 'bg-purple-600 text-white' : i === idx ? 'bg-purple-600 text-white ring-4 ring-purple-100' : 'bg-gray-100 text-gray-400'
            }`}>
              {i < idx ? <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg> : i + 1}
            </div>
            <span className={`hidden sm:block text-xs font-medium ${i === idx ? 'text-purple-600' : 'text-gray-400'}`}>{name}</span>
          </div>
          {i < STEP_NAMES.length - 1 && <div className={`w-5 h-px mx-1 ${i < idx ? 'bg-purple-500' : 'bg-gray-200'}`} />}
        </div>
      ))}
    </div>
  )
}

// ─── Chain grid skeleton ──────────────────────────────────────────────────────

function ChainSkeleton() {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3">
      {Array.from({ length: 10 }).map((_, i) => <div key={i} className="animate-pulse bg-gray-100 rounded-2xl h-28" />)}
    </div>
  )
}

// ─── Back button ──────────────────────────────────────────────────────────────

function BackBtn({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="text-gray-400 hover:text-gray-600 transition-colors">
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
      </svg>
    </button>
  )
}

// ─── Card step header ─────────────────────────────────────────────────────────

function CardHeader({ onBack, title, sub }: { onBack?: () => void; title: string; sub?: string }) {
  return (
    <div className="flex items-center gap-3 pb-3 border-b border-gray-100">
      {onBack && <BackBtn onClick={onBack} />}
      <div>
        <p className="text-sm font-bold text-gray-900">{title}</p>
        {sub && <p className="text-xs text-gray-500 mt-0.5">{sub}</p>}
      </div>
    </div>
  )
}

// ─── Processing timeline ───────────────────────────────────────────────────────

function ProcessingTimeline({ status, isPkr }: { status: string; isPkr: boolean }) {
  const steps = isPkr ? STEPS_PKR : STEPS_CRYPTO
  const active = getActiveStep(status)
  return (
    <div className="space-y-3">
      {steps.map((label, i) => {
        const done = i < active, cur = i === active
        return (
          <div key={label} className="flex items-center gap-3">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 transition-all ${
              done ? 'bg-green-500 text-white' : cur ? 'bg-purple-600 text-white ring-4 ring-purple-100' : 'bg-gray-100 text-gray-300'
            }`}>
              {done
                ? <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                : cur
                ? <div className="w-3 h-3 rounded-full bg-white animate-pulse" />
                : <div className="w-2 h-2 rounded-full bg-gray-300" />
              }
            </div>
            <p className={`text-sm font-semibold flex-1 ${done ? 'text-green-600' : cur ? 'text-purple-700' : 'text-gray-400'}`}>{label}</p>
            {cur && <Spinner size="sm" />}
          </div>
        )
      })}
    </div>
  )
}

// ─── Custom Gas Fee Request ───────────────────────────────────────────────────

function CustomGasRequest() {
  const [open, setOpen]     = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError]   = useState('')
  const [form, setForm]     = useState({ blockchainName: '', token: '', amount: '', purpose: '', urgency: 'normal', details: '', contactEmail: '' })

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.blockchainName || !form.token || !form.purpose) return
    setSubmitting(true); setError('')
    try {
      await gasApi.submitCustomRequest({ blockchainName: form.blockchainName, token: form.token, amount: form.amount || undefined, purpose: form.purpose, urgency: form.urgency, details: form.details || undefined, contactEmail: form.contactEmail || undefined })
      setSubmitted(true)
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Failed to submit') }
    finally { setSubmitting(false) }
  }

  return (
    <div className="mt-6">
      {!open && (
        <div className="border border-dashed border-purple-200 rounded-2xl p-4 flex flex-col sm:flex-row items-center justify-between gap-3 bg-purple-50/50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-purple-100 flex items-center justify-center text-purple-600 flex-shrink-0 text-xl">+</div>
            <div>
              <p className="text-sm font-semibold text-gray-800">Can't find your blockchain?</p>
              <p className="text-xs text-gray-500">Request custom gas fee for any blockchain</p>
            </div>
          </div>
          <button onClick={() => setOpen(true)} className="px-4 py-2 rounded-xl border border-purple-300 text-purple-700 text-sm font-semibold hover:bg-purple-100 transition-colors flex-shrink-0">
            Request Custom Gas Fee
          </button>
        </div>
      )}

      {open && (
        <div className="border border-purple-200 rounded-2xl overflow-hidden bg-white shadow-sm">
          <div className="flex items-center justify-between px-5 py-4 bg-gradient-to-r from-purple-50 to-blue-50 border-b border-purple-100">
            <p className="text-sm font-bold text-gray-900">Custom Gas Fee Request</p>
            <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
          {submitted ? (
            <div className="p-8 text-center">
              <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-3">
                <svg className="w-7 h-7 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
              </div>
              <p className="text-base font-bold text-gray-900 mb-1">Request Submitted!</p>
              <p className="text-sm text-gray-500">Our team will review and contact you within 24 hours.</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
              {[
                { label: 'Blockchain Name *', key: 'blockchainName', placeholder: 'e.g., zkSync, TON, Scroll' },
                { label: 'Token Needed *',    key: 'token',           placeholder: 'e.g., USDT, USDC, ETH' },
                { label: 'Amount Needed',     key: 'amount',          placeholder: 'e.g., 10 USDT' },
                { label: 'Contact Email',     key: 'contactEmail',    placeholder: 'your@email.com' },
              ].map(f => (
                <div key={f.key}>
                  <label className="block text-xs font-semibold text-gray-700 mb-1.5">{f.label}</label>
                  <input type={f.key === 'contactEmail' ? 'email' : 'text'} placeholder={f.placeholder} value={(form as Record<string,string>)[f.key]} onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))}
                    className="w-full px-3 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300" required={f.key === 'blockchainName' || f.key === 'token'} />
                </div>
              ))}
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1.5">Purpose *</label>
                <select value={form.purpose} onChange={e => setForm(p => ({ ...p, purpose: e.target.value }))} required
                  className="w-full px-3 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300 bg-white">
                  <option value="">Select purpose</option>
                  <option value="wallet_activation">Wallet Activation</option>
                  <option value="airdrop_gas">Airdrop Gas Refill</option>
                  <option value="token_transfer">Token Transfer</option>
                  <option value="bridge">Bridge Transaction</option>
                  <option value="nft_mint">NFT Mint</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1.5">Urgency</label>
                <select value={form.urgency} onChange={e => setForm(p => ({ ...p, urgency: e.target.value }))}
                  className="w-full px-3 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300 bg-white">
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="urgent">Urgent</option>
                </select>
              </div>
              <div className="sm:col-span-2">
                <label className="block text-xs font-semibold text-gray-700 mb-1.5">Additional Details</label>
                <textarea rows={3} maxLength={500} placeholder="Describe your requirements..." value={form.details} onChange={e => setForm(p => ({ ...p, details: e.target.value }))}
                  className="w-full px-3 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300 resize-none" />
                <p className="text-right text-xs text-gray-400">{form.details.length}/500</p>
              </div>
              {error && <p className="sm:col-span-2 text-sm text-red-500">{error}</p>}
              <div className="sm:col-span-2 flex gap-3">
                <button type="button" onClick={() => setOpen(false)} className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-gray-600 hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={submitting || !form.blockchainName || !form.token || !form.purpose}
                  className="flex-1 py-2.5 rounded-xl bg-purple-600 text-white text-sm font-semibold hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2">
                  {submitting ? <Spinner size="sm" /> : 'Submit Request'}
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  )
}

// ─── PKR payment method details ───────────────────────────────────────────────

const PKR_METHOD_META = {
  bank_transfer: { icon: '🏦', label: 'Bank Transfer',  color: 'blue',   desc: 'Direct bank account transfer' },
  easypaisa:     { icon: '📱', label: 'Easypaisa',      color: 'green',  desc: 'Pay via Easypaisa mobile wallet' },
  jazzcash:      { icon: '📲', label: 'JazzCash',       color: 'red',    desc: 'Pay via JazzCash mobile wallet' },
} as const

type PkrMethodKey = keyof typeof PKR_METHOD_META

// ─── Main Page Component ──────────────────────────────────────────────────────

export default function GasPage() {
  const { user }  = useAuth()

  // ── Navigation phase ────────────────────────────────────────────────────────
  const [phase, setPhase] = useState<Phase>(PHASE.CHAINS)

  // ── Step 0: Chains ──────────────────────────────────────────────────────────
  const [chains, setChains]         = useState<GasChain[]>([])
  const [chainsLoading, setChainsLoading] = useState(true)
  const [chainsError, setChainsError]     = useState('')
  const [selectedChain, setSelectedChain] = useState<GasChain | null>(null)

  // ── Step 1: Tokens ──────────────────────────────────────────────────────────
  const [tokenData, setTokenData]         = useState<GasTokensResponse | null>(null)
  const [tokensLoading, setTokensLoading] = useState(false)
  const [tokensError, setTokensError]     = useState('')
  const [selectedToken, setSelectedToken] = useState<GasToken | null>(null)

  // ── Step 2: Amount ──────────────────────────────────────────────────────────
  const [amount, setAmount]       = useState('')
  const [amountError, setAmountError] = useState('')

  // ── Step 3: Address ─────────────────────────────────────────────────────────
  const [address, setAddress]         = useState('')
  const [addressError, setAddressError] = useState('')

  // ── Step 4: Payment method ──────────────────────────────────────────────────
  const [pkrMethods, setPkrMethods]       = useState<GasPkrMethods | null>(null)
  const [cryptoMethods, setCryptoMethods] = useState<GasCryptoMethods | null>(null)
  const [methodsLoading, setMethodsLoading] = useState(false)

  // ── PKR sub-flow ────────────────────────────────────────────────────────────
  const [selectedPkrMethod, setSelectedPkrMethod] = useState<PkrMethodKey | null>(null)
  const [creatingPkr, setCreatingPkr]   = useState(false)
  const [pkrError, setPkrError]         = useState('')

  // ── Live network fee (fetched when reaching address step) ───────────────────
  const [networkFee, setNetworkFee] = useState<GasNetworkFee | null>(null)

  // ── Proof upload ────────────────────────────────────────────────────────────
  const { upload, uploading, error: uploadError } = useFileUpload('payment-proof')
  const [proofUrl, setProofUrl]       = useState('')
  const [submittingProof, setSubmittingProof] = useState(false)
  const [proofError, setProofError]   = useState('')

  // ── Crypto sub-flow ─────────────────────────────────────────────────────────
  const [selectedCryptoNetwork, setSelectedCryptoNetwork] = useState<'TRC20' | 'BEP20' | 'ERC20' | 'APTOS' | null>(null)
  const [creatingCrypto, setCreatingCrypto] = useState(false)
  const [cryptoError, setCryptoError]       = useState('')
  const [qrFailed, setQrFailed]             = useState(false)

  // ── Manual payment verification ─────────────────────────────────────────────
  const [paymentSent, setPaymentSent]   = useState(false)
  const [verifyOpen, setVerifyOpen]     = useState(false)
  const [verifyTxHash, setVerifyTxHash] = useState('')
  const [verifying, setVerifying]       = useState(false)
  const [verifyError, setVerifyError]   = useState('')
  const [verifySuccess, setVerifySuccess] = useState('')

  // ── Order tracking ──────────────────────────────────────────────────────────
  const [order, setOrder]               = useState<GasOrder | null>(null)
  const [pollErrCount, setPollErrCount] = useState(0)
  const idempKeyRef = useRef(`gas_${Date.now()}_${Math.random().toString(36).slice(2)}`)

  // ── Computed ────────────────────────────────────────────────────────────────
  const rawUsdPrice    = selectedToken?.rawUsdPrice ?? selectedToken?.priceUsd ?? 0
  const priceUsd       = rawUsdPrice   // raw market rate — no markup
  const pricePkr       = selectedToken?.pricePkr ?? 0
  const platformFeeUsdt = selectedToken?.platformFeeUsdt ?? 0.25
  const amountNum      = parseFloat(amount) || 0
  const gasValueUsd    = amountNum * priceUsd
  // usdPkrRate derived from token data (pricePkr = priceUsd * usdPkrRate)
  const usdPkrRate     = priceUsd > 0 ? pricePkr / priceUsd : 0
  const totalUsd       = gasValueUsd + platformFeeUsdt
  const computedUsd    = totalUsd   // alias used throughout — total user pays
  const computedPkr    = totalUsd * usdPkrRate
  const maxUsd         = selectedToken?.maxUsdValue ?? 10
  const minAmount      = selectedToken?.minAmount   ?? 0.1
  const usdExceeded    = gasValueUsd > maxUsd && amountNum > 0

  const isPkrOrder  = order?.paymentCoin === 'PKR'
  const explorerBase = tokenData?.chain?.explorerBase ?? null

  // Load chains on mount
  useEffect(() => {
    gasApi.getChains()
      .then(({ chains: c }) => setChains(c))
      .catch((e: Error) => setChainsError(e.message || 'Failed to load chains'))
      .finally(() => setChainsLoading(false))
  }, [])

  // Load PKR + crypto methods when reaching payment method step
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

  // Fetch live network gas fee when the address step is reached (fee shown in order summary there)
  useEffect(() => {
    if (phase !== PHASE.ADDRESS || !selectedChain) return
    setNetworkFee(null)
    gasApi.getNetworkFee(selectedChain.slug)
      .then(fee => setNetworkFee(fee))
      .catch(() => setNetworkFee(null))
  }, [phase, selectedChain])

  const fetchTokens = useCallback(async (chain: GasChain) => {
    setTokensLoading(true); setTokensError(''); setTokenData(null); setSelectedToken(null)
    try {
      const data = await gasApi.getChainTokens(chain.slug)
      setTokenData(data)
      const activeTokens = data.tokens.filter((t) => t.isActive)
      if (activeTokens.length === 1) setSelectedToken(activeTokens[0])
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

  // ── Create PKR order ────────────────────────────────────────────────────────

  async function handleCreatePkrOrder() {
    if (!selectedToken || !selectedChain || !selectedPkrMethod) return
    setCreatingPkr(true); setPkrError('')
    try {
      const o = await gasApi.createPkrOrder({
        tokenConfigId:    selectedToken.id,
        amount:           parseFloat(amount),
        toAddress:        address,
        pkrPaymentMethod: selectedPkrMethod,
        idempotencyKey:   `${idempKeyRef.current}_pkr`,
      })
      setOrder(o)
      setPollErrCount(0)
      setPhase(PHASE.PKR_PROOF)
    } catch (e: unknown) { setPkrError(e instanceof Error ? e.message : 'Failed to create order') }
    finally { setCreatingPkr(false) }
  }

  // ── Submit PKR proof ────────────────────────────────────────────────────────

  async function handleUploadFile(file: File) {
    setProofError('')
    try {
      const url = await upload(file)
      setProofUrl(url)
    } catch { /* error already in uploadError */ }
  }

  async function handleSubmitProof() {
    if (!order || !proofUrl) return
    setSubmittingProof(true); setProofError('')
    try {
      await gasApi.submitProof(order.orderRef, proofUrl)
      setOrder(o => o ? { ...o, status: 'payment_uploaded' } : o)
      setPhase(PHASE.PKR_REVIEW)
    } catch (e: unknown) { setProofError(e instanceof Error ? e.message : 'Failed to submit proof') }
    finally { setSubmittingProof(false) }
  }

  // ── Create Crypto order ─────────────────────────────────────────────────────

  async function handleCreateCryptoOrder() {
    if (!selectedToken || !selectedCryptoNetwork) return
    setCreatingCrypto(true); setCryptoError('')
    try {
      const o = await gasApi.createCryptoOrder({
        tokenConfigId:  selectedToken.id,
        amount:         parseFloat(amount),
        toAddress:      address,
        paymentNetwork: selectedCryptoNetwork,
        idempotencyKey: `${idempKeyRef.current}_crypto`,
      })
      setOrder(o)
      setPollErrCount(0)
      setQrFailed(false)
      setPhase(PHASE.CRYPTO_QR)
    } catch (e: unknown) { setCryptoError(e instanceof Error ? e.message : 'Failed to create order') }
    finally { setCreatingCrypto(false) }
  }

  // ── Manual payment verification ─────────────────────────────────────────────

  async function handleVerifyPayment() {
    if (!order?.orderRef || !verifyTxHash.trim()) return
    setVerifying(true); setVerifyError(''); setVerifySuccess('')
    try {
      const res = await gasApi.verifyPayment(order.orderRef, verifyTxHash.trim())
      setVerifySuccess(res.message ?? 'Payment verified!')
      setOrder(prev => prev ? { ...prev, status: res.status as GasOrder['status'] } : prev)
      setVerifyOpen(false)
      setVerifyTxHash('')
    } catch (e: unknown) {
      setVerifyError(e instanceof Error ? e.message : 'Verification failed. Please check your transaction hash and try again.')
    } finally {
      setVerifying(false)
    }
  }

  // ── Order polling ───────────────────────────────────────────────────────────

  const pollOrder = useCallback(async () => {
    if (!order?.orderRef) return
    try {
      const o = await gasApi.getOrder(order.orderRef)
      // paymentAddress is re-derived server-side; keep prev value as safety net
      // in case the backend hasn't been deployed yet
      setOrder(prev => ({ ...o, paymentAddress: o.paymentAddress || prev?.paymentAddress || '' }))
      setPollErrCount(0)
      if (o.status === 'delivered')        setPhase(PHASE.COMPLETE)
      else if (o.status === 'payment_detected' || o.status === 'sending') setPhase(PHASE.PROCESSING)
    } catch { setPollErrCount(c => c + 1) }
  }, [order?.orderRef])

  const isTerminal = order && ['delivered', 'failed', 'expired', 'refunded'].includes(order.status)
  usePolling(pollOrder, 8_000, !!(order?.orderRef) && !isTerminal && ([PHASE.CRYPTO_QR, PHASE.PKR_REVIEW, PHASE.PROCESSING] as Phase[]).includes(phase))

  // ── Reset ───────────────────────────────────────────────────────────────────

  function resetFlow() {
    setPhase(PHASE.CHAINS)
    setSelectedChain(null); setSelectedToken(null); setTokenData(null)
    setAmount(''); setAmountError(''); setAddress(''); setAddressError('')
    setSelectedPkrMethod(null); setSelectedCryptoNetwork(null)
    setOrder(null); setPollErrCount(0)
    setPkrError(''); setCryptoError(''); setProofUrl(''); setProofError('')
    idempKeyRef.current = `gas_${Date.now()}_${Math.random().toString(36).slice(2)}`
  }

  // Group chains by category
  const chainGroups: Record<string, GasChain[]> = {}
  chains.forEach(c => { if (!chainGroups[c.category]) chainGroups[c.category] = []; chainGroups[c.category].push(c) })

  // ── PKR account details helper ───────────────────────────────────────────────

  function getPkrDetails() {
    if (!pkrMethods || !selectedPkrMethod) return null
    if (selectedPkrMethod === 'bank_transfer') {
      const b = pkrMethods.bank
      return [
        { label: 'Bank Name',       value: b.bankName },
        { label: 'Account Name',    value: b.accountName },
        { label: 'IBAN',            value: b.iban },
        { label: 'Account Number',  value: b.accountNumber },
      ].filter(r => r.value)
    }
    if (selectedPkrMethod === 'easypaisa') {
      const e = pkrMethods.easypaisa
      return [
        { label: 'Account Name',   value: e.name },
        { label: 'Mobile Number',  value: e.number },
      ].filter(r => r.value)
    }
    const j = pkrMethods.jazzcash
    return [
      { label: 'Account Name',   value: j.name },
      { label: 'Mobile Number',  value: j.number },
    ].filter(r => r.value)
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-50">

      {/* ── Sticky header ──────────────────────────────────────────────────── */}
      <div className="bg-white border-b border-gray-100 sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-purple-500 to-blue-600 flex items-center justify-center text-white font-bold text-lg">⚡</div>
            <div>
              <h1 className="text-base font-bold text-gray-900 leading-tight">Buy Gas Instantly</h1>
              <p className="text-xs text-gray-500">Pay with PKR or USDT</p>
            </div>
          </div>
          {user && (
            <Link href="/gas/orders" className="flex items-center gap-1.5 text-xs text-purple-600 font-semibold border border-purple-200 rounded-lg px-3 py-1.5 hover:bg-purple-50 transition-colors">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
              My Orders
            </Link>
          )}
        </div>
      </div>

      <div className={`mx-auto px-4 py-6 pb-16 ${phase === PHASE.CHAINS ? 'max-w-5xl' : 'max-w-xl'}`}>

        {/* ═══════════════════════════════════════════════════════════════════ */}
        {/* PHASE 0 — Blockchain Grid                                         */}
        {/* ═══════════════════════════════════════════════════════════════════ */}
        {phase === PHASE.CHAINS && (
          <div>
            <div className="text-center mb-6">
              <h2 className="text-xl font-bold text-gray-900">Select Blockchain</h2>
              <p className="text-sm text-gray-500 mt-1">Choose a blockchain to view gas fee and create gas orders</p>
            </div>

            {chainsLoading && <ChainSkeleton />}
            {chainsError   && <ErrorState title={chainsError} onRetry={() => { setChainsError(''); setChainsLoading(true); gasApi.getChains().then(({ chains: c }) => setChains(c)).catch((e: Error) => setChainsError(e.message)).finally(() => setChainsLoading(false)) }} />}

            {!chainsLoading && !chainsError && chains.length === 0 && (
              <div className="text-center py-16 px-4">
                <div className="text-5xl mb-4">⛽</div>
                <h3 className="text-lg font-semibold text-gray-800 mb-2">Gas Fee Service Unavailable</h3>
                <p className="text-sm text-gray-500 max-w-sm mx-auto">
                  No blockchain networks are currently active. Check back soon — we&apos;re working on expanding coverage.
                </p>
              </div>
            )}

            {!chainsLoading && !chainsError && chains.length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
                {chains.map(chain => {
                  const inactive = !chain.isActive || !chain.orderable
                  return (
                    <button
                      key={chain.id}
                      onClick={() => handleSelectChain(chain)}
                      disabled={inactive}
                      className={`group flex flex-col items-center justify-center gap-2.5 p-4 rounded-2xl border-2 text-center transition-all duration-200 h-full min-h-[150px] ${
                        inactive
                          ? 'opacity-50 cursor-not-allowed border-gray-100 bg-white'
                          : selectedChain?.id === chain.id
                          ? 'border-purple-400 bg-purple-50 shadow-md shadow-purple-100'
                          : 'border-gray-100 bg-white hover:border-purple-300 hover:shadow-md hover:scale-[1.03]'
                      }`}
                    >
                      <div className={!inactive ? 'group-hover:scale-110 transition-transform' : ''}>
                        <ChainLogo chain={chain} />
                      </div>
                      <div className="min-w-0 w-full">
                        <p className="text-xs font-bold text-gray-800 truncate">{chain.name}</p>
                        <p className="text-xs text-gray-400 font-medium">{chain.symbol}</p>
                      </div>
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full bg-gradient-to-r ${catGradient(chain.category)} text-white`}>
                        {CAT_LABELS[chain.category] ?? chain.category}
                      </span>
                      {chain.badge?.color === 'green'
                        ? <Badge variant="success" size="sm">{chain.badge.label}</Badge>
                        : chain.badge?.color === 'yellow'
                        ? <Badge variant="warning" size="sm">{chain.badge.label}</Badge>
                        : chain.badge
                        ? <Badge variant="default" size="sm">{chain.badge.label}</Badge>
                        : chain.isAvailable
                        ? <Badge variant="success" size="sm">Active</Badge>
                        : <Badge variant="default" size="sm">Setup</Badge>
                      }
                    </button>
                  )
                })}
              </div>
            )}

            <CustomGasRequest />
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════════ */}
        {/* PHASES 1–12 — Order flow card                                     */}
        {/* ═══════════════════════════════════════════════════════════════════ */}
        {phase > PHASE.CHAINS && (
          <div>
            <StepIndicator phase={phase} />
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">

              {/* ─────────────────────────────────────────────────────────── */}
              {/* PHASE 1 — Token Selection                                   */}
              {/* ─────────────────────────────────────────────────────────── */}
              {phase === PHASE.TOKEN && selectedChain && (
                <div className="p-5 space-y-4">
                  <CardHeader onBack={resetFlow} title="Select Token" sub={`${selectedChain.name} · ${selectedChain.networkLabel}`} />

                  {tokensLoading && <LoadingState message="Loading tokens..." />}
                  {tokensError   && <ErrorState title={tokensError} onRetry={() => fetchTokens(selectedChain)} />}

                  {!tokensLoading && !tokensError && tokenData && (
                    <div className="space-y-3">
                      {tokenData.tokens.map(t => {
                        const sel = selectedToken?.id === t.id
                        const inactive = !t.isActive
                        const tRaw = t.rawUsdPrice ?? t.priceUsd
                        const displayPrice = tRaw > 0 ? `$${tRaw.toFixed(4)}` : t.rateStale ? 'Rate unavailable' : '—'
                        const displaySub   = tRaw > 0 ? `per ${t.symbol}` : ''
                        return (
                          <button
                            key={t.id}
                            onClick={() => { if (!inactive) setSelectedToken(t) }}
                            disabled={inactive}
                            className={`w-full flex items-center gap-4 p-4 rounded-xl border-2 text-left transition-all duration-200 ${
                              inactive
                                ? 'border-gray-100 bg-gray-50 opacity-60 cursor-not-allowed'
                                : sel
                                  ? 'border-purple-400 bg-gradient-to-r from-purple-50 to-blue-50'
                                  : 'border-gray-100 bg-gray-50 hover:border-purple-200'
                            }`}>
                            <TokenLogo token={t} cat={selectedChain.category} sizeCls="w-12 h-12" />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <p className="text-sm font-bold text-gray-900">{t.name}</p>
                                {inactive && (
                                  <span className="px-1.5 py-0.5 rounded text-xs font-semibold bg-gray-200 text-gray-500">Soon</span>
                                )}
                                {!inactive && t.rateStale && (
                                  <span className="px-1.5 py-0.5 rounded text-xs font-semibold bg-yellow-100 text-yellow-700">Rate stale</span>
                                )}
                              </div>
                              <p className="text-xs text-gray-400">{t.symbol} · {selectedChain.networkLabel}</p>
                            </div>
                            <div className="text-right">
                              {inactive ? (
                                <p className="text-sm text-gray-400">Coming soon</p>
                              ) : (
                                <>
                                  <p className={`text-sm font-bold ${t.rateStale ? 'text-yellow-600' : 'text-gray-900'}`}>{displayPrice}</p>
                                  <p className="text-xs text-gray-400">{displaySub || `per ${t.symbol}`}</p>
                                </>
                              )}
                            </div>
                            {!inactive && sel && <div className="w-5 h-5 rounded-full bg-purple-600 flex items-center justify-center"><svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg></div>}
                          </button>
                        )
                      })}
                    </div>
                  )}

                  <Button className="w-full" disabled={!selectedToken} onClick={() => setPhase(PHASE.AMOUNT)}>
                    Next <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                  </Button>
                </div>
              )}

              {/* ─────────────────────────────────────────────────────────── */}
              {/* PHASE 2 — Amount                                            */}
              {/* ─────────────────────────────────────────────────────────── */}
              {phase === PHASE.AMOUNT && selectedChain && selectedToken && (
                <div className="p-5 space-y-4">
                  <CardHeader onBack={() => setPhase(PHASE.TOKEN)} title="Choose Amount" />

                  <div className="flex items-center justify-between bg-gray-50 rounded-xl px-4 py-3 text-sm">
                    <div>
                      <span className="text-gray-500">Market Price</span>
                      <p className="text-xs text-gray-400 mt-0.5">1 {selectedToken.symbol}</p>
                    </div>
                    <div className="text-right">
                      <p className="font-bold text-gray-900">${priceUsd.toFixed(4)}</p>
                      <p className="text-xs text-gray-400">≈ PKR {pricePkr.toFixed(0)}</p>
                    </div>
                  </div>

                  {/* Preset chips */}
                  <div>
                    <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Quick Select</p>
                    <div className="flex flex-wrap gap-2">
                      {selectedToken.presetAmounts.map(preset => {
                        const usdVal = preset * priceUsd
                        const tooHigh = usdVal > maxUsd
                        const active  = amount === String(preset) && !tooHigh
                        return (
                          <button key={preset} onClick={() => { if (!tooHigh) { setAmount(String(preset)); if (usdVal > maxUsd) setAmountError(`Exceeds $${maxUsd} limit`); else setAmountError('') } }} disabled={tooHigh}
                            className={`px-4 py-2 rounded-xl text-sm font-bold border-2 transition-all flex flex-col items-center ${
                              active    ? 'border-purple-500 bg-purple-600 text-white shadow-sm'
                              : tooHigh ? 'border-gray-100 text-gray-300 bg-gray-50 cursor-not-allowed'
                              :           'border-gray-200 bg-white text-gray-700 hover:border-purple-300'
                            }`}>
                            <span>{preset} {selectedToken.symbol}</span>
                            {priceUsd > 0 && (
                              <span className={`text-[10px] font-medium mt-0.5 ${active ? 'text-purple-100' : tooHigh ? 'text-gray-300' : 'text-gray-400'}`}>
                                ≈ ${usdVal.toFixed(2)}
                              </span>
                            )}
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  {/* Custom input */}
                  <div>
                    <label className="block text-xs font-semibold text-gray-700 mb-1.5">Custom Amount ({selectedToken.symbol})</label>
                    <Input type="number" placeholder={`Min ${minAmount}`} value={amount}
                      onChange={e => { const v = e.target.value; setAmount(v); if (v) validateAmountField(v); else setAmountError('') }}
                      onBlur={() => { if (amount) validateAmountField(amount) }} min={minAmount} step="any" />
                    {amountError && <p className="text-xs text-red-500 mt-1">{amountError}</p>}
                    {amountNum > 0 && !amountError && (
                      <div className={`text-xs mt-1 flex gap-3 ${usdExceeded ? 'text-red-500' : 'text-gray-500'}`}>
                        <span>≈ ${computedUsd.toFixed(2)} USDT</span>
                        <span>≈ PKR {computedPkr.toFixed(0)}</span>
                        {usdExceeded && <span className="font-semibold">— exceeds ${maxUsd} limit</span>}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-2 bg-blue-50 rounded-xl px-3 py-2.5 text-xs text-blue-600">
                    <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    Max order value: <span className="font-bold ml-1">${maxUsd} USDT</span> per transaction
                  </div>

                  <Button className="w-full" disabled={!amount || !!amountError || usdExceeded}
                    onClick={() => { if (validateAmountField(amount)) setPhase(PHASE.ADDRESS) }}>
                    Continue <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                  </Button>
                </div>
              )}

              {/* ─────────────────────────────────────────────────────────── */}
              {/* PHASE 3 — Address                                           */}
              {/* ─────────────────────────────────────────────────────────── */}
              {phase === PHASE.ADDRESS && selectedChain && selectedToken && (
                <div className="p-5 space-y-4">
                  <CardHeader onBack={() => setPhase(PHASE.AMOUNT)} title={`Enter ${selectedChain.networkLabel} Address`} />

                  <p className="text-xs text-gray-500">The wallet address that needs {selectedToken.symbol} for gas.</p>

                  <div>
                    <label className="block text-xs font-semibold text-gray-700 mb-1.5">{selectedChain.name} Wallet Address</label>
                    <Input placeholder={addressPlaceholder(selectedChain.addressType)} value={address}
                      onChange={e => { setAddress(e.target.value); if (addressError) validateAddressField(e.target.value) }}
                      onBlur={() => validateAddressField(address)} />
                    {addressError && <p className="text-xs text-red-500 mt-1">{addressError}</p>}
                    {address && !addressError && validateAddress(address, selectedChain.addressType) && (
                      <p className="text-xs text-green-600 mt-1 flex items-center gap-1">
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                        Valid {selectedChain.networkLabel} address
                      </p>
                    )}
                  </div>

                  {/* Order Summary — all fees before proceeding to payment */}
                  <div className="bg-gray-50 rounded-xl p-4 space-y-2 text-xs">
                    <p className="font-bold text-gray-400 uppercase tracking-wide mb-1">Order Summary</p>
                    <div className="flex justify-between"><span className="text-gray-500">Network</span><span className="font-semibold text-gray-800">{selectedChain.name}</span></div>
                    <div className="flex justify-between"><span className="text-gray-500">Token</span><span className="font-semibold text-gray-800">{selectedToken.symbol}</span></div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">Amount</span>
                      <span className="font-semibold text-gray-800">
                        {amount} {selectedToken.symbol}
                        {priceUsd > 0 && amountNum > 0 && <span className="text-gray-400 font-normal"> (≈ ${gasValueUsd.toFixed(2)})</span>}
                      </span>
                    </div>
                    {priceUsd > 0 && amountNum > 0 && (
                      <div className="flex justify-between">
                        <span className="text-gray-500">Market Price</span>
                        <span className="font-semibold text-gray-800">${priceUsd.toFixed(4)} / {selectedToken.symbol}</span>
                      </div>
                    )}
                    {priceUsd > 0 && amountNum > 0 && (
                      <div className="flex justify-between">
                        <span className="text-gray-500">Token Value</span>
                        <span className="font-semibold text-gray-800">${gasValueUsd.toFixed(2)} USDT</span>
                      </div>
                    )}
                    <div className="pt-1.5 border-t border-gray-200 space-y-1.5">
                      <p className="text-gray-400 font-semibold uppercase tracking-wide" style={{fontSize:'0.65rem'}}>Platform charges</p>
                      {networkFee?.supported && (networkFee.estimatedFeeNative ?? 0) > 0 ? (
                        <div className="flex justify-between items-start gap-2">
                          <span className="text-gray-600 font-medium">
                            {selectedChain.name} Network Fee
                            {networkFee.gasPriceGwei != null && <span className="text-gray-400 font-normal"> · {networkFee.gasPriceGwei.toFixed(2)} Gwei</span>}
                          </span>
                          <span className="font-semibold text-gray-800 text-right">
                            <span className="block">~{(networkFee.estimatedFeeNative ?? 0).toFixed(6)} {networkFee.symbol}</span>
                            {networkFee.estimatedFeeUsd != null && (
                              <span className="block text-gray-500 font-normal">
                                {networkFee.estimatedFeeUsd < 0.001 ? `≈ $${networkFee.estimatedFeeUsd.toFixed(5)}` : networkFee.estimatedFeeUsd < 0.01 ? `≈ $${networkFee.estimatedFeeUsd.toFixed(4)}` : `≈ $${networkFee.estimatedFeeUsd.toFixed(3)}`}
                              </span>
                            )}
                          </span>
                        </div>
                      ) : (
                        <div className="flex justify-between">
                          <span className="text-gray-600 font-medium">{selectedChain.name} Network Fee</span>
                          <span className="text-gray-400 italic">included in platform fee</span>
                        </div>
                      )}
                      <div className="flex justify-between">
                        <span className="text-gray-600 font-medium">Platform Service Fee</span>
                        <span className="font-semibold text-gray-800">${platformFeeUsdt.toFixed(2)} USDT</span>
                      </div>
                    </div>
                    <div className="flex justify-between pt-2 border-t border-gray-200">
                      <span className="text-gray-700 font-semibold">You Pay</span>
                      <div className="text-right">
                        <p className="font-bold text-purple-700">${computedUsd.toFixed(2)} USDT</p>
                        <p className="text-gray-400">≈ PKR {computedPkr.toFixed(0)}</p>
                      </div>
                    </div>
                    {networkFee?.supported && networkFee.estimatedFeeNative != null && amountNum > 0 && networkFee.estimatedFeeNative > 0 && (
                      <div className="mt-1 pt-2 border-t border-gray-200">
                        <div className="flex items-start gap-1.5 text-gray-500">
                          <svg className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                          <p className="text-gray-400">
                            Your {amount} {selectedToken.symbol} covers ~{Math.floor(amountNum / networkFee.estimatedFeeNative).toLocaleString()} {selectedChain.name} transfers
                          </p>
                        </div>
                      </div>
                    )}
                  </div>

                  <Button className="w-full" disabled={!validateAddress(address, selectedChain.addressType)}
                    onClick={() => { if (validateAddressField(address)) setPhase(PHASE.PAY_METHOD) }}>
                    Proceed to Payment <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                  </Button>
                </div>
              )}

              {/* ─────────────────────────────────────────────────────────── */}
              {/* PHASE 4 — Payment Method Choice                             */}
              {/* ─────────────────────────────────────────────────────────── */}
              {phase === PHASE.PAY_METHOD && selectedChain && selectedToken && (
                <div className="p-5 space-y-4">
                  <CardHeader onBack={() => setPhase(PHASE.ADDRESS)} title="Choose How You Want to Pay" sub="Select your preferred payment method" />

                  {/* Context pills */}
                  <div className="flex items-center gap-2 flex-wrap text-xs">
                    <span className="flex items-center gap-1.5 bg-gray-100 rounded-full px-3 py-1">
                      <ChainLogo chain={selectedChain} sizeCls="w-4 h-4" />
                      {selectedToken.symbol} · {selectedChain.networkLabel}
                    </span>
                    <span className="bg-purple-100 text-purple-700 rounded-full px-3 py-1 font-bold">${computedUsd.toFixed(2)} USDT</span>
                    <span className="bg-green-100 text-green-700 rounded-full px-3 py-1 font-bold">≈ PKR {computedPkr.toFixed(0)}</span>
                  </div>

                  {methodsLoading && <LoadingState message="Loading payment options..." />}

                  {!methodsLoading && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">

                      {/* ── Pay with PKR ──────────────────────────────────── */}
                      <button onClick={() => setPhase(PHASE.PKR_METHOD)}
                        className="flex flex-col gap-3 p-5 rounded-2xl border-2 border-gray-200 bg-white hover:border-green-400 hover:shadow-sm transition-all text-left group">
                        <div className="flex items-center justify-between">
                          <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-green-500 to-emerald-600 flex items-center justify-center text-white font-bold text-xl shadow-sm">₨</div>
                          <span className="text-xs bg-green-100 text-green-700 font-semibold px-2.5 py-1 rounded-full">Easy & Fast</span>
                        </div>
                        <div>
                          <p className="text-sm font-bold text-gray-900 mb-0.5">Pay with PKR</p>
                          <p className="text-xs text-gray-500">Bank Transfer · Easypaisa · JazzCash</p>
                        </div>
                        <div className="flex items-center gap-1.5 text-xs text-gray-400">
                          <svg className="w-3.5 h-3.5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                          No crypto needed
                        </div>
                      </button>

                      {/* ── Pay with Crypto ───────────────────────────────── */}
                      <button onClick={() => setPhase(PHASE.CRYPTO_NETWORK)}
                        className="flex flex-col gap-3 p-5 rounded-2xl border-2 border-gray-200 bg-white hover:border-blue-400 hover:shadow-sm transition-all text-left group">
                        <div className="flex items-center justify-between">
                          <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white font-bold text-xl shadow-sm">₮</div>
                          <span className="text-xs bg-blue-100 text-blue-700 font-semibold px-2.5 py-1 rounded-full">Low Fees</span>
                        </div>
                        <div>
                          <p className="text-sm font-bold text-gray-900 mb-0.5">Pay with Crypto</p>
                          <p className="text-xs text-gray-500">USDT BEP20 · USDT Aptos</p>
                        </div>
                        <div className="flex items-center gap-1.5 text-xs text-gray-400">
                          <svg className="w-3.5 h-3.5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                          Instant payment detection
                        </div>
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* ─────────────────────────────────────────────────────────── */}
              {/* PHASE 5 — PKR Method Selection + Breakdown                  */}
              {/* ─────────────────────────────────────────────────────────── */}
              {phase === PHASE.PKR_METHOD && selectedToken && (
                <div className="p-5 space-y-4">
                  <CardHeader onBack={() => setPhase(PHASE.PAY_METHOD)} title="Pay with PKR" sub="Select your payment method" />

                  {/* PKR method cards */}
                  <div className="space-y-2">
                    {(Object.keys(PKR_METHOD_META) as PkrMethodKey[]).map(key => {
                      const meta = PKR_METHOD_META[key]
                      const sel  = selectedPkrMethod === key
                      // Check if method is configured
                      const configured = pkrMethods ? (
                        key === 'bank_transfer'
                          ? !!(pkrMethods.bank.bankName || pkrMethods.bank.iban)
                          : key === 'easypaisa'
                          ? !!pkrMethods.easypaisa.number
                          : !!pkrMethods.jazzcash.number
                      ) : true
                      return (
                        <button key={key} onClick={() => configured && setSelectedPkrMethod(key)} disabled={!configured}
                          className={`w-full flex items-center gap-4 p-4 rounded-xl border-2 text-left transition-all ${
                            !configured ? 'opacity-40 cursor-not-allowed border-gray-100 bg-gray-50'
                            : sel ? 'border-purple-400 bg-purple-50'
                            : 'border-gray-100 bg-white hover:border-purple-200'
                          }`}>
                          <span className="text-2xl">{meta.icon}</span>
                          <div className="flex-1">
                            <p className="text-sm font-bold text-gray-900">{meta.label}</p>
                            <p className="text-xs text-gray-400">{configured ? meta.desc : 'Currently unavailable'}</p>
                          </div>
                          {sel && <div className="w-5 h-5 rounded-full bg-purple-600 flex items-center justify-center"><svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg></div>}
                        </button>
                      )
                    })}
                  </div>

                  {/* PKR Breakdown */}
                  {selectedPkrMethod && (
                    <div className="bg-gray-50 rounded-xl p-4 space-y-2.5 text-sm">
                      <p className="text-xs font-bold text-gray-400 uppercase tracking-wide">Payment Breakdown</p>
                      <div className="space-y-2">
                        <div className="flex justify-between text-xs">
                          <span className="text-gray-500">Gas Ordered</span>
                          <span className="font-semibold">{amount} {selectedToken.symbol}</span>
                        </div>
                        {priceUsd > 0 && (
                          <div className="flex justify-between text-xs">
                            <span className="text-gray-500">Market Price</span>
                            <span className="font-semibold">${priceUsd.toFixed(4)} / {selectedToken.symbol}</span>
                          </div>
                        )}
                        <div className="flex justify-between text-xs">
                          <span className="text-gray-500">Token Value</span>
                          <span className="font-semibold">${gasValueUsd.toFixed(2)} USDT</span>
                        </div>
                        <div className="flex justify-between text-xs">
                          <span className="text-gray-500">Platform Fee</span>
                          <span className="font-semibold">${platformFeeUsdt.toFixed(2)} USDT</span>
                        </div>
                        {usdPkrRate > 0 && (
                          <div className="flex justify-between text-xs">
                            <span className="text-gray-500">Exchange Rate</span>
                            <span className="font-semibold">1 USDT ≈ PKR {usdPkrRate.toFixed(0)}</span>
                          </div>
                        )}
                        <div className="flex justify-between pt-2 border-t border-gray-200">
                          <span className="font-bold text-gray-800">Total Payable in PKR</span>
                          <span className="font-bold text-green-700 text-base">PKR {computedPkr.toFixed(0)}</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {pkrError && <p className="text-sm text-red-500 bg-red-50 rounded-xl px-3 py-2">{pkrError}</p>}

                  {!user && selectedPkrMethod && (
                    <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-700">
                      You must be logged in to pay with PKR.{' '}
                      <Link href="/login" className="font-bold underline">Log in →</Link>
                    </div>
                  )}

                  <Button className="w-full" disabled={!selectedPkrMethod || !user || creatingPkr} loading={creatingPkr}
                    onClick={handleCreatePkrOrder}>
                    {creatingPkr ? 'Creating Order...' : `Pay PKR ${computedPkr.toFixed(0)}`}
                  </Button>
                </div>
              )}

              {/* ─────────────────────────────────────────────────────────── */}
              {/* PHASE 7 — PKR Proof Upload (payment instructions + upload)  */}
              {/* ─────────────────────────────────────────────────────────── */}
              {phase === PHASE.PKR_PROOF && order && selectedPkrMethod && (
                <div className="p-5 space-y-4">
                  <CardHeader title="Make Payment" sub={`Order #${order.orderRef}`} />

                  {/* How to pay */}
                  <div className="bg-green-50 border border-green-200 rounded-xl p-4 space-y-3">
                    <div className="flex items-center gap-2">
                      <span className="text-xl">{PKR_METHOD_META[selectedPkrMethod].icon}</span>
                      <p className="text-sm font-bold text-gray-900">Send via {PKR_METHOD_META[selectedPkrMethod].label}</p>
                    </div>

                    {/* Amount to send */}
                    <div className="bg-white rounded-xl p-3 flex items-center justify-between">
                      <span className="text-xs text-gray-500">Amount to Send</span>
                      <div className="flex items-center gap-2">
                        <span className="text-lg font-bold text-green-700">PKR {order.pkrAmount ?? computedPkr.toFixed(0)}</span>
                        <CopyButton text={String(order.pkrAmount ?? computedPkr.toFixed(0))} />
                      </div>
                    </div>

                    {/* Payment details */}
                    {(() => {
                      const details = getPkrDetails()
                      if (!details || details.length === 0) return (
                        <p className="text-xs text-amber-600">Payment account details not configured yet. Please contact support.</p>
                      )
                      return (
                        <div className="space-y-2">
                          {details.map(({ label, value }) => value && (
                            <div key={label} className="bg-white rounded-xl px-3 py-2.5 flex items-center justify-between">
                              <span className="text-xs text-gray-500">{label}</span>
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-bold text-gray-900 font-mono">{value}</span>
                                <CopyButton text={value} />
                              </div>
                            </div>
                          ))}
                        </div>
                      )
                    })()}
                  </div>

                  {/* Warning */}
                  <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-start gap-2">
                    <svg className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                    <p className="text-xs text-amber-700 font-medium">Send <strong>exactly PKR {order.pkrAmount ?? computedPkr.toFixed(0)}</strong> and upload your payment screenshot below.</p>
                  </div>

                  {/* Proof upload */}
                  <div>
                    <p className="text-xs font-semibold text-gray-700 mb-2">Upload Payment Screenshot</p>
                    <label className={`flex flex-col items-center justify-center gap-2 h-32 rounded-xl border-2 border-dashed cursor-pointer transition-colors ${proofUrl ? 'border-green-400 bg-green-50' : 'border-gray-200 hover:border-purple-300 bg-gray-50'}`}>
                      <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={e => { const f = e.target.files?.[0]; if (f) handleUploadFile(f) }} />
                      {uploading
                        ? <><Spinner size="md" /><p className="text-xs text-gray-500">Uploading...</p></>
                        : proofUrl
                        ? <><svg className="w-8 h-8 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg><p className="text-xs text-green-600 font-semibold">Screenshot uploaded</p><p className="text-xs text-gray-400">Click to replace</p></>
                        : <><svg className="w-8 h-8 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg><p className="text-xs text-gray-500">Click to upload screenshot</p><p className="text-xs text-gray-400">JPEG, PNG, WebP · Max 10MB</p></>
                      }
                    </label>
                    {uploadError && <p className="text-xs text-red-500 mt-1">{uploadError}</p>}
                  </div>

                  {proofError && <p className="text-sm text-red-500 bg-red-50 rounded-xl px-3 py-2">{proofError}</p>}

                  <Button className="w-full" disabled={!proofUrl || submittingProof} loading={submittingProof}
                    onClick={handleSubmitProof}>
                    {submittingProof ? 'Submitting...' : 'Submit Payment Proof'}
                  </Button>
                </div>
              )}

              {/* ─────────────────────────────────────────────────────────── */}
              {/* PHASE 8 — PKR Review (proof submitted, waiting admin)       */}
              {/* ─────────────────────────────────────────────────────────── */}
              {phase === PHASE.PKR_REVIEW && order && (
                <div className="p-5 space-y-4">
                  <CardHeader title="Payment Under Review" sub={`Order #${order.orderRef}`} />

                  <div className="text-center py-4">
                    <div className="w-16 h-16 rounded-full bg-amber-100 flex items-center justify-center mx-auto mb-3">
                      <svg className="w-8 h-8 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    </div>
                    <p className="text-base font-bold text-gray-900 mb-1">Proof Submitted!</p>
                    <p className="text-sm text-gray-500">Our team is reviewing your payment. Gas will be released after verification (usually within 30–60 minutes during business hours).</p>
                  </div>

                  {/* Status tracker */}
                  <div className="bg-gray-50 rounded-xl p-4">
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-3">Order Status</p>
                    <ProcessingTimeline status={order.status} isPkr />
                  </div>

                  <div className="bg-gray-50 rounded-xl p-3 space-y-2 text-xs">
                    <div className="flex justify-between"><span className="text-gray-500">Order ID</span><span className="font-mono text-gray-700">{order.orderRef}</span></div>
                    <div className="flex justify-between"><span className="text-gray-500">Amount Ordered</span><span className="font-semibold">{order.gasAmountNative} {order.nativeSymbol ?? selectedToken?.symbol}</span></div>
                    <div className="flex justify-between"><span className="text-gray-500">PKR Paid</span><span className="font-semibold text-green-700">PKR {order.pkrAmount ?? computedPkr.toFixed(0)}</span></div>
                  </div>

                  {order.status === 'delivered' && (
                    <Button className="w-full" onClick={() => setPhase(PHASE.COMPLETE)}>View Completion Screen</Button>
                  )}
                  {['failed', 'expired'].includes(order.status) && (
                    <div className="text-center">
                      <p className="text-sm text-red-600 font-semibold mb-3">Order failed. Please try again.</p>
                      <Button onClick={resetFlow}>Try Again</Button>
                    </div>
                  )}

                  {pollErrCount >= 3 && (
                    <p className="text-xs text-amber-600 text-center">
                      Connection issue.{' '}
                      <button className="underline font-semibold" onClick={() => { setPollErrCount(0); pollOrder() }}>Refresh</button>
                    </p>
                  )}
                </div>
              )}

              {/* ─────────────────────────────────────────────────────────── */}
              {/* PHASE 9 — Crypto Network Selection                          */}
              {/* ─────────────────────────────────────────────────────────── */}
              {phase === PHASE.CRYPTO_NETWORK && (
                <div className="p-5 space-y-4">
                  <CardHeader onBack={() => setPhase(PHASE.PAY_METHOD)} title="Select Payment Network" sub="Choose a network to send your payment" />

                  <div className="space-y-3">
                    {/* TRC20 card — recommended (lowest fee) */}
                    {(() => {
                      const trcConfigured = !!cryptoMethods?.trc20?.address
                      const trcAddr = cryptoMethods?.trc20?.address
                      const trcFee = cryptoMethods?.trc20?.feeNativeDisplay ?? cryptoMethods?.trc20?.fee ?? '~$1'
                      return (
                        <button
                          onClick={() => trcConfigured && setSelectedCryptoNetwork('TRC20')}
                          disabled={!trcConfigured}
                          className={`w-full flex items-center gap-4 p-4 rounded-xl border-2 text-left transition-all ${
                            !trcConfigured
                              ? 'opacity-50 cursor-not-allowed border-gray-100 bg-gray-50'
                              : selectedCryptoNetwork === 'TRC20'
                              ? 'border-purple-400 bg-purple-50'
                              : 'border-gray-100 bg-white hover:border-purple-200'
                          }`}
                        >
                          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-red-500 to-red-700 flex items-center justify-center text-white font-bold text-sm flex-shrink-0">TRX</div>
                          <div className="flex-1">
                            <p className="text-sm font-bold text-gray-900">USDT TRC20</p>
                            <p className="text-xs text-gray-400">
                              {trcConfigured ? `TRON Network · est. ${trcFee} network fee` : 'Coming soon — not yet configured'}
                            </p>
                            {trcAddr && (
                              <p className="text-xs font-mono text-gray-400 mt-0.5">{trcAddr.slice(0, 8)}...{trcAddr.slice(-6)}</p>
                            )}
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            {trcConfigured
                              ? <>
                                  <span className="text-xs bg-green-100 text-green-700 font-semibold px-2 py-0.5 rounded-full">Recommended</span>
                                  {selectedCryptoNetwork === 'TRC20'
                                    ? <div className="w-5 h-5 rounded-full bg-purple-600 flex items-center justify-center"><svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg></div>
                                    : <span className="text-xs text-gray-400 border border-gray-200 rounded-full px-2 py-0.5">Select</span>
                                  }
                                </>
                              : <span className="text-xs bg-gray-100 text-gray-500 font-semibold px-2 py-0.5 rounded-full">Soon</span>
                            }
                          </div>
                        </button>
                      )
                    })()}

                    {/* BEP20 card */}
                    {(() => {
                      const bepConfigured = !!cryptoMethods?.bep20?.address
                      const bepAddr = cryptoMethods?.bep20?.address
                      return (
                        <button
                          onClick={() => bepConfigured && setSelectedCryptoNetwork('BEP20')}
                          disabled={!bepConfigured}
                          className={`w-full flex items-center gap-4 p-4 rounded-xl border-2 text-left transition-all ${
                            !bepConfigured
                              ? 'opacity-50 cursor-not-allowed border-gray-100 bg-gray-50'
                              : selectedCryptoNetwork === 'BEP20'
                              ? 'border-purple-400 bg-purple-50'
                              : 'border-gray-100 bg-white hover:border-purple-200'
                          }`}
                        >
                          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-yellow-400 to-yellow-600 flex items-center justify-center text-white font-bold text-sm flex-shrink-0">BNB</div>
                          <div className="flex-1">
                            <p className="text-sm font-bold text-gray-900">USDT BEP20</p>
                            <p className="text-xs text-gray-400">
                              {bepConfigured ? 'BNB Smart Chain · est. ~$0.29 network fee' : 'Coming soon — not yet configured'}
                            </p>
                            {bepAddr && (
                              <p className="text-xs font-mono text-gray-400 mt-0.5">{bepAddr.slice(0, 8)}...{bepAddr.slice(-6)}</p>
                            )}
                          </div>
                          {bepConfigured
                            ? selectedCryptoNetwork === 'BEP20'
                              ? <div className="w-5 h-5 rounded-full bg-purple-600 flex items-center justify-center flex-shrink-0"><svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg></div>
                              : <span className="text-xs text-gray-400 border border-gray-200 rounded-full px-2 py-0.5 flex-shrink-0">Select</span>
                            : <span className="text-xs bg-gray-100 text-gray-500 font-semibold px-2 py-0.5 rounded-full flex-shrink-0">Soon</span>
                          }
                        </button>
                      )
                    })()}

                    {/* ERC20 card */}
                    {(() => {
                      const ercConfigured = !!cryptoMethods?.erc20?.address
                      const ercAddr = cryptoMethods?.erc20?.address
                      const ercFee = cryptoMethods?.erc20?.feeNativeDisplay ?? cryptoMethods?.erc20?.fee ?? '~$2'
                      return (
                        <button
                          onClick={() => ercConfigured && setSelectedCryptoNetwork('ERC20')}
                          disabled={!ercConfigured}
                          className={`w-full flex items-center gap-4 p-4 rounded-xl border-2 text-left transition-all ${
                            !ercConfigured
                              ? 'opacity-50 cursor-not-allowed border-gray-100 bg-gray-50'
                              : selectedCryptoNetwork === 'ERC20'
                              ? 'border-purple-400 bg-purple-50'
                              : 'border-gray-100 bg-white hover:border-purple-200'
                          }`}
                        >
                          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white font-bold text-sm flex-shrink-0">ETH</div>
                          <div className="flex-1">
                            <p className="text-sm font-bold text-gray-900">USDT ERC20</p>
                            <p className="text-xs text-gray-400">
                              {ercConfigured ? `Ethereum Network · est. ${ercFee} network fee` : 'Coming soon — not yet configured'}
                            </p>
                            {ercAddr && (
                              <p className="text-xs font-mono text-gray-400 mt-0.5">{ercAddr.slice(0, 8)}...{ercAddr.slice(-6)}</p>
                            )}
                          </div>
                          {ercConfigured
                            ? selectedCryptoNetwork === 'ERC20'
                              ? <div className="w-5 h-5 rounded-full bg-purple-600 flex items-center justify-center flex-shrink-0"><svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg></div>
                              : <span className="text-xs text-gray-400 border border-gray-200 rounded-full px-2 py-0.5 flex-shrink-0">Select</span>
                            : <span className="text-xs bg-gray-100 text-gray-500 font-semibold px-2 py-0.5 rounded-full flex-shrink-0">Soon</span>
                          }
                        </button>
                      )
                    })()}

                    {/* Aptos card — disabled until address is configured */}
                    {(() => {
                      const aptosConfigured = !!cryptoMethods?.aptos?.address
                      return (
                        <button
                          onClick={() => aptosConfigured && setSelectedCryptoNetwork('APTOS')}
                          disabled={!aptosConfigured}
                          className={`w-full flex items-center gap-4 p-4 rounded-xl border-2 text-left transition-all ${
                            !aptosConfigured
                              ? 'opacity-50 cursor-not-allowed border-gray-100 bg-gray-50'
                              : selectedCryptoNetwork === 'APTOS'
                              ? 'border-purple-400 bg-purple-50'
                              : 'border-gray-100 bg-white hover:border-purple-200'
                          }`}
                        >
                          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-gray-700 to-gray-900 flex items-center justify-center text-white font-bold text-xs flex-shrink-0">APT</div>
                          <div className="flex-1">
                            <p className="text-sm font-bold text-gray-900">USDT Aptos</p>
                            <p className="text-xs text-gray-400">
                              {aptosConfigured ? 'Aptos Network · ~$0.01 fee' : 'Coming soon — not yet configured'}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            {aptosConfigured
                              ? <>
                                  <span className="text-xs bg-green-100 text-green-700 font-semibold px-2 py-0.5 rounded-full">Lowest Fee</span>
                                  {selectedCryptoNetwork === 'APTOS'
                                    ? <div className="w-5 h-5 rounded-full bg-purple-600 flex items-center justify-center"><svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg></div>
                                    : <span className="text-xs text-gray-400 border border-gray-200 rounded-full px-2 py-0.5">Select</span>
                                  }
                                </>
                              : <span className="text-xs bg-gray-100 text-gray-500 font-semibold px-2 py-0.5 rounded-full">Soon</span>
                            }
                          </div>
                        </button>
                      )
                    })()}
                  </div>

                  {cryptoError && <p className="text-sm text-red-500 bg-red-50 rounded-xl px-3 py-2">{cryptoError}</p>}

                  <Button className="w-full" disabled={!selectedCryptoNetwork || creatingCrypto} loading={creatingCrypto}
                    onClick={handleCreateCryptoOrder}>
                    {creatingCrypto ? 'Creating Order...' : 'Continue'}
                    {!creatingCrypto && <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>}
                  </Button>
                </div>
              )}

              {/* ─────────────────────────────────────────────────────────── */}
              {/* PHASE 10 — Crypto QR Payment Screen                         */}
              {/* ─────────────────────────────────────────────────────────── */}
              {phase === PHASE.CRYPTO_QR && order && (
                <div className="p-5 space-y-4">
                  <div className="flex items-center justify-between pb-3 border-b border-gray-100">
                    <p className="text-sm font-bold text-gray-900">Make Payment</p>
                    <Badge variant={statusVariant(order.status)} size="sm">{STATUS_LABELS[order.status] ?? order.status}</Badge>
                  </div>

                  {order.status === 'payment_pending' && (
                    <>
                      {/* Countdown */}
                      <div className="flex items-center justify-between bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
                        <div className="flex items-center gap-2 text-amber-700 text-xs font-semibold">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                          Payment window
                        </div>
                        <CountdownTimer expiresAt={order.expiresAt} showLabel={false} onExpire={() => setOrder(o => o ? { ...o, status: 'expired' } : o)} />
                      </div>

                      {/* QR */}
                      <div className="flex flex-col items-center gap-2 py-2">
                        {qrFailed ? (
                          <div className="w-48 rounded-xl border border-amber-200 bg-amber-50 p-3 text-center">
                            <p className="text-xs text-amber-700 font-semibold mb-1">QR code unavailable</p>
                            <p className="text-xs text-amber-600">Copy the address below to pay.</p>
                          </div>
                        ) : (
                          <div className="w-48 h-48 rounded-2xl overflow-hidden border-4 border-white shadow-lg">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={`https://api.qrserver.com/v1/create-qr-code/?size=192x192&data=${encodeURIComponent(order.paymentAddress)}`}
                              alt="Payment QR Code"
                              className="w-full h-full"
                              onError={() => setQrFailed(true)}
                            />
                          </div>
                        )}
                        <p className="text-xs text-gray-400">{qrFailed ? 'Use the address and amount below' : 'Scan to get the address'}</p>
                      </div>

                      {/* Address */}
                      <div>
                        <p className="text-xs text-gray-500 font-semibold mb-1.5">Send to Address</p>
                        <div className="bg-gray-50 rounded-xl p-3 flex items-start gap-2 border border-gray-100">
                          <p className="text-xs font-mono text-gray-800 break-all flex-1">{order.paymentAddress}</p>
                          <CopyButton text={order.paymentAddress} />
                        </div>
                      </div>

                      {/* Amount */}
                      <div>
                        <p className="text-xs text-gray-500 font-semibold mb-1.5">Exact Amount — Send to Platform</p>
                        <div className="bg-gray-50 rounded-xl p-3 flex items-center justify-between border border-gray-100">
                          <span className="text-lg font-bold text-gray-900">{order.paymentAmount} USDT</span>
                          <CopyButton text={order.paymentAmount} />
                        </div>
                        <p className="text-xs text-gray-400 mt-1.5">
                          Send exactly this amount to the address above. Your wallet will also deduct a separate {order.paymentNetwork} USDT transfer fee ({
                            (() => {
                              const m = order.paymentNetwork === 'TRC20' ? cryptoMethods?.trc20
                                : order.paymentNetwork === 'BEP20' ? cryptoMethods?.bep20
                                : order.paymentNetwork === 'ERC20' ? cryptoMethods?.erc20
                                : cryptoMethods?.aptos
                              const fallback = order.paymentNetwork === 'TRC20' ? '~$1' : order.paymentNetwork === 'BEP20' ? '~$0.29' : order.paymentNetwork === 'ERC20' ? '~$2' : '~$0.01'
                              return m?.feeNativeDisplay ?? m?.fee ?? fallback
                            })()
                          }) when sending.
                        </p>
                      </div>

                      {/* Details row */}
                      <div className="bg-gray-50 rounded-xl p-3 text-xs space-y-1.5 border border-gray-100">
                        <div className="flex justify-between"><span className="text-gray-500">Network</span><span className="font-bold text-gray-800">{order.paymentNetwork}</span></div>
                        <div className="flex justify-between"><span className="text-gray-500">Order ID</span><span className="font-mono text-gray-700">{order.orderRef}</span></div>
                      </div>

                      {/* Warning */}
                      <div className="bg-red-50 border border-red-200 rounded-xl p-3 flex items-start gap-2">
                        <svg className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                        <p className="text-xs text-red-700 font-medium">
                          Send ONLY USDT on <strong>{order.paymentNetwork}</strong> network. Wrong network = permanent loss.
                        </p>
                      </div>

                      {pollErrCount >= 3 && (
                        <p className="text-xs text-amber-600 text-center">
                          Connection issue. <button className="underline font-semibold" onClick={() => { setPollErrCount(0); pollOrder() }}>Refresh</button>
                        </p>
                      )}

                      {/* Payment sent flow */}
                      {verifySuccess ? (
                        <div className="bg-green-50 border border-green-200 rounded-xl p-3 text-center">
                          <p className="text-sm font-bold text-green-700 mb-0.5">Payment Submitted!</p>
                          <p className="text-xs text-green-600">{verifySuccess}</p>
                        </div>
                      ) : !paymentSent ? (
                        <button
                          onClick={() => setPaymentSent(true)}
                          className="w-full py-3 rounded-xl bg-purple-600 hover:bg-purple-700 active:bg-purple-800 text-white text-sm font-semibold transition-colors shadow-sm"
                        >
                          I&apos;ve Sent the Payment
                        </button>
                      ) : !verifyOpen ? (
                        <div className="bg-purple-50 border border-purple-200 rounded-xl p-4 space-y-3">
                          <div className="flex items-center gap-2">
                            <svg className="w-4 h-4 text-purple-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                            <p className="text-sm font-semibold text-purple-900">Payment Sent</p>
                          </div>
                          <p className="text-xs text-purple-700">
                            We&apos;ll detect your payment automatically. If it doesn&apos;t confirm in a minute, paste your transaction hash to speed it up.
                          </p>
                          <button
                            onClick={() => setVerifyOpen(true)}
                            className="w-full py-2.5 rounded-xl bg-purple-600 hover:bg-purple-700 active:bg-purple-800 text-white text-sm font-semibold transition-colors"
                          >
                            Enter Transaction Hash
                          </button>
                          <button
                            onClick={() => setPaymentSent(false)}
                            className="w-full text-xs text-purple-400 hover:text-purple-600 text-center"
                          >
                            I haven&apos;t sent yet — go back
                          </button>
                        </div>
                      ) : (
                        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 space-y-3">
                          <div className="flex items-center justify-between">
                            <p className="text-xs font-bold text-blue-800">Enter Transaction Hash</p>
                            <button onClick={() => { setVerifyOpen(false); setVerifyError('') }} className="text-blue-400 hover:text-blue-600 text-lg leading-none">&times;</button>
                          </div>
                          <p className="text-xs text-blue-700">Paste your transaction hash from your wallet or blockchain explorer. We&apos;ll verify and release your gas.</p>
                          <input
                            type="text"
                            value={verifyTxHash}
                            onChange={e => { setVerifyTxHash(e.target.value); setVerifyError('') }}
                            placeholder="0x... transaction hash"
                            className="w-full text-xs font-mono bg-white border border-blue-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400 placeholder:text-gray-300"
                          />
                          {verifyError && <p className="text-xs text-red-600">{verifyError}</p>}
                          <Button
                            onClick={handleVerifyPayment}
                            disabled={verifying || !verifyTxHash.trim()}
                            className="w-full text-sm"
                          >
                            {verifying ? 'Verifying…' : 'Confirm Payment'}
                          </Button>
                        </div>
                      )}
                    </>
                  )}

                  {/* Payment detected / sending → move to processing */}
                  {(order.status === 'payment_detected' || order.status === 'sending') && (
                    <div>
                      <p className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-4">Processing</p>
                      <ProcessingTimeline status={order.status} isPkr={false} />
                    </div>
                  )}

                  {/* Expired / Failed */}
                  {(order.status === 'expired' || order.status === 'failed') && (
                    <div className="text-center py-4">
                      <p className="text-base font-bold text-red-600 mb-2">{order.status === 'expired' ? 'Order Expired' : 'Order Failed'}</p>
                      {order.status === 'expired' ? (
                        <>
                          <p className="text-sm text-gray-500 mb-3">Payment not received in time.</p>
                          {/* Grace window: offer verify option for recently-expired orders */}
                          {!verifyOpen && !verifySuccess ? (
                            <div className="mb-4 space-y-2">
                              <p className="text-xs text-gray-400">Already sent the payment? We can still verify it.</p>
                              <button
                                onClick={() => setVerifyOpen(true)}
                                className="text-xs text-blue-600 underline underline-offset-2 hover:text-blue-800 font-semibold"
                              >
                                Enter transaction hash to verify
                              </button>
                            </div>
                          ) : verifySuccess ? (
                            <div className="bg-green-50 border border-green-200 rounded-xl p-3 text-center mb-4">
                              <p className="text-sm font-bold text-green-700 mb-0.5">Payment Verified!</p>
                              <p className="text-xs text-green-600">{verifySuccess}</p>
                            </div>
                          ) : (
                            <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 space-y-3 text-left mb-4">
                              <div className="flex items-center justify-between">
                                <p className="text-xs font-bold text-blue-800">Verify Your Payment</p>
                                <button onClick={() => { setVerifyOpen(false); setVerifyError('') }} className="text-blue-400 hover:text-blue-600 text-lg leading-none">&times;</button>
                              </div>
                              <p className="text-xs text-blue-700">Enter the transaction hash from your wallet. If you paid before the timer expired, we&apos;ll process your order.</p>
                              <input
                                type="text"
                                value={verifyTxHash}
                                onChange={e => { setVerifyTxHash(e.target.value); setVerifyError('') }}
                                placeholder="0x... transaction hash"
                                className="w-full text-xs font-mono bg-white border border-blue-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400 placeholder:text-gray-300"
                              />
                              {verifyError && <p className="text-xs text-red-600">{verifyError}</p>}
                              <Button onClick={handleVerifyPayment} disabled={verifying || !verifyTxHash.trim()} className="w-full text-sm">
                                {verifying ? 'Verifying on-chain…' : 'Verify Payment'}
                              </Button>
                            </div>
                          )}
                          <Button onClick={resetFlow}>Create New Order</Button>
                        </>
                      ) : (
                        <>
                          <p className="text-sm text-gray-500 mb-4">Something went wrong.</p>
                          <Button onClick={resetFlow}>Try Again</Button>
                        </>
                      )}
                    </div>
                  )}

                  {/* Refund */}
                  {(order.status === 'refund_pending' || order.status === 'refunded') && (
                    <div className="text-center py-4">
                      <p className="text-base font-bold text-amber-600 mb-1">{order.status === 'refund_pending' ? 'Refund Processing' : 'Refunded'}</p>
                      <p className="text-sm text-gray-500">{order.status === 'refund_pending' ? 'Your USDT refund is being processed.' : 'Your USDT has been refunded.'}</p>
                    </div>
                  )}

                  {order.status === 'delivered' && (
                    <Button className="w-full" onClick={() => setPhase(PHASE.COMPLETE)}>View Completion</Button>
                  )}
                </div>
              )}

              {/* ─────────────────────────────────────────────────────────── */}
              {/* PHASE 11 — Processing (generic timeline)                    */}
              {/* ─────────────────────────────────────────────────────────── */}
              {phase === PHASE.PROCESSING && order && (
                <div className="p-5 space-y-4">
                  <div className="pb-3 border-b border-gray-100">
                    <p className="text-sm font-bold text-gray-900">Processing Your Order</p>
                    <p className="text-xs text-gray-500 mt-0.5">Order #{order.orderRef}</p>
                  </div>
                  <ProcessingTimeline status={order.status} isPkr={isPkrOrder} />
                  {order.status === 'delivered' && <Button className="w-full" onClick={() => setPhase(PHASE.COMPLETE)}>View Order Completion</Button>}
                  {['failed', 'expired'].includes(order.status) && (
                    <div className="text-center">
                      <p className="text-sm text-red-600 font-semibold mb-3">Order failed. Please try again.</p>
                      <Button onClick={resetFlow}>Try Again</Button>
                    </div>
                  )}
                </div>
              )}

              {/* ─────────────────────────────────────────────────────────── */}
              {/* PHASE 12 — Complete                                         */}
              {/* ─────────────────────────────────────────────────────────── */}
              {phase === PHASE.COMPLETE && order && (
                <div className="p-5 space-y-4 text-center">
                  <div className="py-4">
                    <div className="w-20 h-20 rounded-full bg-gradient-to-br from-green-400 to-green-600 flex items-center justify-center mx-auto mb-4 shadow-lg shadow-green-200">
                      <svg className="w-10 h-10 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                      </svg>
                    </div>
                    <p className="text-xl font-bold text-gray-900">Order Completed!</p>
                    <p className="text-sm text-gray-500 mt-1">Your gas fee order has been processed successfully.</p>
                  </div>

                  <div className="bg-gray-50 rounded-xl p-4 text-left space-y-2.5 text-xs">
                    <div className="flex justify-between"><span className="text-gray-500">Amount Received</span><span className="font-bold text-gray-900">{order.gasAmountNative} {order.nativeSymbol ?? selectedToken?.symbol}</span></div>
                    <div className="flex justify-between"><span className="text-gray-500">Destination</span><span className="font-mono text-gray-700">{order.toAddress.slice(0, 14)}...{order.toAddress.slice(-6)}</span></div>
                    <div className="flex justify-between"><span className="text-gray-500">Payment Method</span><span className="font-semibold capitalize">{isPkrOrder ? `PKR · ${order.pkrPaymentMethod?.replace('_', ' ') ?? ''}` : `USDT · ${order.paymentNetwork}`}</span></div>
                    <div className="flex justify-between"><span className="text-gray-500">Order ID</span><span className="font-mono text-gray-700">{order.orderRef}</span></div>
                    {order.deliveryTxHash && selectedChain && (
                      <div className="flex justify-between items-center pt-2 border-t border-gray-200">
                        <span className="text-gray-500">Transaction</span>
                        <a href={explorerUrl(selectedChain.slug, explorerBase, order.deliveryTxHash)} target="_blank" rel="noopener noreferrer"
                          className="text-xs text-purple-600 font-semibold hover:underline flex items-center gap-1">
                          {order.deliveryTxHash.slice(0, 12)}...
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                        </a>
                      </div>
                    )}
                  </div>

                  <div className="space-y-2">
                    {user && (
                      <Link href="/gas/orders">
                        <Button className="w-full">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
                          View Order Details
                        </Button>
                      </Link>
                    )}
                    <Button variant="secondary" className="w-full" onClick={resetFlow}>Buy More Gas</Button>
                  </div>
                </div>
              )}

            </div>
          </div>
        )}
      </div>
    </div>
  )
}
