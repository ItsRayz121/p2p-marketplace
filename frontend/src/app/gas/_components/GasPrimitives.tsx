'use client'
import { useState } from 'react'
import NextImage from 'next/image'
import { Spinner } from '@/components/ui/Spinner'
import type { GasChain, GasToken, GasPkrMethods } from '@/lib/api'
import { PKR_METHOD_META, type PkrMethodKey } from './GasContext'
import { resolveLogoStatic } from '@/lib/logoRegistry'

// Builds an ordered, deduped list of logo URLs to try, dropping any that have
// already failed. Mirrors EntityLogo's tiered resolution so chains/tokens fall
// back to the static CDN before the gradient-initials placeholder.
function firstLiveUrl(candidates: (string | null | undefined)[], failed: Set<string>): string | null {
  const seen = new Set<string>()
  for (const url of candidates) {
    if (url && !seen.has(url)) {
      seen.add(url)
      if (!failed.has(url)) return url
    }
  }
  return null
}

// ─── Chain / token category colours ──────────────────────────────────────────

const CAT_COLORS: Record<string, { gradient: string }> = {
  tron:      { gradient: 'from-red-400 to-red-600'       },
  bnb:       { gradient: 'from-yellow-400 to-yellow-600' },
  ethereum:  { gradient: 'from-blue-400 to-blue-600'     },
  solana:    { gradient: 'from-purple-400 to-purple-600' },
  sui:       { gradient: 'from-cyan-400 to-cyan-600'     },
  ton:       { gradient: 'from-sky-400 to-sky-600'       },
  avalanche: { gradient: 'from-red-400 to-red-600'       },
  polygon:   { gradient: 'from-violet-400 to-violet-600' },
  arbitrum:  { gradient: 'from-blue-500 to-indigo-600'   },
  optimism:  { gradient: 'from-rose-400 to-red-600'      },
  base:      { gradient: 'from-blue-600 to-blue-800'     },
  bitcoin:   { gradient: 'from-orange-400 to-orange-600' },
  xrp:       { gradient: 'from-slate-400 to-slate-600'   },
  cosmos:    { gradient: 'from-indigo-400 to-purple-600' },
  aptos:     { gradient: 'from-teal-400 to-cyan-600'     },
}

export const CAT_LABELS: Record<string, string> = {
  tron: 'TRON', bnb: 'BNB Chain', ethereum: 'Ethereum',
  solana: 'Solana', sui: 'SUI', ton: 'TON', avalanche: 'Avalanche', polygon: 'Polygon',
  arbitrum: 'Arbitrum', optimism: 'Optimism', base: 'Base',
  bitcoin: 'Bitcoin', xrp: 'XRP Ledger', cosmos: 'Cosmos',
  aptos: 'Aptos',
}

export function catGradient(cat: string): string {
  return CAT_COLORS[cat]?.gradient ?? 'from-gray-400 to-gray-600'
}

// ─── Address validation ───────────────────────────────────────────────────────

const ADDRESS_PATTERNS: Record<string, RegExp> = {
  TRC20: /^T[A-Za-z1-9]{33}$/,
  EVM:   /^0x[0-9a-fA-F]{40}$/,
  SOL:   /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  SUI:   /^0x[0-9a-fA-F]{64}$/,
  APTOS: /^0x[0-9a-fA-F]{64}$/,
  TON:   /^[UE][Qq][A-Za-z0-9+/\-_]{46}$/,
}

export function validateAddress(addr: string, addressType: string): boolean {
  const p = ADDRESS_PATTERNS[addressType]
  return p ? p.test(addr) : addr.length > 5
}

export function addressPlaceholder(addressType: string): string {
  switch (addressType) {
    case 'TRC20': return 'T... (34 characters)'
    case 'EVM':   return '0x... (42 characters)'
    case 'SOL':   return 'Base58 address (32–44 characters)'
    case 'SUI':   return '0x... (66 characters)'
    case 'APTOS': return '0x... (66 characters)'
    case 'TON':   return 'UQ... or EQ... (48 characters)'
    default:      return 'Enter wallet address'
  }
}

// ─── Explorer URL ─────────────────────────────────────────────────────────────

export function explorerUrl(chain: string, explorerBase: string | null, txHash: string): string {
  if (!explorerBase) return '#'
  return chain === 'TRON' ? `${explorerBase}/transaction/${txHash}` : `${explorerBase}/tx/${txHash}`
}

// ─── Status labels ────────────────────────────────────────────────────────────

export const STATUS_LABELS: Record<string, string> = {
  payment_pending:  'Awaiting Payment',
  payment_uploaded: 'Proof Submitted',
  payment_verified: 'Payment Verified',
  payment_detected: 'Payment Confirmed',
  sending:          'Delivering...',
  delivered:        'Completed',
  failed:           'Failed',
  expired:          'Expired',
  awaiting_refund:  'Delivery Delayed',
  refund_pending:   'Refund Processing',
  refunded:         'Refunded',
  cancelled:        'Cancelled',
}

export function statusVariant(s: string): 'warning' | 'success' | 'danger' | 'default' {
  if (s === 'delivered' || s === 'refunded') return 'success'
  if (s === 'failed' || s === 'expired' || s === 'cancelled') return 'danger'
  if (['payment_verified','payment_detected','sending','awaiting_refund','refund_pending','payment_uploaded'].includes(s)) return 'warning'
  return 'default'
}

// ─── Processing steps ─────────────────────────────────────────────────────────

const STEPS_CRYPTO = ['Payment Received', 'Verifying Payment', 'Processing Order', 'Releasing Gas Fee', 'Completed']
const STEPS_PKR    = ['Order Created', 'Proof Submitted', 'Payment Verified', 'Releasing Gas Fee', 'Completed']

function getActiveStep(status: string): number {
  if (status === 'payment_pending')  return 0
  if (status === 'payment_uploaded') return 1
  if (status === 'payment_verified') return 2
  if (status === 'payment_detected') return 2
  if (status === 'sending')          return 3
  if (status === 'delivered')        return 4
  return 0
}

export function ProcessingTimeline({ status, isPkr }: { status: string; isPkr: boolean }) {
  const steps = isPkr ? STEPS_PKR : STEPS_CRYPTO
  const active = getActiveStep(status)
  return (
    <div className="space-y-3">
      {steps.map((label, i) => {
        const done = i < active, cur = i === active
        return (
          <div key={label} className="flex items-center gap-3">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 transition-all ${
              done ? 'bg-green-500 text-white' : cur ? 'bg-primary text-white ring-4 ring-primary/20' : 'bg-surface-alt text-text-disabled'
            }`}>
              {done
                ? <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                : cur
                ? <div className="w-3 h-3 rounded-full bg-surface animate-pulse" />
                : <div className="w-2 h-2 rounded-full bg-text-disabled" />
              }
            </div>
            <p className={`text-sm font-semibold flex-1 ${done ? 'text-green-600 dark:text-green-400' : cur ? 'text-primary' : 'text-text-muted'}`}>{label}</p>
            {cur && <Spinner size="sm" />}
          </div>
        )
      })}
    </div>
  )
}

// ─── Refund steps ─────────────────────────────────────────────────────────────
// Shown when a delivery failed/expired AFTER payment was received, so the user
// sees their USDT is on its way back rather than a frozen "Payment Received".

const STEPS_REFUND = ['Payment Received', 'Refund Processing', 'USDT Refunded']

export function RefundTimeline({ status }: { status: string }) {
  // refund_pending → step 1 active (refunding); refunded → all complete.
  const active = status === 'refunded' ? 3 : 1
  return (
    <div className="space-y-3">
      {STEPS_REFUND.map((label, i) => {
        const done = i < active, cur = i === active
        return (
          <div key={label} className="flex items-center gap-3">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 transition-all ${
              done ? 'bg-green-500 text-white' : cur ? 'bg-amber-500 text-white ring-4 ring-amber-500/20' : 'bg-surface-alt text-text-disabled'
            }`}>
              {done
                ? <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                : cur
                ? <div className="w-3 h-3 rounded-full bg-surface animate-pulse" />
                : <div className="w-2 h-2 rounded-full bg-text-disabled" />
              }
            </div>
            <p className={`text-sm font-semibold flex-1 ${done ? 'text-green-600 dark:text-green-400' : cur ? 'text-amber-600 dark:text-amber-400' : 'text-text-muted'}`}>{label}</p>
            {cur && status !== 'refunded' && <Spinner size="sm" />}
          </div>
        )
      })}
    </div>
  )
}

// ─── Chain logo ───────────────────────────────────────────────────────────────

export function ChainLogo({ chain, sizeCls = 'w-11 h-11' }: { chain: GasChain; sizeCls?: string }) {
  const [failed, setFailed] = useState<Set<string>>(() => new Set())
  // custom (DB) logo → static network CDN (by symbol or category) → gradient.
  const url = firstLiveUrl(
    [chain.logoUrl, resolveLogoStatic('chain', chain.symbol), resolveLogoStatic('chain', chain.category)],
    failed,
  )
  if (url) {
    return (
      <NextImage src={url} alt={chain.symbol} width={44} height={44}
        className={`${sizeCls} rounded-full object-contain`}
        onError={() => setFailed((prev) => new Set([...prev, url]))} unoptimized />
    )
  }
  return (
    <div className={`${sizeCls} rounded-full bg-gradient-to-br ${catGradient(chain.category)} text-white font-bold text-xs flex items-center justify-center flex-shrink-0`}>
      {chain.symbol.slice(0, 3)}
    </div>
  )
}

// ─── Token logo ───────────────────────────────────────────────────────────────

export function TokenLogo({ token, cat, chainLogoUrl, sizeCls = 'w-10 h-10' }: {
  token: GasToken; cat: string; chainLogoUrl?: string | null; sizeCls?: string
}) {
  const [failed, setFailed] = useState<Set<string>>(() => new Set())
  // custom (DB) logo → static token CDN → chain's DB logo (native tokens) → chain CDN → gradient.
  const url = firstLiveUrl(
    [token.logoUrl, resolveLogoStatic('token', token.symbol), chainLogoUrl, resolveLogoStatic('chain', cat)],
    failed,
  )
  if (url) {
    return (
      <NextImage src={url} alt={token.symbol} width={40} height={40}
        className={`${sizeCls} rounded-full object-contain`}
        onError={() => setFailed((prev) => new Set([...prev, url]))} unoptimized />
    )
  }
  return (
    <div className={`${sizeCls} rounded-full bg-gradient-to-br ${catGradient(cat)} text-white font-bold text-xs flex items-center justify-center flex-shrink-0`}>
      {token.symbol.slice(0, 3)}
    </div>
  )
}

// ─── PKR method icon ──────────────────────────────────────────────────────────

export function PkrMethodIcon({ methodKey, pkrMethods, sizeCls = 'w-12 h-12' }: {
  methodKey: PkrMethodKey
  pkrMethods: GasPkrMethods | null
  sizeCls?: string
}) {
  const [failed, setFailed] = useState<Set<string>>(() => new Set())
  const meta = PKR_METHOD_META[methodKey]
  const dbLogoUrl = pkrMethods
    ? methodKey === 'bank_transfer' ? pkrMethods.bank.logoUrl : pkrMethods[methodKey as 'jazzcash' | 'easypaisa' | 'nayapay' | 'sadapay']?.logoUrl ?? null
    : null
  // DB logo → static CDN (icon.horse / gstatic) → text abbreviation
  const url = firstLiveUrl([dbLogoUrl, resolveLogoStatic('payment_method', methodKey)], failed)
  if (url) {
    return (
      <NextImage src={url} alt={meta.label} width={48} height={48}
        className={`${sizeCls} rounded-xl object-contain flex-shrink-0`}
        onError={() => setFailed((prev) => new Set([...prev, url]))} unoptimized />
    )
  }
  return (
    <div className={`${sizeCls} rounded-xl bg-primary/10 text-primary text-xs font-bold flex items-center justify-center flex-shrink-0`}>
      {meta.abbr}
    </div>
  )
}

// ─── Payment network logo (crypto payment step) ───────────────────────────────
// Maps BEP20 → BSC chain slug, APTOS → APTOS, etc., so CDN URLs resolve.

const PAYMENT_NETWORK_CHAIN_SLUG: Record<string, string> = {
  BEP20: 'BSC',
  APTOS: 'APTOS',
  ERC20: 'ETH',
  TRC20: 'TRON',
}

const PAYMENT_NETWORK_GRADIENT: Record<string, string> = {
  BEP20: 'from-yellow-400 to-yellow-600',
  APTOS: 'from-teal-500 to-cyan-700',
  ERC20: 'from-blue-400 to-blue-600',
  TRC20: 'from-red-400 to-red-600',
}

const PAYMENT_NETWORK_ABBR: Record<string, string> = {
  BEP20: 'BNB',
  APTOS: 'APT',
  ERC20: 'ETH',
  TRC20: 'TRX',
}

export function PaymentNetworkLogo({ networkKey, logoUrl, sizeCls = 'w-12 h-12' }: {
  networkKey: string
  logoUrl: string | null | undefined
  sizeCls?: string
}) {
  const [failed, setFailed] = useState<Set<string>>(() => new Set())
  const chainSlug = PAYMENT_NETWORK_CHAIN_SLUG[networkKey] ?? networkKey
  const url = firstLiveUrl([logoUrl, resolveLogoStatic('chain', chainSlug)], failed)
  const gradient = PAYMENT_NETWORK_GRADIENT[networkKey] ?? 'from-gray-400 to-gray-600'
  const abbr = PAYMENT_NETWORK_ABBR[networkKey] ?? networkKey.slice(0, 3)
  if (url) {
    return (
      <NextImage src={url} alt={networkKey} width={48} height={48}
        className={`${sizeCls} rounded-xl object-contain flex-shrink-0`}
        onError={() => setFailed((prev) => new Set([...prev, url]))} unoptimized />
    )
  }
  return (
    <div className={`${sizeCls} rounded-xl bg-gradient-to-br ${gradient} text-white font-bold text-sm flex items-center justify-center flex-shrink-0`}>
      {abbr}
    </div>
  )
}

export function pkrIsConfigured(key: PkrMethodKey, pkrMethods: GasPkrMethods | null): boolean {
  if (!pkrMethods) return true
  if (key === 'bank_transfer') return !!(pkrMethods.bank.bankName || pkrMethods.bank.iban)
  return !!(pkrMethods[key as 'jazzcash' | 'easypaisa' | 'nayapay' | 'sadapay']?.number)
}

// ─── Step indicator ───────────────────────────────────────────────────────────

const STEP_NAMES = ['Chain', 'Token', 'Amount', 'Address', 'Payment']

export function StepIndicator({ phase }: { phase: number }) {
  const idx = Math.min(Math.max(phase - 1, 0), 4)
  return (
    <div className="flex items-center justify-center gap-1 mb-5">
      {STEP_NAMES.map((name, i) => (
        <div key={name} className="flex items-center gap-1">
          <div className={`flex items-center gap-1.5 transition-opacity ${i <= idx ? 'opacity-100' : 'opacity-35'}`}>
            <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
              i < idx ? 'bg-primary text-white' : i === idx ? 'bg-primary text-white ring-4 ring-primary/20' : 'bg-surface-alt text-text-muted'
            }`}>
              {i < idx ? <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg> : i + 1}
            </div>
            <span className={`hidden sm:block text-xs font-medium ${i === idx ? 'text-primary' : 'text-text-muted'}`}>{name}</span>
          </div>
          {i < STEP_NAMES.length - 1 && <div className={`w-5 h-px mx-1 ${i < idx ? 'bg-primary/50' : 'bg-border'}`} />}
        </div>
      ))}
    </div>
  )
}

// ─── Chain skeleton ───────────────────────────────────────────────────────────

export function ChainSkeleton() {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3">
      {Array.from({ length: 10 }).map((_, i) => <div key={i} className="animate-pulse bg-surface-alt rounded-xl h-28" />)}
    </div>
  )
}

// ─── Back button ──────────────────────────────────────────────────────────────

export function BackBtn({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="text-text-muted hover:text-text-secondary transition-colors" aria-label="Go back">
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
      </svg>
    </button>
  )
}

// ─── Card step header ─────────────────────────────────────────────────────────

export function CardHeader({ onBack, title, sub, right }: { onBack?: () => void; title: string; sub?: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 pb-3 border-b border-border">
      {onBack && <BackBtn onClick={onBack} />}
      <div>
        <p className="text-sm font-bold text-text-primary">{title}</p>
        {sub && <p className="text-xs text-text-muted mt-0.5">{sub}</p>}
      </div>
      {right && <div className="ml-auto">{right}</div>}
    </div>
  )
}
