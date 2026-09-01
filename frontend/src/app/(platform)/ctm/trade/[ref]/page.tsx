'use client'
import React, { useState, use, useRef, useEffect, useCallback, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { ctmApi, walletApi } from '@/lib/api'
import type { SavedDeliveryAddress } from '@/lib/api'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { ctmCurrentStep, ctmFlowOrder, ctmDisputeLock } from '@/lib/ctmSettlementFlow'
import { ladderStatus, canPartiesStillSettle } from '@/lib/disputeResume'
import type { CtmFlowAction, CtmFlowActor } from '@/lib/ctmSettlementFlow'
import { usePolling } from '@/hooks/usePolling'
import { useSSE } from '@/hooks/useSSE'
import { useAuth } from '@/hooks/useAuth'
import { toast } from '@/lib/toast'
import { isTrustedImageUrl } from '@/lib/utils'
import { isOpaqueId } from '@/lib/pkPaymentMethods'
import { supportMailto } from '@/lib/contact'
import { TrustpilotPrompt } from '@/components/providers/TrustpilotPrompt'

/** Never surface an opaque payment-method ID to users — fall back to a label. */
function prettyMethod(value?: string | null): string {
  if (!value || isOpaqueId(value)) return 'Selected payment method'
  return value
}

/**
 * Category shown in a "Method" row. A bank account's own label IS the bank name,
 * which then duplicates the separate "Bank" row — so show the generic category
 * ("Bank Transfer") and let the Bank / IBAN rows carry the specifics (I1).
 */
function accountMethodLabel(acc: { label?: string | null; bankName?: string | null; ibanNumber?: string | null }): string {
  if (acc.bankName || acc.ibanNumber) return 'Bank Transfer'
  return acc.label ?? 'Selected payment method'
}
import NextImage from 'next/image'

const STATUS_STEPS = ['awaiting_payment', 'payment_uploaded', 'payment_confirmed', 'seller_transferring', 'proof_submitted', 'completed']

type Role = 'buyer' | 'seller' | 'admin'

function statusLabelForRole(status: string, role: Role): string {
  const map: Record<string, Record<Role, string>> = {
    awaiting_payment: { buyer: 'Action required: send payment', seller: 'Waiting for buyer payment', admin: 'Awaiting buyer payment' },
    payment_uploaded: { buyer: 'Waiting for seller to confirm', seller: 'Action required: review payment proof', admin: 'Awaiting seller confirmation' },
    payment_confirmed: { buyer: 'Waiting for seller to send tokens', seller: 'Action required: send tokens', admin: 'Awaiting token transfer' },
    seller_transferring: { buyer: 'Tokens being sent', seller: 'Submit transfer proof', admin: 'Tokens in transit' },
    proof_submitted: { buyer: 'Action required: confirm receipt', seller: 'Waiting for buyer confirmation', admin: 'Awaiting buyer confirmation' },
    buyer_confirming: { buyer: 'Action required: confirm receipt', seller: 'Waiting for buyer confirmation', admin: 'Awaiting buyer confirmation' },
    completed: { buyer: 'Completed', seller: 'Completed', admin: 'Completed' },
    cancelled: { buyer: 'Cancelled', seller: 'Cancelled', admin: 'Cancelled' },
    disputed: { buyer: 'Disputed', seller: 'Disputed', admin: 'Disputed' },
    dispute_resolved: { buyer: 'Dispute resolved', seller: 'Dispute resolved', admin: 'Dispute resolved' },
    expired: { buyer: 'Expired', seller: 'Expired', admin: 'Expired' },
  }
  return map[status]?.[role] ?? status
}

// Stepper labels for the CLASSIC flow (buyer pays first, then seller sends tokens).
const STEP_INFO = [
  { label: 'Trade Started', actor: null },
  { label: 'Payment Sent', actor: 'Buyer' },
  { label: 'Payment Confirmed', actor: 'Seller' },
  { label: 'Tokens Sent', actor: 'Seller' },
  { label: 'Tokens Received', actor: 'Buyer' },
  { label: 'Completed', actor: null },
]

// Stepper labels for the TAKER-FIRST flow (seller sends tokens first, buyer pays
// only after the tokens are confirmed). Same six rungs, but the token leg and the
// payment leg swap places — so the labels must swap too, otherwise the stepper
// mislabels each rung (e.g. showing "Payment Sent" while the seller is actually
// sending tokens). Order mirrors TAKER_FIRST in lib/ctmSettlementFlow.ts.
const STEP_INFO_TAKER_FIRST = [
  { label: 'Trade Started', actor: null },
  { label: 'Tokens Sent', actor: 'Seller' },
  { label: 'Tokens Received', actor: 'Buyer' },
  { label: 'Payment Sent', actor: 'Buyer' },
  { label: 'Payment Confirmed', actor: 'Seller' },
  { label: 'Completed', actor: null },
]

const DISPUTE_REASONS = ['proof_fake', 'not_received', 'amount_mismatch', 'wrong_token', 'seller_unresponsive', 'buyer_unresponsive', 'other']

// Cooldown before "Open Dispute" unlocks, measured from the trade's last status
// change — gives the counterparty a moment to act first. Mirrors the USDT
// marketplace dispute gate (DISPUTE_DELAY_MINUTES in trade.service.ts).
const DISPUTE_DELAY_MINUTES = 10

// Quick-feedback chips — same set as the USDT marketplace rating box.
const RATING_TAGS = ['Fast Payment', 'Good Communication', 'Smooth Trade', 'Trustworthy', 'Patient']

// Rating window: opens at completion and stays open for this many minutes, after
// which the trade can no longer be rated. Mirrors RATING_WINDOW_MINUTES in the
// USDT marketplace trade room (anchored to the trade's completion timestamp).
const RATING_WINDOW_MINUTES = 15

// Build a per-token explorer link. Each CTM token stores its own explorerUrl in
// the admin panel; there is no fixed registry, so we support two forms:
//   1. A full template containing {hash} — e.g. https://explorer.mec.me/tx/{hash}
//      (PREFERRED: lets each explorer's exact tx path be configured). {txhash} and
//      {tx} are accepted as aliases.
//   2. A bare base URL — we append the common "/tx/<hash>" path as a best-effort.
// If a token's explorer lands on a "No Data"/search page, the configured base URL
// is missing the correct tx path — set the full {hash} template in admin instead.
function buildExplorerUrl(baseUrl: string, txHash: string): string {
  const hash = encodeURIComponent(txHash.trim())
  if (/\{(hash|txhash|tx)\}/i.test(baseUrl)) return baseUrl.replace(/\{(hash|txhash|tx)\}/i, hash)
  return `${baseUrl.replace(/\/$/, '')}/tx/${hash}`
}

// Derive a human explorer name from the token's configured explorer URL so the
// "View on …" link reads e.g. "View on Mecscan" / "View on Sidrascan" instead of
// a generic "Explorer". Each CTM token sets its own explorerUrl in the admin
// panel, so we have no fixed registry — we pretty-print the hostname.
function explorerNameFromUrl(baseUrl?: string | null): string {
  if (!baseUrl) return 'Explorer'
  try {
    const host = new URL(baseUrl.includes('{hash}') ? baseUrl.replace('{hash}', '') : baseUrl).hostname
    const core = host.replace(/^www\./, '').split('.')[0] ?? host
    if (!core) return 'Explorer'
    return core.charAt(0).toUpperCase() + core.slice(1)
  } catch {
    return 'Explorer'
  }
}

// Small badge that mirrors the USDT marketplace's on-chain verification chip.
// CTM stores the verifier's result on each token proof (txVerificationStatus);
// surfacing it tells the buyer whether the transfer was independently confirmed.
function TxVerificationBadge({ status }: { status?: string | null }) {
  if (!status) return null
  if (status === 'verified' || status === 'admin_verified') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-green-600 dark:text-green-400 bg-green-500/10 border border-green-500/30 rounded px-2 py-0.5">
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
        On-chain verified
      </span>
    )
  }
  if (status === 'pending') {
    return <span className="inline-flex items-center gap-1 text-xs font-medium text-yellow-700 dark:text-yellow-400 bg-yellow-500/10 border border-yellow-500/30 rounded px-2 py-0.5">⏳ Confirming on-chain</span>
  }
  if (status === 'not_found') {
    return <span className="inline-flex items-center gap-1 text-xs font-medium text-orange-700 dark:text-orange-400 bg-orange-500/10 border border-orange-500/30 rounded px-2 py-0.5">⚠ Tx not found — pending or invalid</span>
  }
  if (status === 'skipped' || status === 'rpc_error') {
    return <span className="inline-flex items-center gap-1 text-xs font-medium text-text-muted bg-surface border border-border rounded px-2 py-0.5">⚠ Verify manually on explorer</span>
  }
  return null
}

function settlementLabel(type?: string): string {
  if (type === 'ON_CHAIN') return 'Blockchain Transfer'
  if (type === 'HYBRID') return 'Blockchain / Manual'
  return 'Manual Transfer'
}

function proofHashPlaceholder(settlementType?: string): string {
  if (settlementType === 'ON_CHAIN') return 'Paste the blockchain transaction hash (e.g. 0xabc123…)'
  if (settlementType === 'HYBRID') return '0xabc123… or transfer reference'
  return 'Transfer reference / ID'
}

function proofHashLabel(settlementType?: string): string {
  if (settlementType === 'ON_CHAIN') return 'Transaction Hash'
  if (settlementType === 'HYBRID') return 'Transaction Hash / Reference'
  return 'Transaction ID / Reference'
}

function isHashRequired(settlementType?: string): boolean {
  return settlementType === 'ON_CHAIN'
}

// For MANUAL (exchange-UID / off-chain) settlements there is no verifiable
// on-chain hash, so a screenshot of the transfer is the real proof and is
// required; the reference / ID stays optional. Blockchain settlements are the
// inverse (hash required, screenshot optional).
function isScreenshotRequired(settlementType?: string): boolean {
  return settlementType === 'MANUAL'
}

interface SellerPaymentAccount {
  type: string; label: string; accountName: string
  mobileNumber?: string; bankName?: string; ibanNumber?: string; accountNumber?: string
  // USDT payment snapshot (type === 'usdt')
  method?: string; address?: string
}
interface SellerPaymentSnapshot extends SellerPaymentAccount {
  accounts?: SellerPaymentAccount[]
  selectedIdx?: number
}

type BuyerPaymentSnapshot = SellerPaymentAccount & { accounts?: SellerPaymentAccount[] }

interface Trade {
  id: string; tradeRef: string; displayRef?: string | null; status: string
  /** Real ladder rung while `status` is parked at `disputed` (see lib/disputeResume). */
  disputeResumeStatus?: string | null
  tokenAmount: string; fiatAmount: string; pricePerUnit: string; paymentMethod: string
  settlementMethod: string; settlementNote: string; buyerSettlementId?: string
  sellerPaymentSnapshot?: SellerPaymentSnapshot
  buyerPaymentSnapshot?: BuyerPaymentSnapshot
  tokenDeliveryType?: string; settlementType: string
  takerFirst?: boolean
  // USDT-as-payment (present only on USDT trades)
  paymentCurrency?: string
  usdtDeliveryMethod?: string | null
  usdtDeliveryAddress?: string | null
  usdtAmount?: string | null
  expiresAt: string; confirmDeadlineAt?: string; proofDeadlineAt?: string; updatedAt?: string
  escrowAddress?: string; escrowAmount?: string; escrowCurrency?: string
  escrowTxHash?: string; escrowConfirmedAt?: string
  token: { name: string; symbol: string; logoUrl?: string; riskTier: string; explorerUrl?: string }
  buyer: { id: string; username: string; fullName: string | null }
  seller: { id: string; username: string; fullName: string | null }
  listing?: { side: string }
  proofs: Array<{ id: string; proofType: string; fileUrl?: string; txHash?: string; txVerificationStatus?: string | null; uploadedBy: string; description?: string; createdAt: string }>
  dispute?: { id: string; reason: string; description: string; status: string; resolution?: string; winner?: string; messages?: Array<{ id: string; senderId: string; message: string; createdAt: string }> }
  ratings: Array<{ ratedByUserId: string; ratedUserId: string; rating: number; comment?: string | null }>
  ratedByMe?: boolean
  /** Combined completed-trade count between this buyer & seller (USDT + CTM). */
  streakCount?: number
  /** Seller "payment not received": bounce count + latest reason. */
  proofRejectionCount?: number
  lastProofRejectReason?: string | null
}

interface Message { id: string; senderId: string; message: string; isSystem?: boolean; createdAt: string }

function Countdown({ deadline }: { deadline: string }) {
  const [diff, setDiff] = useState(new Date(deadline).getTime() - Date.now())
  useEffect(() => {
    const t = setInterval(() => setDiff(new Date(deadline).getTime() - Date.now()), 1000)
    return () => clearInterval(t)
  }, [deadline])
  if (diff <= 0) return <span className="text-red-600 dark:text-red-400 font-bold">Expired</span>
  const h = Math.floor(diff / 3600000); const m = Math.floor((diff % 3600000) / 60000); const s = Math.floor((diff % 60000) / 1000)
  return <span className="font-mono font-bold text-primary">{h > 0 ? `${h}:` : ''}{String(m).padStart(2, '0')}:{String(s).padStart(2, '0')}</span>
}

type StepState = 'completed' | 'active' | 'future'

function StepCard({
  stepNum, title, state, summary, expanded, onToggle, children,
}: {
  stepNum: number; title: string; state: StepState; summary?: string
  expanded: boolean; onToggle: () => void; children?: React.ReactNode
}) {
  const isExpanded = state === 'active' || (state === 'completed' && expanded)
  return (
    <div className={`border rounded-xl overflow-hidden transition-colors ${
      state === 'active' ? 'border-primary bg-surface shadow-card ring-1 ring-primary/10'
        : state === 'completed' ? 'border-green-500/30 bg-surface'
        : 'border-border bg-surface/50'
    }`}>
      <div
        className={`flex items-center gap-3 p-4 ${state === 'completed' ? 'cursor-pointer hover:bg-surface/40 transition-colors' : ''}`}
        onClick={state === 'completed' ? onToggle : undefined}
      >
        <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${
          state === 'completed' ? 'bg-green-500 text-white' : state === 'active' ? 'bg-primary text-white' : 'bg-surface-alt text-text-muted'
        }`}>
          {state === 'completed' ? '✓' : stepNum}
        </div>
        <div className="flex-1 min-w-0">
          <p className={`font-semibold text-sm ${state === 'active' ? 'text-primary' : state === 'completed' ? 'text-text-primary' : 'text-text-muted'}`}>
            {state === 'active' && <span className="mr-1">→</span>}
            {title}
          </p>
          {state === 'completed' && !isExpanded && summary && (
            <p className="text-xs text-text-muted mt-0.5 truncate">{summary}</p>
          )}
        </div>
        {state === 'completed' && (
          <svg className={`w-4 h-4 text-text-muted flex-shrink-0 transition-transform ${isExpanded ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
          </svg>
        )}
        {state === 'future' && (
          <svg className="w-4 h-4 text-text-disabled flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
          </svg>
        )}
      </div>
      {isExpanded && children && (
        <div className={`px-4 pb-4 border-t ${state === 'active' ? 'border-primary/10' : 'border-green-100'}`}>
          <div className="pt-3 space-y-3">{children}</div>
        </div>
      )}
    </div>
  )
}

function CtmTradeRoomPageInner({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = use(params)
  const searchParams = useSearchParams()
  const focusDispute = searchParams.get('focus') === 'dispute'
  const { user } = useAuth()
  const disputeSectionRef = useRef<HTMLDivElement>(null)
  const [highlightDispute, setHighlightDispute] = useState(false)
  const [trade, setTrade] = useState<Trade | null>(null)
  // The buyer's own saved USDT accounts — used to surface "Your Sending Account"
  // for a USDT trade (G1) so the payer sees their saved Gate/Binance/… UID
  // instead of a generic "send from your own account" line.
  const [mySavedAddresses, setMySavedAddresses] = useState<SavedDeliveryAddress[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)
  const [msgText, setMsgText] = useState('')
  const [sendingMsg, setSendingMsg] = useState(false)
  const [actionLoading, setActionLoading] = useState(false)
  const [proofFile, setProofFile] = useState<File | null>(null)
  const [disputeOpen, setDisputeOpen] = useState(false)
  const [disputeReason, setDisputeReason] = useState('')
  const [disputeDesc, setDisputeDesc] = useState('')
  const [rejectOpen, setRejectOpen] = useState(false)
  const [rejectReason, setRejectReason] = useState('not_received')
  const [rejectDetail, setRejectDetail] = useState('')
  const [txHash, setTxHash] = useState('')
  const [rating, setRating] = useState(5)
  const [ratingComment, setRatingComment] = useState('')
  const [ratingTags, setRatingTags] = useState<string[]>([])
  const [ratingError, setRatingError] = useState('')
  const [traderRatingDone, setTraderRatingDone] = useState(false)
  // Rating is optional, so the "Trade Completed" card starts COLLAPSED — the trade
  // is already done. The header shows the countdown; tapping expands it to leave
  // feedback. Mirrors the USDT room's collapsed-by-default rating card.
  const [step4Collapsed, setStep4Collapsed] = useState(true)
  const [error, setError] = useState('')
  const [selectingPayment, setSelectingPayment] = useState(false)
  const [expandedSteps, setExpandedSteps] = useState<Set<number>>(new Set())
  const chatEndRef = useRef<HTMLDivElement>(null)
  const prevMsgCountRef = useRef(0)
  // Every identifier this trade can be addressed by (URL ref, cuid, displayRef,
  // primary id). SSE events carry whichever the emitter used, so we match against
  // the whole set — otherwise a room opened via displayRef ignores events keyed on
  // the cuid and its live updates silently stop (messages appear to "disappear").
  const tradeIdsRef = useRef<string[]>([ref])
  // Mobile-only tab: at <lg the trade panel and chat stack, so chat lives on its
  // own tab. This keeps completing a step from scrolling the page into the chat
  // (the chat is display:none on the Trade tab, so its auto-scroll is a no-op).
  const [mobileTab, setMobileTab] = useState<'trade' | 'chat'>('trade')
  // New counterparty messages while on the Trade tab light up the Chat tab's dot.
  const lastSeenChatCountRef = useRef(0)
  const [unreadChat, setUnreadChat] = useState(false)

  const fetchTrade = useCallback(async () => {
    try {
      const res = await ctmApi.getTrade(ref) as Trade
      if (!Array.isArray(res.ratings)) res.ratings = []
      setTrade(res)
      tradeIdsRef.current = [ref, res.tradeRef, res.displayRef, res.id].filter(Boolean) as string[]
    } catch { /* ignore */ } finally { setLoading(false) }
  }, [ref])

  const fetchMessages = useCallback(async () => {
    try {
      const res = await ctmApi.getMessages(ref)
      const msgs = res as Message[]
      setMessages(msgs)
      if (msgs.length > prevMsgCountRef.current) {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
        prevMsgCountRef.current = msgs.length
      }
    } catch { /* ignore */ }
  }, [ref])

  useEffect(() => { fetchTrade(); fetchMessages() }, [fetchTrade, fetchMessages])
  usePolling(fetchTrade, 30_000, !loading)

  // Load the current user's saved USDT accounts once, to surface their own
  // sending account on a USDT trade (G1). Best-effort — never blocks the room.
  useEffect(() => {
    walletApi.getSavedAddresses().then((a) => setMySavedAddresses(Array.isArray(a) ? a : [])).catch(() => {})
  }, [])
  usePolling(fetchMessages, 15_000, !loading)

  useSSE((event) => {
    if (event.type === 'notification') {
      const md = (event.payload as { metadata?: { tradeRef?: string; tradeId?: string; displayRef?: string } } | undefined)?.metadata
      const hit = !!md && [md.tradeRef, md.tradeId, md.displayRef].some((v) => !!v && tradeIdsRef.current.includes(v))
      if (hit) {
        void fetchTrade()
        void fetchMessages()
      }
    }
  })

  // Deep-link from an "evidence requested" / dispute notification: scroll to and
  // briefly highlight the dispute panel + response area once the trade has loaded.
  useEffect(() => {
    if (!focusDispute || !trade) return
    const timer = setTimeout(() => {
      disputeSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setHighlightDispute(true)
    }, 250)
    const clear = setTimeout(() => setHighlightDispute(false), 3500)
    return () => { clearTimeout(timer); clearTimeout(clear) }
  }, [focusDispute, trade])

  // Once the trader rating is submitted, collapse the Complete & Rate card
  // automatically (and close the rating panel). MUST stay above the early
  // returns below — a hook after a conditional return changes the hook count
  // between renders (React error #310).
  useEffect(() => {
    if (traderRatingDone) {
      setStep4Collapsed(true)
    }
  }, [traderRatingDone])

  // Auto-open the "Rate the trade" card ONCE when a freshly completed trade still
  // has an open rating window and hasn't been rated — so the rating box is as
  // obvious as the USDT room's, not hidden behind a collapsed header (C1). The
  // window is recomputed from raw fields here because the derived `ratingWindowOpen`
  // is defined below the early returns and can't be referenced this high up.
  const autoOpenedRating = useRef(false)
  useEffect(() => {
    if (autoOpenedRating.current || !trade || trade.status !== 'completed' || traderRatingDone) return
    const endsAt = trade.updatedAt ? new Date(trade.updatedAt).getTime() + RATING_WINDOW_MINUTES * 60_000 : 0
    if (endsAt > Date.now()) { autoOpenedRating.current = true; setStep4Collapsed(false) }
  }, [trade, traderRatingDone])

  // Reflect an existing rating when the trade loads so the top banner shows the
  // "submitted" confirmation instead of an empty form after a reload.
  useEffect(() => {
    if (trade && user && trade.ratings?.some((r) => r.ratedByUserId === user.id)) {
      setTraderRatingDone(true)
    }
  }, [trade, user])

  // Live 1-second clock that drives the rating-window countdown (only runs once
  // the trade is completed). Mirrors the USDT marketplace rating timer.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (trade?.status !== 'completed') return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [trade?.status])

  // Unread tracking for the mobile Chat tab. New incoming messages while the user
  // is on the Trade tab light up the red dot; opening Chat resets it. MUST stay
  // above the early returns below (stable hook count across renders).
  useEffect(() => {
    if (mobileTab === 'chat') {
      lastSeenChatCountRef.current = messages.length
      setUnreadChat(false)
      return
    }
    if (messages.length > lastSeenChatCountRef.current) {
      const newOnes = messages.slice(lastSeenChatCountRef.current)
      // Only count messages from the counterparty (skip system + my own).
      if (newOnes.some((m) => !m.isSystem && m.senderId !== user?.id)) {
        setUnreadChat(true)
      }
    }
  }, [messages, mobileTab, user?.id])

  if (loading) return <div className="max-w-5xl mx-auto px-4 py-12 animate-pulse"><div className="bg-surface rounded-xl h-96 border border-border" /></div>
  if (!trade) return <div className="max-w-5xl mx-auto px-4 py-12 text-center text-text-muted">Trade not found.</div>

  const isBuyer = user?.id === trade.buyer.id
  const isSeller = user?.id === trade.seller.id
  // USDT-as-payment: the "payment" leg is USDT (on-chain / exchange) instead of PKR.
  const isUsdtTrade = trade.paymentCurrency === 'USDT'
  // All displayed amounts are rounded to max 3 dp site-wide (trailing zeros
  // trimmed). CTM USDT settlement is manual/screenshot-confirmed, so the tiny
  // rounding delta never affects the payment — and it keeps long 6-dp amounts
  // (e.g. 0.157989) from wrapping the header into noise.
  const usdtAmountLabel = trade.usdtAmount != null
    ? `${Number(trade.usdtAmount).toLocaleString(undefined, { maximumFractionDigits: 3 })} USDT`
    : '— USDT'
  const payAmountLabel = isUsdtTrade ? usdtAmountLabel : `PKR ${Number(trade.fiatAmount).toLocaleString()}`
  const usdtAmountLabelShort = usdtAmountLabel
  const payAmountLabelShort = payAmountLabel
  // Dispute-resume: the ladder runs off the REAL rung, not the parked `disputed`
  // status — so an open dispute no longer kills every step card. Identical to
  // `trade.status` for every trade that isn't disputed. The status badge, the
  // dispute banner and the terminal-state checks all still read `trade.status`.
  const rung = ladderStatus(trade)
  const partiesCanSettle = canPartiesStillSettle(trade, trade.dispute)
  const stepIndex = STATUS_STEPS.indexOf(rung)

  // ── Flow-aware step model (single source of truth for BOTH flows) ───────────
  // Mirrors the USDT room. The settlement resolver decides who does what next in
  // the classic (fiat-first) and taker-first (crypto-first) flows; card ORDER,
  // active-state, and the action shown all derive from it — one coherent ladder
  // instead of a separate "Step N of 6" banner disagreeing with the cards below.
  // Defined up here (before the render helpers) so renderSellerAccountBlock can
  // gate the pay-account picker on the real "buyer is paying now" action.
  const takerFirst = !!trade.takerFirst
  const flowStep = ctmCurrentStep(takerFirst, rung)
  const myRole: CtmFlowActor = isBuyer ? 'buyer' : 'seller'
  const myTurn = !!flowStep && flowStep.actor === myRole
  const isAction = (a: CtmFlowAction) => !!flowStep && flowStep.action === a
  const order = ctmFlowOrder(takerFirst)
  // `stepIndex` (ladder position of the current status) and `order.indexOf(action)`
  // share one coordinate system, so a card's state follows from how far we've come.
  const legState = (actions: CtmFlowAction[]): StepState => {
    const idxs = actions.map((a) => order.indexOf(a))
    const start = Math.min(...idxs)
    const end = Math.max(...idxs)
    if (stepIndex > end) return 'completed'
    if (stepIndex >= start) return 'active'
    return 'future'
  }
  // Display order / step numbers: crypto leg leads in taker-first, fiat leg leads
  // in classic; Complete is always last.
  const legPos = takerFirst
    ? { crypto: 1, fiat: 2, fiat_confirm: 3, complete: 4 }
    : { fiat: 1, fiat_confirm: 2, crypto: 3, complete: 4 }

  // Rating window — opens at completion (anchored to updatedAt, consistent with
  // the CTM dispute timer) and lasts RATING_WINDOW_MINUTES. Once it closes the
  // form stays visible but submission is blocked, mirroring the USDT marketplace.
  const ratingWindowEndsAt = trade.status === 'completed' && trade.updatedAt
    ? new Date(trade.updatedAt).getTime() + RATING_WINDOW_MINUTES * 60_000
    : 0
  const ratingMsLeft = ratingWindowEndsAt - now
  const ratingWindowOpen = !traderRatingDone && ratingMsLeft > 0
  const ratingWindowClosed = !traderRatingDone && ratingWindowEndsAt > 0 && ratingMsLeft <= 0
  const ratingMM = Math.max(0, Math.floor(ratingMsLeft / 60_000))
  const ratingSS = Math.max(0, Math.floor((ratingMsLeft % 60_000) / 1000))
  const ratingCountdown = `${ratingMM}:${String(ratingSS).padStart(2, '0')}`

  const paymentProofs = trade.proofs.filter((p) => p.proofType === 'screenshot' && p.uploadedBy === trade.buyer.id)
  const tokenProofs = trade.proofs.filter((p) => p.uploadedBy === trade.seller.id)
  const latestTokenProof = tokenProofs[tokenProofs.length - 1]

  const doAction = async (fn: () => Promise<unknown>) => {
    setError(''); setActionLoading(true)
    try { await fn(); await fetchTrade() }
    catch (e: unknown) { setError((e as Error).message ?? 'Action failed') }
    finally { setActionLoading(false) }
  }

  const handleUploadPaymentProof = async () => {
    if (!proofFile) { setError('Select a file first'); return }
    setError(''); setActionLoading(true)
    try {
      const fd = new FormData(); fd.append('file', proofFile)
      await ctmApi.uploadPaymentProof(ref, fd)
      setProofFile(null); await fetchTrade()
    } catch (e: unknown) { setError((e as Error).message ?? 'Upload failed') }
    finally { setActionLoading(false) }
  }

  const handleUploadTokenProof = async () => {
    const hashRequired = isHashRequired(trade.settlementType)
    const screenshotRequired = isScreenshotRequired(trade.settlementType)
    if (hashRequired && !txHash.trim()) { setError('Transaction hash is required for blockchain token transfers'); return }
    if (screenshotRequired && !proofFile) { setError('A transfer screenshot is required for this token. The reference / ID is optional.'); return }
    if (!txHash.trim() && !proofFile) { setError('Enter a transfer reference or upload a screenshot'); return }
    setError(''); setActionLoading(true)
    // Only on-chain-capable settlements treat the value as a verifiable tx hash.
    // For MANUAL (UID/off-chain) settlements the value is a plain reference, so
    // the proof is the screenshot — never send proofType 'txhash' there or the
    // backend would try to verify a reference against a non-wallet UID.
    const treatAsHash = !screenshotRequired && !!txHash.trim()
    try {
      if (proofFile) {
        const fd = new FormData()
        if (txHash.trim()) fd.append('txHash', txHash.trim())
        fd.append('proofType', treatAsHash ? 'txhash' : 'screenshot')
        fd.append('file', proofFile)
        await ctmApi.uploadTokenProof(ref, fd)
      } else {
        await ctmApi.uploadTokenProof(ref, { txHash: txHash.trim(), proofType: 'txhash' })
      }
      setProofFile(null); setTxHash(''); await fetchTrade()
    } catch (e: unknown) { setError((e as Error).message ?? 'Upload failed') }
    finally { setActionLoading(false) }
  }

  const handleSendMessage = async () => {
    if (!msgText.trim()) return
    setSendingMsg(true)
    try {
      await ctmApi.sendMessage(ref, { message: msgText })
      setMsgText('')
      await fetchMessages()
    } catch (e: unknown) {
      toast.error((e as Error).message ?? 'Failed to send message')
    } finally {
      setSendingMsg(false)
    }
  }

  const handleOpenDispute = async () => {
    if (!disputeReason) { setError('Select a dispute reason'); return }
    if (disputeDesc.trim().length < 10) { setError('Add at least 10 characters describing the issue'); return }
    await doAction(() => ctmApi.openDispute(ref, { reason: disputeReason, description: disputeDesc.trim() }))
    setDisputeOpen(false)
  }

  const handleRejectPayment = async () => {
    if (rejectDetail.trim().length < 10) { setError('Add at least 10 characters explaining the issue for the buyer'); return }
    await doAction(() => ctmApi.rejectPayment(ref, { reason: rejectReason, detail: rejectDetail.trim() }))
    setRejectOpen(false); setRejectDetail(''); setRejectReason('not_received')
  }

  const handleRate = async () => {
    setRatingError('')
    if (ratingWindowClosed) {
      setRatingError(`The ${RATING_WINDOW_MINUTES}-minute rating window has closed — this trade can no longer be rated.`)
      return
    }
    try {
      await ctmApi.rateTrade(ref, { rating, comment: ratingComment.trim() || undefined, tags: ratingTags.length ? ratingTags : undefined })
      setTraderRatingDone(true)
    } catch (e: unknown) {
      setRatingError((e as Error).message ?? 'Failed to submit rating')
    }
  }

  const handleSelectAccount = async (idx: number) => {
    setSelectingPayment(true)
    try {
      await ctmApi.selectTradePaymentAccount(ref, idx)
      await fetchTrade()
    } catch (e) {
      setError((e as Error).message ?? 'Failed to select account')
    } finally {
      setSelectingPayment(false)
    }
  }

  const toggleStep = (n: number) => {
    setExpandedSteps(prev => {
      const next = new Set(prev)
      if (next.has(n)) next.delete(n)
      else next.add(n)
      return next
    })
  }

  const snap = trade.sellerPaymentSnapshot
  const isMultiAccount = !!(snap?.accounts && snap.accounts.length > 0)
  const isAccountLocked = isMultiAccount && snap?.selectedIdx !== undefined
  const lockedAccount = isAccountLocked ? snap!.accounts![snap!.selectedIdx!] : null

  const paymentMethodLabel = snap?.accounts
    ? (snap.selectedIdx !== undefined ? (snap.accounts[snap.selectedIdx]?.label ?? snap.accounts.map(a => a.label).join(' / ')) : snap.accounts.map(a => a.label).join(' / '))
    : (snap?.label ?? prettyMethod(trade.paymentMethod))

  const renderSingleAccount = (acc: SellerPaymentAccount) => (
    <div className="bg-surface rounded-xl p-3 space-y-1.5 text-sm">
      {/* Method row carries a logo (I3) so the payer can eyeball the rail. */}
      <div className="flex items-center justify-between gap-3">
        <span className="text-text-muted flex-shrink-0">Method</span>
        <span className="inline-flex items-center gap-1.5 font-medium text-text-primary">
          <EntityLogo type={acc.bankName || acc.ibanNumber ? 'bank' : 'payment_method'} slug={acc.label} size="xs" className="flex-shrink-0" />
          {accountMethodLabel(acc)}
        </span>
      </div>
      <Row label="Account Name" value={acc.accountName} copyable />
      {acc.mobileNumber && <Row label="Payment number" value={acc.mobileNumber} mono copyable />}
      {acc.bankName && <Row label="Bank" value={acc.bankName} />}
      {acc.ibanNumber && <Row label="IBAN" value={acc.ibanNumber} mono breakAll copyable />}
      {acc.accountNumber && !acc.ibanNumber && <Row label="Account No." value={acc.accountNumber} mono copyable />}
    </div>
  )

  const renderSellerAccountBlock = (isBuyerView: boolean) => {
    // USDT payment: single receive point (method + address/UID + amount owed).
    if (isUsdtTrade) {
      const method = trade.usdtDeliveryMethod ?? snap?.method ?? ''
      const address = trade.usdtDeliveryAddress ?? snap?.address ?? ''
      const isWallet = /^(BEP20|APTOS|ERC20|TRC20)$/i.test(method)
      return (
        <div className="bg-surface rounded-xl p-3 space-y-1.5 text-sm">
          <Row label="Pay in" value="USDT" />
          {method && <Row label="Method" value={`USDT ${method}`} />}
          <Row label="Amount" value={usdtAmountLabel} copyable />
          {address && <Row label={isWallet ? 'Send to address' : 'Send to UID / account'} value={address} mono breakAll copyable />}
        </div>
      )
    }
    // Gate on the "buyer pays fiat now" ACTION, not a raw status — in taker-first
    // the buyer pays at 'seller_transferring', not 'awaiting_payment', so a
    // status check would hide the pay-account picker and deadlock the payment.
    const needsSelection = isMultiAccount && !isAccountLocked && isBuyerView && isAction('send_fiat')
    const waitingForSelection = isMultiAccount && !isAccountLocked && !isBuyerView && isAction('send_fiat')
    if (needsSelection) {
      return (
        <div>
          <p className="text-xs text-amber-700 dark:text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2 mb-3">
            Select the payment account you will use to send {payAmountLabel}. This will be locked for the trade.
          </p>
          <div className="space-y-2">
            {snap!.accounts!.map((acc, i) => (
              <div key={i} className="border border-border rounded-xl p-3 text-sm space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-text-primary">{acc.label}</span>
                  <button onClick={() => handleSelectAccount(i)} disabled={selectingPayment}
                    className="text-xs bg-primary text-white px-3 py-1 rounded-lg font-medium hover:bg-primary/90 transition-colors disabled:opacity-50">
                    {selectingPayment ? 'Selecting…' : 'Send to this account'}
                  </button>
                </div>
                <Row label="Account Name" value={acc.accountName} copyable />
                {acc.mobileNumber && <Row label="Payment number" value={acc.mobileNumber} mono copyable />}
                {acc.bankName && <Row label="Bank" value={acc.bankName} />}
                {acc.ibanNumber && <Row label="IBAN" value={acc.ibanNumber} mono breakAll copyable />}
                {acc.accountNumber && !acc.ibanNumber && <Row label="Account No." value={acc.accountNumber} mono copyable />}
              </div>
            ))}
          </div>
        </div>
      )
    }
    if (waitingForSelection) {
      return (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 text-sm text-amber-800 dark:text-amber-300">
          Waiting for buyer to select a payment account. You will be notified once they choose.
        </div>
      )
    }
    if (lockedAccount) return renderSingleAccount(lockedAccount)
    if (snap) {
      return isMultiAccount
        ? <div className="space-y-2">{snap.accounts!.map((acc, i) => <div key={i}>{renderSingleAccount(acc)}</div>)}</div>
        : renderSingleAccount(snap)
    }
    return (
      <div className="bg-surface rounded-xl p-3 text-sm text-text-muted">
        Payment via: <span className="font-medium text-text-primary">{prettyMethod(trade.paymentMethod)}</span>
      </div>
    )
  }

  const renderBuyerAccountBlock = (isBuyerView = true) => {
    const b = trade.buyerPaymentSnapshot
    // BUY listings can record more than one pay-from account (lister picked several).
    if (b?.accounts && b.accounts.length > 0) {
      return <div className="space-y-2">{b.accounts.map((acc, i) => <div key={i}>{renderSingleAccount(acc)}</div>)}</div>
    }
    // USDT trade: the payer declared the account/wallet they send FROM (their
    // Binance UID / BEP20 address, matching the payment method) at trade start.
    if (b?.type === 'usdt') {
      const isWallet = /^(BEP20|APTOS|ERC20|TRC20)$/i.test(b.method ?? '')
      return (
        <div className="bg-surface rounded-xl p-3 space-y-1.5 text-sm">
          <Row label="Method" value={`USDT ${b.method ?? ''}`} />
          {b.address && <Row label={isWallet ? 'Sends from address' : 'Sends from UID / account'} value={b.address} mono breakAll copyable />}
        </div>
      )
    }
    if (b) {
      return (
        <div className="bg-surface rounded-xl p-3 space-y-1.5 text-sm">
          <Row label="Method" value={accountMethodLabel(b)} />
          <Row label="Account Name" value={b.accountName} copyable />
          {b.mobileNumber && <Row label="Payment number" value={b.mobileNumber} mono copyable />}
          {b.bankName && <Row label="Bank" value={b.bankName} />}
          {b.ibanNumber && <Row label="IBAN" value={b.ibanNumber} mono breakAll copyable />}
          {b.accountNumber && !b.ibanNumber && <Row label="Account No." value={b.accountNumber} mono copyable />}
        </div>
      )
    }
    // No stored pay-from snapshot. For a USDT exchange/UID transfer this is normal —
    // the payer just sends from their own exchange balance to the seller's UID above,
    // so there are no "account details" to show. Say that plainly instead of the
    // alarming "(account details not provided)".
    // G1: for a USDT trade, surface the payer's OWN saved account(s) for the
    // seller's rail (e.g. their Gate UID) so "Your Sending Account" is concrete,
    // not a generic instruction. Falls back to the plain message when none match.
    // Only valid on the payer's OWN screen — mySavedAddresses are the current
    // viewer's, so we must never surface them to the seller as the *buyer's* account.
    if (isUsdtTrade && isBuyerView) {
      const method = (trade.usdtDeliveryMethod ?? '').toLowerCase()
      const mine = mySavedAddresses.filter((a) => a.network.toLowerCase() === method && a.coin.toUpperCase() === 'USDT')
      const usdtMine = mine.length > 0 ? mine : mySavedAddresses.filter((a) => a.network.toLowerCase() === method)
      if (usdtMine.length > 0) {
        return (
          <div className="space-y-2">
            {usdtMine.map((a) => (
              <div key={a.id} className="bg-surface rounded-xl p-3 space-y-1.5 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-text-muted flex-shrink-0">Method</span>
                  <span className="inline-flex items-center gap-1.5 font-medium text-text-primary">
                    <EntityLogo type="exchange" slug={a.network} size="xs" className="flex-shrink-0" />
                    {a.network}
                  </span>
                </div>
                <Row label={a.label || 'Your account'} value={a.address} mono breakAll copyable />
              </div>
            ))}
            <p className="text-xs text-text-muted">Send the USDT from this account to the seller&apos;s address / UID above.</p>
          </div>
        )
      }
    }
    return (
      <div className="bg-surface rounded-xl p-3 text-sm text-text-muted">
        {isUsdtTrade ? (
          isBuyerView
            ? <>Send the USDT from your own account to the seller&apos;s address / UID above.</>
            : <>The buyer will send USDT from their own account to your address / UID above.</>
        ) : (
          <>Method: <span className="font-medium text-text-primary">{prettyMethod(trade.paymentMethod)}</span></>
        )}
      </div>
    )
  }

  const renderTokenProofsList = () =>
    tokenProofs.length > 0 ? (
      <div className="space-y-2">
        <p className="text-xs font-medium text-text-muted">Token Transfer Proof</p>
        {tokenProofs.map((p) => (
          <div key={p.id} className="border border-border rounded-xl p-3 space-y-2">
            <p className="text-xs text-text-muted">{new Date(p.createdAt).toLocaleString()}</p>
            {p.txHash && (
              <div className="bg-surface rounded-lg p-2.5 space-y-1.5">
                <p className="text-xs text-text-muted font-medium">{proofHashLabel(trade.settlementType)}</p>
                <CopyableText value={p.txHash} mono />
                <TxVerificationBadge status={p.txVerificationStatus} />
                {trade.token.explorerUrl && (
                  <a href={buildExplorerUrl(trade.token.explorerUrl, p.txHash)} target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-primary font-medium hover:underline">
                    View on {explorerNameFromUrl(trade.token.explorerUrl)} →
                  </a>
                )}
              </div>
            )}
            {p.fileUrl && (
              isTrustedImageUrl(p.fileUrl)
                ? <NextImage src={p.fileUrl} alt="token transfer proof" width={320} height={160} className="max-h-40 w-auto rounded-lg object-contain border border-border" referrerPolicy="no-referrer" unoptimized />
                : <p className="text-xs text-warning bg-warning/10 rounded px-2 py-1">Proof image from untrusted source.</p>
            )}
            {p.description && <p className="text-xs text-text-muted">{p.description}</p>}
          </div>
        ))}
      </div>
    ) : null

  const disputeUnlockAt = trade.updatedAt ? new Date(trade.updatedAt).getTime() + DISPUTE_DELAY_MINUTES * 60_000 : null
  // Dispute lock (mirrors backend ctmDisputeLock): once a party confirms the
  // counterparty's leg, disputing instead of delivering their own is a pure stall
  // lever, so they're barred from there on. The locked party is FLOW-DEPENDENT —
  // classic locks the seller (confirmed fiat), taker-first locks the buyer/maker
  // (confirmed crypto) — so derive it from the resolver, don't assume the seller.
  const lock = ctmDisputeLock(takerFirst)
  const iAmLockedParty = lock.actor === 'buyer' ? isBuyer : isSeller
  const disputeLockedForMe = iAmLockedParty && lock.lockedStatuses.includes(trade.status) && !trade.dispute
  // Disputable window mirrors the backend: any active status except awaiting_payment.
  const disputeWindowOpen = ['payment_uploaded', 'payment_confirmed', 'seller_transferring', 'proof_submitted'].includes(trade.status) && !trade.dispute
  const disputeBtn = disputeLockedForMe
    ? (
      <div className="bg-surface rounded-xl border border-border p-4 text-sm text-text-secondary">
        <p className="mb-2">You already confirmed your counterparty delivered their part, so the only remaining step is to <span className="font-medium text-text-primary">send your own leg</span>. You can&apos;t open a dispute at this stage.</p>
        <p>If something is genuinely wrong, <a href={supportMailto(`CTM trade ${trade.displayRef ?? trade.tradeRef} — issue after confirming`)} className="text-primary underline">contact support</a>.</p>
      </div>
    )
    : (isBuyer || isSeller) && disputeWindowOpen
    ? <DisputeUnlockGate unlockAt={disputeUnlockAt} onOpen={() => setDisputeOpen(true)} />
    : null

  const ratingPanel = (counterparty: string) => (
    <div className="space-y-5">
      <p className="text-sm text-text-muted -mt-1">Thank you for using RupChain.</p>
      {/* Trade summary — mirrors the USDT marketplace rating box. Full-width so the
          four tiles sit on one horizontal row on larger screens. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
        <div className="bg-surface rounded-lg border border-border p-3">
          <p className="text-text-muted text-xs mb-0.5">Token</p>
          <p className="font-semibold text-text-primary">{trade.tokenAmount} {trade.token.symbol}</p>
        </div>
        <div className="bg-surface rounded-lg border border-border p-3">
          <p className="text-text-muted text-xs mb-0.5">{isUsdtTrade ? 'Total USDT' : 'Total PKR'}</p>
          <p className="font-semibold text-text-primary">{payAmountLabelShort}</p>
        </div>
        <div className="bg-surface rounded-lg border border-border p-3">
          <p className="text-text-muted text-xs mb-0.5">Payment Method</p>
          <p className="font-semibold text-text-primary">{paymentMethodLabel}</p>
        </div>
        <div className="bg-surface rounded-lg border border-border p-3">
          <p className="text-text-muted text-xs mb-0.5">{isBuyer ? 'Seller' : 'Buyer'}</p>
          <p className="font-semibold text-text-primary">{counterparty}</p>
        </div>
      </div>
      <div className="border-t border-border pt-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-text-primary">Rate your experience with {counterparty}</p>
          {ratingWindowOpen && (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-gold flex-shrink-0" title="Time left to submit your rating">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
              {ratingCountdown} left
            </span>
          )}
        </div>
        {traderRatingDone ? (
          <div className="bg-green-500/10 border border-green-500/30 rounded-xl p-3 text-sm text-green-700 dark:text-green-300">✓ Trader rating submitted.</div>
        ) : (
          <>
            {ratingError && <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 text-sm text-red-700 dark:text-red-300">{ratingError}</div>}
            <div>
              <p className="text-sm text-text-muted mb-2">How was your experience?</p>
              <div className="flex gap-2" role="group" aria-label="Star rating">
                {[1, 2, 3, 4, 5].map((s) => (
                  <button key={s} onClick={() => setRating(s)} aria-label={`Rate ${s} out of 5`} aria-pressed={s <= rating}
                    className={`text-2xl transition-transform hover:scale-110 ${s <= rating ? 'text-gold' : 'text-text-muted/30'}`}>★</button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {RATING_TAGS.map((tag) => (
                <button key={tag} type="button"
                  onClick={() => setRatingTags((prev) => prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag])}
                  className={`px-3 py-1.5 text-xs rounded-full border transition-colors ${ratingTags.includes(tag) ? 'bg-primary text-white border-primary' : 'border-border text-text-secondary hover:border-primary/40'}`}>
                  {tag}
                </button>
              ))}
            </div>
            <textarea rows={3} placeholder="Add a comment (optional)" value={ratingComment} onChange={(e) => setRatingComment(e.target.value)} className="w-full border border-border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none" />
            {/* When the window closes the form stays visible — only submission is
                blocked — so the trade record/details remain readable. */}
            {ratingWindowClosed && (
              <p className="text-xs text-text-muted bg-surface-alt/60 rounded-lg px-3 py-2">
                The {RATING_WINDOW_MINUTES}-minute rating window has closed — this trade can no longer be rated.
              </p>
            )}
            <div className="flex gap-2">
              <button onClick={() => setStep4Collapsed(true)} className="flex-1 border border-border py-2 rounded-xl text-sm">Skip</button>
              <button onClick={handleRate} disabled={ratingWindowClosed} className="flex-1 bg-primary text-white py-2 rounded-xl text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">Submit Rating</button>
            </div>
          </>
        )}
      </div>

      {/* Public platform review — a peer to the trader rating above, not a
          replacement. Self-gates: hidden unless NEXT_PUBLIC_TRUSTPILOT_URL is set,
          shown at most once per browser per ~75 days, never incentivised. Offered
          for every completed CTM trade at any in-app score. */}
      <TrustpilotPrompt surface="trade" />

      <button onClick={() => setStep4Collapsed(true)} className="w-full border border-border py-2 rounded-xl text-sm text-text-muted hover:bg-surface transition-colors">Close</button>
    </div>
  )

  const completedCounterparty = isBuyer
    ? (trade.seller.fullName || trade.seller.username)
    : (trade.buyer.fullName || trade.buyer.username)

  // Rating-aware summary for the completed step so it reads like the USDT room's
  // obvious "Rate the Trade — Optional · countdown" card (C1).
  const completedSummary = trade.status !== 'completed'
    ? 'You can rate your counterparty below'
    : traderRatingDone
      ? 'Rating submitted — thank you'
      : ratingWindowOpen
        ? `Rate the trade — optional · ${ratingCountdown} left`
        : 'You can rate your counterparty below'

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">

      {/* Rating lives at the BOTTOM now (as an optional collapsible "Complete &
          Rate" step), so there's no pinned completed banner at the top. */}

      {/* Header — trade identity + status. The details live here so the progress
          bar below stays a clean, at-a-glance strip (mirrors the USDT room). */}
      <div className="mb-4 space-y-1.5">
        {/* Token amount + status on the top row. The status pill can be long
            ("Action required: review payment proof"), so the streak badge and the
            trade-ref line each get their OWN full-width row below — that stops the
            ref from wrapping across four lines when the status squeezes the column. */}
        <div className="flex items-start justify-between gap-2">
          <h1 className="font-bold text-text-primary text-lg sm:text-xl leading-tight min-w-0">{trade.tokenAmount} {trade.token.symbol}</h1>
          <span className={`text-xs px-2.5 py-1 rounded-full font-medium flex-shrink-0 text-right ${trade.status === 'completed' ? 'bg-green-500/15 text-green-700 dark:text-green-300' : trade.status === 'disputed' ? 'bg-red-500/15 text-red-700 dark:text-red-300' : 'bg-yellow-500/15 text-yellow-800 dark:text-yellow-300'}`}>
            {statusLabelForRole(trade.status, isBuyer ? 'buyer' : isSeller ? 'seller' : 'admin')}
          </span>
        </div>
        {typeof trade.streakCount === 'number' && trade.streakCount > 0 && (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 border border-amber-500/25 px-2 py-0.5 text-xs font-semibold text-amber-600 dark:text-amber-400"
            title="Combined completed trades between you two (USDT + community tokens)"
          >
            🤝 {trade.streakCount} {trade.streakCount === 1 ? 'trade' : 'trades'} together
          </span>
        )}
        <p className="text-text-muted text-sm">{payAmountLabelShort} · Trade #{trade.displayRef ?? trade.tradeRef.slice(-8)}</p>
      </div>

      {/* Mobile Trade/Chat tabs — chat gets its own tab so completing a step never
          scrolls the page down into the chat. Desktop shows both columns. */}
      <div className="flex bg-surface border border-border rounded-xl overflow-hidden mb-4 lg:hidden">
        {(['trade', 'chat'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setMobileTab(t)}
            className={`flex-1 px-4 py-2.5 text-sm font-medium transition-colors flex items-center justify-center gap-2 ${mobileTab === t ? 'bg-primary text-white' : 'text-text-secondary hover:bg-surface'}`}
          >
            {t === 'trade' ? 'Trade' : 'Chat'}
            {t === 'chat' && unreadChat && <span className="w-2 h-2 rounded-full bg-red-500" />}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">

        {/* Left: Trade panel */}
        <div className={`lg:col-span-3 space-y-4 ${mobileTab === 'chat' ? 'hidden lg:block' : ''}`}>

          {/* Countdown — its own compact card, above the progress strip. */}
          {trade.status !== 'completed' && trade.status !== 'cancelled' && trade.status !== 'expired' && (
            <div className="bg-surface shadow-card border border-border rounded-xl p-3 text-sm flex items-center justify-between">
              <span className="text-text-muted">
                {trade.confirmDeadlineAt ? 'Confirm by:' : trade.proofDeadlineAt ? 'Deadline:' : 'Expires:'}
              </span>
              <Countdown deadline={trade.confirmDeadlineAt ?? trade.proofDeadlineAt ?? trade.expiresAt} />
            </div>
          )}

          {/* Progress bar — steps only (mirrors the USDT room). All six steps fit
              on screen: compact circles + connectors that flex to fill, labels
              sized to wrap to at most two short lines on phones. */}
          <div className="bg-surface shadow-card border border-border rounded-xl p-3 sm:p-4">
            <div className="flex items-start">
              {STATUS_STEPS.map((s, i) => {
                const isLast = i === STATUS_STEPS.length - 1
                // Taker-first trades reorder the token/payment legs, so pick the
                // matching label set — otherwise each rung reads as the wrong step.
                const stepInfo = (trade.takerFirst ? STEP_INFO_TAKER_FIRST : STEP_INFO)[i]!
                return (
                  <div key={s} className={`flex items-start ${isLast ? 'flex-shrink-0' : 'flex-1'}`}>
                    <div className="flex flex-col items-center flex-shrink-0 w-11 sm:w-16">
                      <div className={`w-6 h-6 sm:w-7 sm:h-7 rounded-full text-[10px] sm:text-xs flex items-center justify-center font-bold flex-shrink-0 ${i < stepIndex ? 'bg-green-500 text-white' : i === stepIndex ? 'bg-primary text-white' : 'bg-surface-alt text-text-muted'}`}>
                        {i < stepIndex ? '✓' : i + 1}
                      </div>
                      <div className="mt-1.5 w-full text-center">
                        <p className={`text-[8.5px] sm:text-[10px] leading-tight ${i === stepIndex ? 'text-primary font-semibold' : i < stepIndex ? 'text-green-600 dark:text-green-400 font-medium' : 'text-text-muted'}`}>
                          {stepInfo.label}
                        </p>
                        {stepInfo.actor && (
                          <span className={`text-[8px] sm:text-[9px] mt-0.5 inline-block px-1 py-0.5 rounded font-medium ${i <= stepIndex ? (stepInfo.actor === 'Buyer' ? 'bg-blue-500/15 text-blue-600 dark:text-blue-400' : 'bg-orange-500/15 text-orange-600 dark:text-orange-400') : 'bg-surface-alt text-text-muted'}`}>
                            {stepInfo.actor}
                          </span>
                        )}
                      </div>
                    </div>
                    {!isLast && (
                      <div className={`h-0.5 flex-1 min-w-[3px] mt-3 mx-0.5 ${i < stepIndex ? 'bg-green-500' : 'bg-border'}`} />
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {error && <div className="bg-red-500/10 text-red-700 dark:text-red-300 border border-red-500/30 rounded-xl p-3 text-sm">{error}</div>}

          {trade.dispute && (
            <div
              ref={disputeSectionRef}
              className={`bg-red-500/10 border rounded-xl p-4 text-sm transition-shadow ${highlightDispute ? 'border-red-500/50 ring-2 ring-red-400 shadow-lg' : 'border-red-500/30'}`}
            >
              {/* A resolved dispute stays on the trade for the record, so the header
                  must not keep shouting "Open" after an admin has closed it. */}
              <p className="font-semibold text-red-800 dark:text-red-300 mb-1">
                {trade.dispute.status === 'resolved' ? 'Dispute closed' : 'Dispute Open'}: {trade.dispute.reason.replace(/_/g, ' ')}
              </p>
              <p className="text-red-700 dark:text-red-300">{trade.dispute.description}</p>
              {/* Admin evidence requests / dispute thread */}
              {trade.dispute.messages && trade.dispute.messages.length > 0 && (
                <div className="mt-3 space-y-2 border-t border-red-500/30 pt-3">
                  <p className="text-xs font-semibold text-red-800 dark:text-red-300 uppercase tracking-wide">Admin requests</p>
                  {trade.dispute.messages.map((m) => (
                    <div key={m.id} className="bg-surface border border-red-500/30 rounded-lg px-3 py-2">
                      <p className="text-red-900 dark:text-red-200">{m.message}</p>
                      <p className="text-[11px] text-red-500 mt-0.5">{new Date(m.createdAt).toLocaleString()}</p>
                    </div>
                  ))}
                  <p className="text-xs text-red-700 dark:text-red-300">Respond in the chat (Chat tab on mobile), or upload evidence below.</p>
                </div>
              )}
              {/* Dispute-resume: the steps below are still live. Say so — the old
                  banner read as a dead end, so neither side ever tried to finish. */}
              {partiesCanSettle && (
                <div className="mt-3 border-t border-red-500/30 pt-3 text-red-800 dark:text-red-200">
                  <p className="font-medium">This trade can still be completed.</p>
                  <p className="mt-1">
                    The steps below stay open. If the {isBuyer ? 'seller sends the tokens' : 'tokens are sent'} and{' '}
                    {isBuyer ? 'you' : 'the buyer'} confirm{isBuyer ? '' : 's'} receipt, the trade completes and this
                    dispute closes automatically — with no ruling against either side.
                  </p>
                  <p className="mt-1 text-xs text-red-700 dark:text-red-300">
                    Once an admin takes the case over, the steps lock until they rule.
                  </p>
                </div>
              )}
              {trade.dispute.resolution && <p className="mt-2 text-green-700 dark:text-green-300 font-medium">Resolution: {trade.dispute.resolution}</p>}
            </div>
          )}

          {['cancelled', 'expired'].includes(trade.status) && (
            <div className="bg-surface-alt border border-border rounded-xl p-4 text-sm text-center text-text-muted">
              This trade was <span className="font-medium text-text-primary">{trade.status}</span>.
            </div>
          )}

          {/* The step cards below are the single source of truth for both flows —
              the standalone "Step N of 6" action banner is gone; each action now
              lives inside its (flow-ordered) card. */}

          {/* BUYER steps */}
          {isBuyer && (
            <div className="flex flex-col gap-4">
              {/* Cards render in flow order via CSS `order`: fiat leg leads in
                  classic, crypto leg leads in taker-first. One card active at a time. */}
              <div style={{ order: legPos.fiat }}>
              <StepCard stepNum={legPos.fiat} title="Send Payment" state={legState(['send_fiat'])}
                summary={`${paymentMethodLabel} · ${payAmountLabel} · proof uploaded`}
                expanded={expandedSteps.has(legPos.fiat)} onToggle={() => toggleStep(legPos.fiat)}>
                <div className="bg-surface rounded-xl p-3 space-y-1.5 text-sm">
                  <Row label="Token price" value={`PKR ${Number(trade.pricePerUnit).toLocaleString()}`} />
                  {/* No "Payment method" row here — the full account details sit in
                      the Seller Receiving / Your Sending blocks right below. */}
                  <Row label="Token quantity" value={`${Number(trade.tokenAmount).toLocaleString(undefined, { maximumFractionDigits: 3 })} ${trade.token.symbol}`} />
                  <div className="border-t border-border pt-1.5 mt-1">
                    <Row label="Total payable" value={payAmountLabel} highlight />
                  </div>
                </div>
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="w-2 h-2 rounded-full bg-orange-400 flex-shrink-0" />
                    <p className="text-sm font-semibold text-text-primary">{isUsdtTrade ? 'Seller USDT Address' : 'Seller Receiving Account'}</p>
                    {isAccountLocked && <span className="text-xs bg-green-500/15 text-green-700 dark:text-green-300 px-2 py-0.5 rounded-full font-medium ml-auto">Locked</span>}
                  </div>
                  <p className="text-xs text-text-muted mb-2">Send {payAmountLabel} to {isUsdtTrade ? 'this USDT address' : 'this account'}.</p>
                  {renderSellerAccountBlock(true)}
                </div>
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="w-2 h-2 rounded-full bg-blue-400 flex-shrink-0" />
                    <p className="text-sm font-semibold text-text-primary">Your Sending Account</p>
                  </div>
                  <p className="text-xs text-text-muted mb-2">You will send payment from this account.</p>
                  {renderBuyerAccountBlock()}
                </div>
                {myTurn && isAction('send_fiat') && trade.settlementType === 'ON_CHAIN' && trade.escrowAddress && (
                  <div className="space-y-3">
                    <div className="bg-blue-500/10 border border-blue-500/30 rounded-xl p-4 space-y-2">
                      <p className="text-sm font-semibold text-blue-800 dark:text-blue-300">Send USDT to Escrow Address</p>
                      <div className="bg-surface rounded-lg border border-blue-500/30 p-2">
                        <p className="text-xs text-text-muted mb-1">Escrow Address ({trade.escrowCurrency ?? 'USDT_TRC20'})</p>
                        <p className="font-mono text-xs text-text-primary break-all select-all">{trade.escrowAddress}</p>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-blue-700 dark:text-blue-300">Amount required:</span>
                        <span className="font-bold text-blue-900 dark:text-blue-200">{trade.escrowAmount ? `PKR ${Number(trade.escrowAmount).toLocaleString()}` : `PKR ${Number(trade.fiatAmount).toLocaleString()}`}</span>
                      </div>
                      {trade.escrowConfirmedAt
                        ? <p className="text-xs text-green-700 dark:text-green-300 font-medium">Deposit confirmed — trade is progressing.</p>
                        : <p className="text-xs text-blue-600 dark:text-blue-400">Send exact amount. Deposit auto-confirms within 5 minutes.</p>
                      }
                    </div>
                    <div>
                      <p className="text-xs text-text-muted mb-1.5">Or upload deposit screenshot as proof:</p>
                      <input type="file" accept="image/*" onChange={(e) => setProofFile(e.target.files?.[0] ?? null)} className="w-full border border-border rounded-xl p-2 text-sm" />
                      <button onClick={handleUploadPaymentProof} disabled={actionLoading || !proofFile} className="w-full mt-2 bg-primary text-white py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60 hover:bg-primary/90">
                        {actionLoading ? 'Uploading…' : 'Upload Deposit Screenshot'}
                      </button>
                    </div>
                    <button onClick={() => doAction(() => ctmApi.cancelTrade(ref, { reason: 'Cancelled by buyer' }))} disabled={actionLoading} className="w-full border border-red-500/30 text-red-600 dark:text-red-400 py-2 rounded-xl text-sm hover:bg-red-500/10">Cancel Trade</button>
                  </div>
                )}
                {myTurn && isAction('send_fiat') && !(trade.settlementType === 'ON_CHAIN' && trade.escrowAddress) && (() => {
                  const needsAccountSelection = isMultiAccount && snap?.selectedIdx === undefined
                  if (needsAccountSelection) {
                    return (
                      <p className="text-xs text-amber-700 dark:text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
                        Select a payment account above before uploading payment proof.
                      </p>
                    )
                  }
                  return (
                    <div className="space-y-2">
                      {trade.lastProofRejectReason && (
                        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-xs text-red-700 dark:text-red-300">
                          <p className="font-semibold mb-0.5">The seller says your payment was not received</p>
                          <p>Reason: {trade.lastProofRejectReason}</p>
                          <p className="mt-1 opacity-80">Re-check and upload correct proof below. If you&apos;re sure it was sent, open a dispute instead.</p>
                        </div>
                      )}
                      <p className="text-xs text-text-muted">Upload screenshot of your PKR payment as proof.</p>
                      <input type="file" accept="image/*" onChange={(e) => setProofFile(e.target.files?.[0] ?? null)} className="w-full border border-border rounded-xl p-2 text-sm" />
                      <button onClick={handleUploadPaymentProof} disabled={actionLoading || !proofFile} className="w-full bg-primary text-white py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60 hover:bg-primary/90">
                        {actionLoading ? 'Uploading…' : 'Upload Payment Proof'}
                      </button>
                      {/* Cancel only in the classic flow — a taker-first buyer pays
                          AFTER receiving tokens, so cancelling then would be unsafe. */}
                      {!takerFirst && (
                        <button onClick={() => doAction(() => ctmApi.cancelTrade(ref, { reason: 'Cancelled by buyer' }))} disabled={actionLoading} className="w-full border border-red-500/30 text-red-600 dark:text-red-400 py-2 rounded-xl text-sm hover:bg-red-500/10">Cancel Trade</button>
                      )}
                    </div>
                  )
                })()}
                {paymentProofs.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-text-muted">Payment Proof</p>
                    {paymentProofs.map((p) => (
                      <div key={p.id} className="border border-border rounded-xl p-3">
                        <p className="text-xs text-text-muted mb-2">{new Date(p.createdAt).toLocaleString()}</p>
                        {p.fileUrl && (
                          isTrustedImageUrl(p.fileUrl)
                            ? <NextImage src={p.fileUrl} alt="payment proof" width={320} height={160} className="max-h-40 w-auto rounded-lg object-contain border border-border" referrerPolicy="no-referrer" unoptimized />
                            : <p className="text-xs text-warning bg-warning/10 rounded px-2 py-1">Proof image from untrusted source.</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </StepCard>
              </div>

              <div style={{ order: legPos.fiat_confirm }}>
              <StepCard stepNum={legPos.fiat_confirm} title="Awaiting Seller Confirmation" state={legState(['confirm_fiat'])}
                summary="Payment confirmed by seller"
                expanded={expandedSteps.has(legPos.fiat_confirm)} onToggle={() => toggleStep(legPos.fiat_confirm)}>
                {isAction('confirm_fiat') ? (
                  <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4 text-sm">
                    <p className="font-semibold text-yellow-800 dark:text-yellow-300 mb-1">Payment proof submitted</p>
                    <p className="text-yellow-700 dark:text-yellow-300">Waiting for seller to confirm they received your payment. This usually takes a few minutes.</p>
                  </div>
                ) : legState(['confirm_fiat']) === 'completed' ? (
                  <div className="bg-green-500/10 border border-green-500/30 rounded-xl p-3 text-sm text-green-700 dark:text-green-300">
                    ✓ Seller confirmed your payment.
                  </div>
                ) : null}
              </StepCard>
              </div>

              <div style={{ order: legPos.crypto }}>
              <StepCard stepNum={legPos.crypto} title="Receive Your Tokens" state={legState(['start_crypto', 'prove_crypto', 'confirm_crypto'])}
                summary={`${trade.tokenAmount} ${trade.token.symbol} received`}
                expanded={expandedSteps.has(legPos.crypto)} onToggle={() => toggleStep(legPos.crypto)}>
                <div className="bg-surface rounded-xl p-3 space-y-1.5 text-sm">
                  {(trade.buyerSettlementId || trade.settlementMethod) && (
                    <Row label="Your receiving address" value={trade.buyerSettlementId ?? trade.settlementMethod} mono breakAll copyable />
                  )}
                  <Row label="Amount" value={`${trade.tokenAmount} ${trade.token.symbol}`} />
                  <Row label="Method" value={settlementLabel(trade.settlementType)} />
                </div>
                {trade.settlementNote && (
                  <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 text-sm">
                    <p className="font-medium text-amber-800 dark:text-amber-300 mb-1">Transfer instructions:</p>
                    <p className="text-amber-700 dark:text-amber-300">{trade.settlementNote}</p>
                  </div>
                )}
                {!myTurn && isAction('start_crypto') && (
                  <div className="bg-blue-500/10 border border-blue-500/30 rounded-xl p-4 text-sm">
                    <p className="font-semibold text-blue-800 dark:text-blue-300 mb-1">Payment confirmed by seller</p>
                    <p className="text-blue-700 dark:text-blue-300">Seller is now sending your {trade.token.symbol} tokens. Please wait.</p>
                  </div>
                )}
                {!myTurn && isAction('prove_crypto') && (
                  <div className="bg-blue-500/10 border border-blue-500/30 rounded-xl p-4 text-sm">
                    <p className="font-semibold text-blue-800 dark:text-blue-300 mb-1">Seller is transferring tokens</p>
                    <p className="text-blue-700 dark:text-blue-300">Seller has started the transfer. They will upload proof shortly. Check your wallet.</p>
                  </div>
                )}
                {renderTokenProofsList()}
                {myTurn && isAction('confirm_crypto') && (
                  <div className="space-y-3">
                    <div className="bg-green-500/10 border border-green-500/30 rounded-xl p-4 space-y-3">
                      <p className="font-semibold text-green-800 dark:text-green-300">Seller has submitted transfer proof</p>
                      <p className="text-xs text-green-700 dark:text-green-300">Check your wallet / account for the incoming tokens, then confirm below.</p>
                      <div className="bg-surface rounded-lg border border-green-500/30 p-3 space-y-1.5 text-sm">
                        <p className="text-xs font-semibold text-text-muted mb-2">Delivery Summary</p>
                        <Row label="Token" value={`${trade.tokenAmount} ${trade.token.symbol}`} />
                        <Row label="Method" value={settlementLabel(trade.settlementType)} />
                        {(trade.buyerSettlementId || trade.settlementMethod) && (
                          <Row label="Your address" value={trade.buyerSettlementId ?? trade.settlementMethod} mono breakAll />
                        )}
                      </div>
                      {latestTokenProof && (
                        <div className="bg-surface rounded-lg border border-green-500/30 p-3 space-y-2">
                          <p className="text-xs font-semibold text-text-muted">Transfer Proof from Seller</p>
                          {latestTokenProof.txHash && (
                            <div className="space-y-1">
                              <p className="text-xs text-text-muted">{proofHashLabel(trade.settlementType)}</p>
                              <p className="text-xs font-mono text-text-primary break-all">{latestTokenProof.txHash}</p>
                              <TxVerificationBadge status={latestTokenProof.txVerificationStatus} />
                              {trade.token.explorerUrl && (
                                <a href={buildExplorerUrl(trade.token.explorerUrl, latestTokenProof.txHash)} target="_blank" rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 text-xs text-primary font-semibold hover:underline">
                                  Verify on {explorerNameFromUrl(trade.token.explorerUrl)} →
                                </a>
                              )}
                            </div>
                          )}
                          {latestTokenProof.fileUrl && (
                            isTrustedImageUrl(latestTokenProof.fileUrl)
                              ? <NextImage src={latestTokenProof.fileUrl} alt="token transfer proof" width={320} height={160} className="max-h-40 w-auto rounded-lg object-contain border border-border" referrerPolicy="no-referrer" unoptimized />
                              : <p className="text-xs text-warning bg-warning/10 rounded px-2 py-1">Proof image from untrusted source.</p>
                          )}
                        </div>
                      )}
                    </div>
                    <button onClick={() => doAction(() => ctmApi.confirmReceipt(ref))} disabled={actionLoading}
                      className="w-full bg-green-600 text-white py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60 hover:bg-green-700">
                      {actionLoading ? '…' : 'I Received the Tokens'}
                    </button>
                    <p className="text-xs text-center text-text-muted">Did not receive? Use the chat to contact the seller or open a dispute below.</p>
                  </div>
                )}
                {disputeBtn}
              </StepCard>
              </div>

              <div style={{ order: legPos.complete }}>
              <StepCard stepNum={legPos.complete} title="Trade Completed"
                state={trade.status === 'completed' ? 'completed' : 'future'}
                summary={completedSummary}
                expanded={!step4Collapsed} onToggle={() => setStep4Collapsed((v) => !v)}>
                {trade.status === 'completed' ? (
                  <div className="space-y-4">
                    <div className="bg-green-500/10 border border-green-500/30 rounded-xl p-3 text-sm text-green-700 dark:text-green-300">
                      ✓ Trade complete. Rating is optional — leave feedback below if you like.
                    </div>
                    {ratingPanel(completedCounterparty)}
                  </div>
                ) : (
                  <p className="text-sm text-text-muted">This trade isn&apos;t complete yet.</p>
                )}
              </StepCard>
              </div>
            </div>
          )}

          {/* SELLER steps */}
          {isSeller && (
            <div className="flex flex-col gap-4">
              <div style={{ order: legPos.fiat }}>
              <StepCard stepNum={legPos.fiat} title="Awaiting Buyer Payment" state={legState(['send_fiat'])}
                summary="Buyer submitted payment proof"
                expanded={expandedSteps.has(legPos.fiat)} onToggle={() => toggleStep(legPos.fiat)}>
                {/* Order summary so the seller can see the price, token quantity and
                    the PKR they will receive (mirrors the buyer's Send-Payment card). */}
                <div className="bg-surface rounded-xl p-3 space-y-1.5 text-sm">
                  <Row label="Token price" value={`PKR ${Number(trade.pricePerUnit).toLocaleString()}`} />
                  <Row label="Token quantity" value={`${Number(trade.tokenAmount).toLocaleString(undefined, { maximumFractionDigits: 3 })} ${trade.token.symbol}`} />
                  <div className="border-t border-border pt-1.5 mt-1">
                    <Row label="Total to receive" value={payAmountLabel} highlight />
                  </div>
                </div>
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="w-2 h-2 rounded-full bg-orange-400 flex-shrink-0" />
                    <p className="text-sm font-semibold text-text-primary">{isUsdtTrade ? 'Your USDT Receiving Address' : 'Your Receiving Account'}</p>
                    {isAccountLocked && <span className="text-xs bg-green-500/15 text-green-700 dark:text-green-300 px-2 py-0.5 rounded-full font-medium ml-auto">Locked</span>}
                  </div>
                  <p className="text-xs text-text-muted mb-2">You will receive {payAmountLabel} from the buyer.</p>
                  {renderSellerAccountBlock(false)}
                </div>
                {/* Buyer's sending account — shown for both fiat and USDT payments
                    (parity with the buyer's Send-Payment card). renderBuyerAccountBlock
                    surfaces the buyer's own USDT rail for USDT trades, or a plain
                    instruction when no snapshot exists, so it is always safe to show. */}
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="w-2 h-2 rounded-full bg-blue-400 flex-shrink-0" />
                    <p className="text-sm font-semibold text-text-primary">Buyer&apos;s Sending Account</p>
                  </div>
                  <p className="text-xs text-text-muted mb-2">Buyer will send {isUsdtTrade ? 'USDT' : 'PKR'} from this account. Watch for incoming payment here.</p>
                  {renderBuyerAccountBlock(false)}
                </div>
                {!myTurn && isAction('send_fiat') && (
                  <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4 text-sm">
                    <p className="font-semibold text-yellow-800 dark:text-yellow-300 mb-1">Waiting for buyer payment</p>
                    <p className="text-yellow-700 dark:text-yellow-300">The buyer is sending {isUsdtTrade ? 'USDT' : 'PKR'} to your {isUsdtTrade ? 'address' : 'account'}. You&apos;ll be notified when payment proof is uploaded.</p>
                  </div>
                )}
                {/* Seller may cancel while nothing of value has moved (classic flow,
                    before the buyer uploads proof). Once proof is up the seller can
                    no longer cancel — recourse is "Payment not received" or a dispute. */}
                {!takerFirst && isAction('send_fiat') && rung === 'awaiting_payment' && (
                  <button onClick={() => doAction(() => ctmApi.cancelTrade(ref, { reason: 'Cancelled by seller' }))} disabled={actionLoading} className="w-full mt-2 border border-red-500/30 text-red-600 dark:text-red-400 py-2 rounded-xl text-sm hover:bg-red-500/10">Cancel Trade</button>
                )}
              </StepCard>
              </div>

              <div style={{ order: legPos.fiat_confirm }}>
              <StepCard stepNum={legPos.fiat_confirm} title="Confirm Payment" state={legState(['confirm_fiat'])}
                summary={`${payAmountLabel} confirmed`}
                expanded={expandedSteps.has(legPos.fiat_confirm)} onToggle={() => toggleStep(legPos.fiat_confirm)}>
                {isAction('confirm_fiat') ? (
                  <div className="space-y-3">
                    {/* Amount summary so the seller knows exactly how much they are
                        confirming receipt of (and for how many tokens) before tapping. */}
                    <div className="bg-surface rounded-xl p-3 space-y-1.5 text-sm">
                      <Row label="Token price" value={`PKR ${Number(trade.pricePerUnit).toLocaleString()}`} />
                      <Row label="Token quantity" value={`${Number(trade.tokenAmount).toLocaleString(undefined, { maximumFractionDigits: 3 })} ${trade.token.symbol}`} />
                      <div className="border-t border-border pt-1.5 mt-1">
                        <Row label="Amount to confirm" value={payAmountLabel} />
                      </div>
                    </div>
                    <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 text-sm text-amber-800 dark:text-amber-300">
                      Only confirm after <span className="font-semibold">{payAmountLabel}</span> has actually arrived {isUsdtTrade ? 'at your USDT address' : 'in your account'}. Once confirmed, you must send the tokens.
                    </div>
                    <div className="bg-surface rounded-xl p-3 text-sm">
                      <p className="text-text-muted text-xs mb-2">Buyer has uploaded payment proof. Review then confirm.</p>
                      {paymentProofs[0]?.fileUrl && (
                        isTrustedImageUrl(paymentProofs[0].fileUrl)
                          ? <NextImage src={paymentProofs[0].fileUrl} alt="payment proof" width={320} height={160} className="max-h-40 w-auto rounded-lg object-contain border border-border mb-2" referrerPolicy="no-referrer" unoptimized />
                          : <p className="text-xs text-warning bg-warning/10 rounded px-2 py-1 mb-2">Proof image from untrusted source.</p>
                      )}
                    </div>
                    {myTurn && (
                      <button onClick={() => doAction(() => ctmApi.confirmPayment(ref))} disabled={actionLoading}
                        className="w-full bg-primary text-white py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60">
                        {actionLoading ? '…' : 'Confirm Payment Received'}
                      </button>
                    )}
                    {myTurn && !takerFirst && !rejectOpen && (
                      <button onClick={() => { setError(''); setRejectOpen(true) }} disabled={actionLoading}
                        className="w-full mt-2 text-xs text-red-600 dark:text-red-400 border border-red-500/30 rounded-xl py-2 hover:bg-red-500/10">
                        Payment not received
                      </button>
                    )}
                    {myTurn && !takerFirst && rejectOpen && (
                      <div className="mt-2 border border-red-500/30 rounded-xl p-3 space-y-2 bg-red-500/5">
                        <p className="text-xs text-text-secondary">
                          Use this only if the payment genuinely has not arrived. The trade goes back to the unpaid step
                          and the buyer re-uploads correct proof. After the limit, the next rejection opens a dispute.
                        </p>
                        <select value={rejectReason} onChange={(e) => setRejectReason(e.target.value)}
                          className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-surface">
                          <option value="not_received">No payment has arrived</option>
                          <option value="wrong_amount">Amount received doesn&apos;t match</option>
                          <option value="wrong_account">Paid to the wrong account</option>
                          <option value="fake_screenshot">Screenshot looks fake / edited</option>
                          <option value="other">Other</option>
                        </select>
                        <textarea rows={3} value={rejectDetail} onChange={(e) => setRejectDetail(e.target.value)}
                          placeholder="Explain for the buyer (min 10 characters) — e.g. nothing has landed, please check the account number."
                          className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-surface resize-none" />
                        <div className="flex gap-2">
                          <button onClick={() => { setRejectOpen(false); setRejectDetail('') }} disabled={actionLoading}
                            className="flex-1 border border-border rounded-lg py-2 text-sm">Back</button>
                          <button onClick={handleRejectPayment} disabled={actionLoading || rejectDetail.trim().length < 10}
                            className="flex-1 bg-red-600 text-white rounded-lg py-2 text-sm font-semibold disabled:opacity-60">Report not received</button>
                        </div>
                      </div>
                    )}
                    {typeof trade.proofRejectionCount === 'number' && trade.proofRejectionCount > 0 && (
                      <p className="text-[11px] text-text-muted mt-1">Reported {trade.proofRejectionCount} time(s). After the limit, the next report opens a dispute.</p>
                    )}
                  </div>
                ) : (
                  <div className="bg-green-500/10 border border-green-500/30 rounded-xl p-3 text-sm text-green-700 dark:text-green-300">
                    ✓ You confirmed receiving {payAmountLabel}.
                  </div>
                )}
              </StepCard>
              </div>

              <div style={{ order: legPos.crypto }}>
              <StepCard stepNum={legPos.crypto} title="Send Tokens to Buyer" state={legState(['start_crypto', 'prove_crypto', 'confirm_crypto'])}
                summary="Transfer proof submitted"
                expanded={expandedSteps.has(legPos.crypto)} onToggle={() => toggleStep(legPos.crypto)}>
                <div className="bg-surface rounded-xl p-3 space-y-1.5 text-sm">
                  <p className="text-xs font-medium text-text-muted mb-1">Send tokens to buyer</p>
                  {(trade.buyerSettlementId || trade.settlementMethod) && (
                    <Row label="Buyer address" value={trade.buyerSettlementId ?? trade.settlementMethod} mono breakAll copyable />
                  )}
                  <Row label="Amount" value={`${trade.tokenAmount} ${trade.token.symbol}`} />
                </div>
                {trade.settlementNote && (
                  <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 text-sm">
                    <p className="font-medium text-amber-800 dark:text-amber-300 mb-1">Transfer instructions:</p>
                    <p className="text-amber-700 dark:text-amber-300">{trade.settlementNote}</p>
                  </div>
                )}
                {myTurn && isAction('start_crypto') && (
                  <button onClick={() => doAction(() => ctmApi.markTransferring(ref))} disabled={actionLoading}
                    className="w-full bg-primary text-white py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60">
                    {actionLoading ? '…' : 'I Have Started Sending Tokens'}
                  </button>
                )}
                {myTurn && isAction('prove_crypto') && (
                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs font-medium text-text-primary mb-1.5">
                        {proofHashLabel(trade.settlementType)}
                        {isHashRequired(trade.settlementType) && <span className="text-primary font-semibold ml-1">(required)</span>}
                        {!isHashRequired(trade.settlementType) && <span className="text-text-muted font-normal ml-1">(optional)</span>}
                      </label>
                      <input type="text" value={txHash} onChange={(e) => setTxHash(e.target.value)}
                        placeholder={proofHashPlaceholder(trade.settlementType)}
                        className="w-full border border-border rounded-xl px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30" />
                      {(trade.settlementType === 'ON_CHAIN' || trade.token.explorerUrl) && (
                        <p className="text-xs text-text-muted mt-1">Paste the blockchain transaction hash so the buyer can verify it on the explorer.</p>
                      )}
                      {trade.token.explorerUrl && txHash.trim() && trade.settlementType !== 'MANUAL' && (
                        <a href={buildExplorerUrl(trade.token.explorerUrl, txHash.trim())} target="_blank" rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline mt-1">
                          Check this hash on {explorerNameFromUrl(trade.token.explorerUrl)} ↗
                        </a>
                      )}
                      {trade.settlementType === 'MANUAL' && (
                        <p className="text-xs text-text-muted mt-1">Enter the transfer reference number from your payment app or bank.</p>
                      )}
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-text-primary mb-1.5">
                        Screenshot
                        {isScreenshotRequired(trade.settlementType)
                          ? <span className="text-primary font-semibold ml-1">(required)</span>
                          : <span className="text-text-muted font-normal ml-1">(optional)</span>}
                      </label>
                      <input type="file" accept="image/*" onChange={(e) => setProofFile(e.target.files?.[0] ?? null)} className="w-full border border-border rounded-xl p-2 text-sm" />
                      {isScreenshotRequired(trade.settlementType) && (
                        <p className="text-xs text-text-muted mt-1">Upload a screenshot of the transfer confirmation. The reference / ID above is optional.</p>
                      )}
                    </div>
                    <button onClick={handleUploadTokenProof}
                      disabled={actionLoading || (
                        isHashRequired(trade.settlementType) ? !txHash.trim()
                        : isScreenshotRequired(trade.settlementType) ? !proofFile
                        : (!txHash.trim() && !proofFile)
                      )}
                      className="w-full bg-primary text-white py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60">
                      {actionLoading ? 'Uploading…' : 'Submit Transfer Proof'}
                    </button>
                  </div>
                )}
                {renderTokenProofsList()}
                {/* Seller's leg isn't done until the buyer confirms receipt, so this
                    waiting note lives in the Send-Tokens card (which stays active). */}
                {!myTurn && isAction('confirm_crypto') && (
                  <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4 text-sm">
                    <p className="font-semibold text-yellow-800 dark:text-yellow-300 mb-1">Waiting for buyer confirmation</p>
                    <p className="text-yellow-700 dark:text-yellow-300">Transfer proof submitted. Buyer has 30 minutes to confirm receipt. If they don&apos;t respond, the trade escalates to admin.</p>
                  </div>
                )}
                {disputeBtn}
              </StepCard>
              </div>

              <div style={{ order: legPos.complete }}>
              <StepCard stepNum={legPos.complete} title="Trade Completed"
                state={trade.status === 'completed' ? 'completed' : 'future'}
                summary={completedSummary}
                expanded={!step4Collapsed} onToggle={() => setStep4Collapsed((v) => !v)}>
                {trade.status === 'completed' && (
                  <div className="space-y-4">
                    <div className="bg-green-500/10 border border-green-500/30 rounded-xl p-3 text-sm text-green-700 dark:text-green-300">
                      ✓ Trade complete. Rating is optional — leave feedback below if you like.
                    </div>
                    {ratingPanel(completedCounterparty)}
                  </div>
                )}
              </StepCard>
              </div>
            </div>
          )}

          {/* Admin flat view */}
          {!isBuyer && !isSeller && (
            <>
              <div className="bg-surface shadow-card border border-border rounded-xl p-5">
                <h2 className="font-semibold text-text-primary mb-3">Order Summary</h2>
                <div className="bg-surface rounded-xl p-3 space-y-1.5 text-sm">
                  <Row label="Token price" value={`PKR ${Number(trade.pricePerUnit).toLocaleString()}`} />
                  <Row label="Token quantity" value={`${Number(trade.tokenAmount).toLocaleString(undefined, { maximumFractionDigits: 3 })} ${trade.token.symbol}`} />
                  <Row label="Payment method" value={paymentMethodLabel} />
                  <div className="border-t border-border pt-1.5 mt-1">
                    <Row label="Total" value={payAmountLabel} highlight />
                  </div>
                </div>
              </div>
              <div className="bg-surface shadow-card border border-border rounded-xl p-5 space-y-4">
                <h2 className="font-semibold text-text-primary">Payment Method</h2>
                <div>
                  <p className="text-xs font-medium text-text-muted mb-2">Seller Receiving</p>
                  {renderSellerAccountBlock(false)}
                </div>
                <div className="border-t border-border pt-3">
                  <p className="text-xs font-medium text-text-muted mb-2">Buyer Sending</p>
                  {renderBuyerAccountBlock(false)}
                </div>
              </div>
              <div className="bg-surface shadow-card border border-border rounded-xl p-5">
                <h2 className="font-semibold text-text-primary mb-3">Token Delivery</h2>
                <div className="bg-surface rounded-xl p-3 space-y-1.5 text-sm mb-3">
                  {(trade.buyerSettlementId || trade.settlementMethod) && (
                    <Row label="Buyer address" value={trade.buyerSettlementId ?? trade.settlementMethod} mono breakAll copyable />
                  )}
                  <Row label="Amount" value={`${trade.tokenAmount} ${trade.token.symbol}`} />
                </div>
                {renderTokenProofsList()}
              </div>
            </>
          )}

        </div>

        {/* Right: Chat — its own mobile tab (hidden on the Trade tab), side column on desktop. */}
        <div className={`lg:col-span-2 flex-col bg-surface shadow-card border border-border rounded-xl overflow-hidden max-h-[70vh] min-h-[55vh] lg:min-h-0 ${mobileTab === 'trade' ? 'hidden lg:flex' : 'flex'}`}>
          <div className="p-4 border-b border-border font-semibold text-text-primary text-sm">
            Chat — {trade.buyer.fullName || trade.buyer.username} & {trade.seller.fullName || trade.seller.username}
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.map((m) => {
              const isMe = m.senderId === user?.id
              // Resolve the human name behind this senderId so bubbles side + label
              // by the REAL trader (mirrors the USDT trade chat): my messages right,
              // the other person's left; system notices side by the actor who
              // triggered the step, or fall back to "RupChain".
              const senderName = isMe
                ? 'You'
                : m.senderId === trade.buyer.id
                  ? (trade.buyer.fullName || trade.buyer.username || 'Buyer')
                  : m.senderId === trade.seller.id
                    ? (trade.seller.fullName || trade.seller.username || 'Seller')
                    : 'RupChain'
              const msgTime = new Date(m.createdAt).toLocaleTimeString('en-PK', { timeZone: 'Asia/Karachi', hour: '2-digit', minute: '2-digit' })
              if (m.isSystem) {
                return (
                  <div key={m.id} className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[80%] px-3 py-2 rounded-2xl bg-surface border border-border shadow-sm ${isMe ? 'rounded-br-sm' : 'rounded-bl-sm'}`}>
                      <p className="flex items-center gap-1 text-[11px] font-semibold text-text-secondary mb-1">
                        <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
                        {senderName}
                      </p>
                      <p className="text-sm text-text-primary leading-relaxed break-words whitespace-pre-wrap">{m.message}</p>
                      <p className="text-[10px] text-text-muted/60 mt-0.5">{msgTime}</p>
                    </div>
                  </div>
                )
              }
              return (
                <div key={m.id} className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[75%] flex flex-col gap-0.5 ${isMe ? 'items-end' : 'items-start'}`}>
                    <span className="text-[11px] font-semibold text-text-secondary px-1">{senderName}</span>
                    <div className={`px-3 py-2 rounded-2xl text-sm leading-relaxed break-words whitespace-pre-wrap shadow-sm ${isMe ? 'bg-primary text-white rounded-br-sm' : 'bg-surface border border-border text-text-primary rounded-bl-sm'}`}>
                      {m.message}
                    </div>
                    <span className="text-[10px] text-text-muted px-1">{msgTime}</span>
                  </div>
                </div>
              )
            })}
            <div ref={chatEndRef} />
          </div>
          <div className="p-3 border-t border-border flex gap-2">
            <input type="text" value={msgText} onChange={(e) => setMsgText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage() } }}
              placeholder="Type a message…" className="flex-1 min-w-0 border border-border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
            <button onClick={handleSendMessage} disabled={sendingMsg || !msgText.trim()} className="flex-shrink-0 bg-primary text-white px-4 py-2 rounded-xl text-sm font-semibold disabled:opacity-60">Send</button>
          </div>
        </div>
      </div>

      {disputeOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-4">
          <div className="bg-surface rounded-xl w-full max-w-md p-6 space-y-4">
            <h3 className="font-bold text-lg text-text-primary">Open Dispute</h3>
            <p className="text-sm text-text-muted">Try messaging the {isBuyer ? 'seller' : 'buyer'} first using the chat. If unresolved, open a dispute and an admin will review.</p>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">Reason</label>
              <select value={disputeReason} onChange={(e) => setDisputeReason(e.target.value)} className="w-full border border-border rounded-xl px-3 py-2.5 text-sm bg-surface focus:outline-none">
                <option value="">Select reason</option>
                {DISPUTE_REASONS.map((r) => <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">Description <span className="text-text-muted font-normal">(min 10 characters)</span></label>
              <textarea rows={4} value={disputeDesc} onChange={(e) => setDisputeDesc(e.target.value)}
                className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none resize-none"
                placeholder="Describe the issue in detail. Include any evidence from the chat." />
            </div>
            <div className="flex gap-3">
              <button onClick={() => setDisputeOpen(false)} className="flex-1 border border-border py-2.5 rounded-xl text-sm font-medium">Cancel</button>
              <button onClick={handleOpenDispute} disabled={actionLoading || !disputeReason || disputeDesc.trim().length < 10} className="flex-1 bg-red-600 text-white py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60">Open Dispute</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function CopyableText({ value, mono }: { value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 2000) } catch { /* ignore */ }
  }
  return (
    <div className="flex items-start gap-2">
      <p className={`text-xs text-text-primary break-all flex-1 ${mono ? 'font-mono' : ''}`}>{value}</p>
      <button onClick={handleCopy} title="Copy" className="flex-shrink-0 p-0.5 rounded text-text-muted hover:text-primary hover:bg-primary/10 transition-colors mt-0.5">
        {copied ? (
          <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5 text-green-600 dark:text-green-400" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" /></svg>
        ) : (
          <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor"><path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z" /><path d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z" /></svg>
        )}
      </button>
    </div>
  )
}

// Dispute cooldown gate — shows a live countdown until disputes unlock, then the
// "Open Dispute" button. Mirrors the USDT marketplace DisputeUnlockGate.
function DisputeUnlockGate({ unlockAt, onOpen }: { unlockAt: number | null; onOpen: () => void }) {
  const [now, setNow] = useState(() => Date.now())
  const locked = unlockAt !== null && now < unlockAt
  useEffect(() => {
    if (!locked) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [locked])

  if (!locked) {
    return (
      <button onClick={onOpen} className="w-full border border-red-500/30 text-red-600 dark:text-red-400 py-2 rounded-xl text-sm hover:bg-red-500/10 transition-colors">
        Open Dispute
      </button>
    )
  }

  const diff = Math.max(0, (unlockAt as number) - now)
  const m = Math.floor(diff / 60_000)
  const s = Math.floor((diff % 60_000) / 1_000)
  const formatted = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`

  return (
    <div className="rounded-xl border border-border bg-surface px-3 py-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-text-secondary">Dispute available in</span>
        <span className="font-mono font-semibold text-sm text-text-primary">{formatted}</span>
      </div>
      <p className="text-xs text-text-muted leading-snug">
        Give your counterparty a moment to send or confirm. If the issue isn&apos;t resolved, you&apos;ll be able to open a dispute once the timer ends.
      </p>
      <button disabled className="w-full border border-red-500/20 text-red-400/60 py-2 rounded-xl text-sm cursor-not-allowed">
        Open Dispute
      </button>
    </div>
  )
}

function Row({ label, value, mono, breakAll, copyable, highlight }: { label: string; value: string; mono?: boolean; breakAll?: boolean; copyable?: boolean; highlight?: boolean }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 2000) } catch { /* ignore */ }
  }
  const copyBtn = copyable ? (
    <button onClick={handleCopy} title="Copy" className="flex-shrink-0 p-0.5 rounded text-text-muted hover:text-primary hover:bg-primary/10 transition-colors">
      {copied ? (
        <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5 text-green-600 dark:text-green-400" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
        </svg>
      ) : (
        <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
          <path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z" />
          <path d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z" />
        </svg>
      )}
    </button>
  ) : null

  // Long addresses / hashes (breakAll) stack: the label sits on its own line and
  // the value fills the FULL width in a bordered box, so a 0x… address wraps to
  // one or two lines instead of a narrow vertical column pinned to the right edge.
  if (breakAll) {
    return (
      <div className="space-y-1">
        <span className="text-text-muted">{label}</span>
        <div className="flex items-center gap-2 bg-surface-alt/50 border border-border rounded-lg px-2.5 py-1.5">
          <span className={`text-text-primary font-medium break-all min-w-0 flex-1 ${mono ? 'font-mono text-xs' : ''}`}>{value}</span>
          {copyBtn}
        </div>
      </div>
    )
  }

  // Short values stay inline; the copy button sits in FRONT of the value (to its
  // left) so a phone number reads "[copy] 0309…" rather than the copy trailing off
  // the right edge.
  return (
    <div className={`flex items-center justify-between gap-4 ${highlight ? 'bg-primary/5 border border-primary/20 rounded-lg px-2.5 py-1.5' : ''}`}>
      <span className={`flex-shrink-0 ${highlight ? 'text-text-primary font-semibold' : 'text-text-muted'}`}>{label}</span>
      <div className="flex items-center gap-1.5 min-w-0 justify-end">
        {copyBtn}
        <span className={`text-right ${highlight ? 'text-primary font-bold text-base' : 'text-text-primary font-medium'} ${mono ? 'font-mono' : ''}`}>{value}</span>
      </div>
    </div>
  )
}

// useSearchParams requires a Suspense boundary in the Next.js App Router.
export default function CtmTradeRoomPage({ params }: { params: Promise<{ ref: string }> }) {
  return (
    <Suspense fallback={<div className="max-w-5xl mx-auto px-4 py-12 animate-pulse"><div className="bg-surface rounded-xl h-96 border border-border" /></div>}>
      <CtmTradeRoomPageInner params={params} />
    </Suspense>
  )
}
