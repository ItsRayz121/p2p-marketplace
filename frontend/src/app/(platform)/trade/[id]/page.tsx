'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams } from 'next/navigation'
import NextImage from 'next/image'
import { tradesApi } from '@/lib/api'
import type { Trade } from '@/lib/api'
import { analytics } from '@/lib/analytics'
import { hapticNotify } from '@/lib/telegram'
import { useSSE } from '@/hooks/useSSE'
import { useAuth } from '@/hooks/useAuth'
import { usePolling } from '@/hooks/usePolling'
import { useFileUpload } from '@/hooks/useFileUpload'
import { useOfflineDetection } from '@/hooks/useOfflineDetection'
import { CountdownTimer } from '@/components/ui/CountdownTimer'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { ConfirmModal } from '@/components/ui/ConfirmModal'
import { Modal } from '@/components/ui/Modal'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { BadgeChip } from '@/components/ui/TraderLevelCard'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { CopyButton } from '@/components/ui/CopyButton'
import type { TraderBadge } from '@/components/ui/TraderLevelCard'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { PK_MOBILE_METHODS } from '@/lib/pkPaymentMethods'
import { getTradeStatus } from '@/lib/tradeStatus'
import { currentStep as flowCurrentStep, flowOrder, disputeLock } from '@/lib/settlementFlow'
import type { FlowAction, FlowActor } from '@/lib/settlementFlow'
import { promptPushOptIn } from '@/lib/pushPrompt'
import { isTrustedImageUrl } from '@/lib/utils'
import { explorerTxUrl, explorerName } from '@/lib/explorers'
import { supportMailto } from '@/lib/contact'
import {
  FileText,
  Upload,
  CheckCheck,
  ArrowUpRight,
  CheckCircle2,
  ShieldCheck,
  WifiOff,
  BadgeCheck,
  Clock,
} from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChatMessage {
  id: string
  senderId: string
  message: string
  imageUrl?: string
  isSystem?: boolean
  createdAt: string
  /** Local-only delivery state for optimistic sends. Absent on server messages. */
  sendStatus?: 'sending' | 'failed'
}

// Cooldown before "Open Dispute" unlocks, measured from when the buyer uploaded
// payment proof. Keep in sync with DISPUTE_DELAY_MINUTES in trade.service.ts.
const DISPUTE_DELAY_MINUTES = 10

// Window during which a participant may rate a completed trade, measured from
// completion (releasedAt). Keep in sync with RATING_WINDOW_MINUTES in trade.service.ts.
const RATING_WINDOW_MINUTES = 15


interface SellerPaymentAccount {
  type: string
  label: string
  accountName: string
  mobileNumber?: string
  bankName?: string
  ibanNumber?: string
  accountNumber?: string
}

interface ExtendedTrade extends Trade {
  paymentProofUrl?: string
  txHash?: string
  buyerRated?: boolean
  sellerRated?: boolean
  buyerDeliveryMethod?: string
  buyerDeliveryAddress?: string
  ratedByMe?: boolean
  txVerificationStatus?: string
  sellerDeliveryProofUrl?: string
  /** Clean display label for the payment method (resolves stored PaymentMethod id). */
  paymentMethodLabel?: string
  /** Seller's receiving account, resolved server-side for trade participants. */
  sellerPaymentAccount?: SellerPaymentAccount | null
  /** Buy ads only: the buyer/lister's pay-FROM account(s). Single or { accounts: [...] }. */
  buyerPaymentSnapshot?: (SellerPaymentAccount & { accounts?: SellerPaymentAccount[] }) | null
  /** Combined completed-trade count between this buyer & seller (USDT + CTM). */
  streakCount?: number
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TIMELINE_STEPS = [
  { key: 'payment_pending',   label: 'Order Created',     Icon: FileText      },
  { key: 'payment_uploaded',  label: 'Proof Uploaded',    Icon: Upload        },
  { key: 'payment_confirmed', label: 'Payment Confirmed', Icon: CheckCheck    },
  { key: 'crypto_sent',       label: 'Crypto Sent',       Icon: ArrowUpRight  },
  { key: 'crypto_released',   label: 'Trade Complete',    Icon: CheckCircle2  },
]

// Taker-first reorders the legs (crypto is sent & confirmed BEFORE the PKR is
// paid), so the same five ladder rungs carry different meaning — relabel them so
// the strip never reads e.g. "Payment Confirmed" while crypto is being confirmed.
// Keys/icons stay positional; only the human labels change. Mirrors the CTM strip.
const TIMELINE_LABELS_TAKER_FIRST: Record<string, string> = {
  payment_pending:   'Order Created',
  payment_uploaded:  'Crypto Sent',
  payment_confirmed: 'Crypto Received',
  crypto_sent:       'Payment Sent',
  crypto_released:   'Trade Complete',
}

function stepIndex(status: string): number {
  if (status === 'payment_pending')   return 0
  if (status === 'payment_uploaded')  return 1
  if (status === 'payment_confirmed') return 2
  if (status === 'crypto_sent')       return 3
  if (status === 'crypto_released')   return 4
  return 0
}

// ─── Rating Tags & Inline Rating Form ─────────────────────────────────────────

const RATING_TAGS = ['Fast Payment', 'Good Communication', 'Smooth Trade', 'Trustworthy', 'Patient']

function InlineRatingForm({ onSubmit, actionError, disabled, disabledNote }: {
  onSubmit: (rating: number, comment: string, tags: string[]) => Promise<void>
  actionError: string | null
  disabled?: boolean
  disabledNote?: string
}) {
  const [rating, setRating] = useState(5)
  const [comment, setComment] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)

  const toggleTag = (tag: string) => {
    setTags((prev) => prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag])
  }

  const handleSubmit = async () => {
    setSubmitting(true)
    try {
      await onSubmit(rating, comment, tags)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm text-text-muted mb-2">How was your experience?</p>
        <div className="flex gap-2" role="group" aria-label="Star rating">
          {[1, 2, 3, 4, 5].map((star) => (
            <button
              key={star}
              onClick={() => setRating(star)}
              aria-label={`Rate ${star} out of 5 stars`}
              aria-pressed={star <= rating}
              className={`text-2xl transition-transform hover:scale-110 ${star <= rating ? 'text-gold' : 'text-text-muted/30'}`}
            >
              ★
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {RATING_TAGS.map((tag) => (
          <button
            key={tag}
            onClick={() => toggleTag(tag)}
            className={`px-3 py-1.5 text-xs rounded-full border transition-colors ${
              tags.includes(tag)
                ? 'bg-primary text-white border-primary'
                : 'border-border text-text-secondary hover:border-primary/40'
            }`}
          >
            {tag}
          </button>
        ))}
      </div>
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Add a comment (optional)"
        rows={3}
        className="w-full px-3 py-2 text-sm border border-border rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-primary"
      />
      {actionError && (
        <p className="text-sm text-danger bg-danger/10 rounded-lg px-3 py-2">{actionError}</p>
      )}
      {disabled && disabledNote && (
        <p className="text-xs text-text-muted bg-surface-alt/60 rounded-lg px-3 py-2">{disabledNote}</p>
      )}
      <Button fullWidth loading={submitting} onClick={handleSubmit} disabled={disabled}>Submit Rating</Button>
    </div>
  )
}

// ─── Completed Trade Card ──────────────────────────────────────────────────────

function CompletedTradeCard({ trade, isUserBuyer, counterparty, ratedAlready, onRatingSubmit, actionError }: {
  trade: ExtendedTrade
  isUserBuyer: boolean
  counterparty: string
  ratedAlready: boolean
  onRatingSubmit: (rating: number, comment: string, tags: string[]) => Promise<void>
  actionError: string | null
}) {
  // Rating window: opens at completion (releasedAt) and lasts RATING_WINDOW_MINUTES.
  const anchor = trade.releasedAt ?? trade.updatedAt
  const windowEndsAt = anchor ? new Date(anchor).getTime() + RATING_WINDOW_MINUTES * 60_000 : 0

  // Live clock so the countdown ticks and the form auto-closes when time runs out.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const msLeft = windowEndsAt - now
  const ratingOpen = !ratedAlready && msLeft > 0
  const windowClosed = !ratedAlready && msLeft <= 0

  // Rating is optional, so this card is collapsed by default — the trade is already
  // done. The header still surfaces the countdown chip so the user knows a rating
  // window is open; they tap to expand and leave feedback if they want to.
  const [expanded, setExpanded] = useState(false)

  const mm = Math.max(0, Math.floor(msLeft / 60_000))
  const ss = Math.max(0, Math.floor((msLeft % 60_000) / 1000))
  const countdown = `${mm}:${ss.toString().padStart(2, '0')}`

  return (
    <div className="bg-success/5 border border-success/20 rounded-xl mb-6 overflow-hidden">
      {/* Collapsible header */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-3 p-4 text-left hover:bg-success/[0.07] transition-colors"
      >
        <div className="w-9 h-9 rounded-full bg-success/10 flex items-center justify-center flex-shrink-0">
          <CheckCircle2 size={20} className="text-success" aria-hidden />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-bold text-success">Rate the Trade</h2>
            <span className="text-[10px] font-medium text-text-muted bg-surface-alt/70 rounded-full px-1.5 py-0.5 flex-shrink-0">Optional</span>
          </div>
          {!expanded && (
            <p className="text-xs text-text-muted truncate">
              {parseFloat(trade.amount).toFixed(2)} {trade.coin} · PKR {Number(trade.fiatAmount ?? trade.totalPkr).toLocaleString()} · {counterparty}
            </p>
          )}
        </div>
        {/* Small rating-window indicator (no big banner) */}
        {ratingOpen && (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-gold bg-gold/10 rounded-full px-2 py-0.5 flex-shrink-0" title={`${countdown} left to rate this trade`}>
            <Clock size={11} aria-hidden /> {countdown}
          </span>
        )}
        <svg className={`w-4 h-4 text-text-muted flex-shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="currentColor" aria-hidden>
          <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
        </svg>
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-5">
          <p className="text-sm text-text-muted -mt-1">Thank you for using RupChain.</p>

          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="bg-surface rounded-lg border border-border p-3">
              <p className="text-text-muted text-xs mb-0.5">Token</p>
              <p className="font-semibold text-text-primary">{parseFloat(trade.amount).toLocaleString(undefined, { maximumFractionDigits: 3 })} {trade.coin}</p>
            </div>
            <div className="bg-surface rounded-lg border border-border p-3">
              <p className="text-text-muted text-xs mb-0.5">Total PKR</p>
              <p className="font-semibold text-text-primary">PKR {Number(trade.fiatAmount ?? trade.totalPkr).toLocaleString()}</p>
            </div>
            <div className="bg-surface rounded-lg border border-border p-3">
              <p className="text-text-muted text-xs mb-0.5">Payment Method</p>
              <p className="font-semibold text-text-primary">{trade.paymentMethodLabel ?? trade.paymentMethod}</p>
            </div>
            <div className="bg-surface rounded-lg border border-border p-3">
              <p className="text-text-muted text-xs mb-0.5">{isUserBuyer ? 'Seller' : 'Buyer'}</p>
              <p className="font-semibold text-text-primary">{counterparty}</p>
            </div>
          </div>

          <div className="border-t border-border pt-4">
            {ratedAlready ? (
              <p className="text-sm text-text-muted text-center">You already rated this trade.</p>
            ) : (
              <>
                <div className="flex items-center justify-between mb-3 gap-2">
                  <p className="text-sm font-semibold text-text-primary">Rate your experience with {counterparty}</p>
                  {ratingOpen && (
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-gold flex-shrink-0" title="Time left to submit your rating">
                      <Clock size={11} aria-hidden /> {countdown} left
                    </span>
                  )}
                </div>
                {/* When the window closes the form stays visible — only submission is
                    blocked (button disabled), so the trade record/details remain. */}
                <InlineRatingForm
                  onSubmit={onRatingSubmit}
                  actionError={actionError}
                  disabled={windowClosed}
                  disabledNote={windowClosed ? `The ${RATING_WINDOW_MINUTES}-minute rating window has closed — this trade can no longer be rated.` : undefined}
                />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Step Card (CTM-style guided flow) ─────────────────────────────────────────

type StepState = 'completed' | 'active' | 'future'

function StepCard({ stepNum, title, state, summary, expanded, onToggle, children }: {
  stepNum: number; title: string; state: StepState; summary?: string
  expanded: boolean; onToggle: () => void; children?: React.ReactNode
}) {
  // Active step is always open; completed steps collapse to a summary line but
  // stay re-openable; future steps are locked shut.
  const isExpanded = state === 'active' || (state === 'completed' && expanded)
  return (
    <div className={`border rounded-xl overflow-hidden transition-colors ${
      state === 'active' ? 'border-primary bg-surface shadow-card ring-1 ring-primary/10'
        : state === 'completed' ? 'border-success/30 bg-surface'
        : 'border-border bg-surface/50'
    }`}>
      <div
        className={`flex items-center gap-3 p-4 ${state === 'completed' ? 'cursor-pointer hover:bg-surface-alt/40 transition-colors' : ''}`}
        onClick={state === 'completed' ? onToggle : undefined}
      >
        <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${
          state === 'completed' ? 'bg-success text-white' : state === 'active' ? 'bg-primary text-white' : 'bg-surface-alt text-text-muted'
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
          <svg className={`w-4 h-4 text-text-muted flex-shrink-0 transition-transform ${isExpanded ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="currentColor" aria-hidden>
            <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
          </svg>
        )}
        {state === 'future' && (
          <svg className="w-4 h-4 text-text-muted/50 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
            <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
          </svg>
        )}
      </div>
      {isExpanded && children && (
        <div className={`px-4 pb-4 border-t ${state === 'active' ? 'border-primary/10' : 'border-success/15'}`}>
          <div className="pt-3 space-y-3">{children}</div>
        </div>
      )}
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function TradePage() {
  const { id } = useParams<{ id: string }>()
  const { user } = useAuth()
  const { isOffline } = useOfflineDetection()

  const [trade, setTrade] = useState<ExtendedTrade | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [messageInput, setMessageInput] = useState('')
  const [sendingMsg, setSendingMsg] = useState(false)
  const [actionLoading, setActionLoading] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const [showCancelModal, setShowCancelModal] = useState(false)
  const [cancelReason, setCancelReason] = useState('')
  const [showReleaseModal, setShowReleaseModal] = useState(false)
  const [ratedAlready, setRatedAlready] = useState(false)

  const [showDisputeForm, setShowDisputeForm] = useState(false)
  const [disputeReason, setDisputeReason] = useState('')
  const [disputeDescription, setDisputeDescription] = useState('')
  const [showCryptoSentForm, setShowCryptoSentForm] = useState(false)
  const [txHash, setTxHash] = useState('')
  // Optional delivery screenshot (CTM-style dual proof). For manual / exchange-UID
  // transfers the screenshot IS the proof; for on-chain transfers it's supplemental.
  const [deliveryShot, setDeliveryShot] = useState<File | null>(null)

  // Completed step cards collapse to a summary; this tracks which ones the user
  // has manually re-opened.
  const [expandedSteps, setExpandedSteps] = useState<Set<number>>(new Set())
  const toggleStep = (n: number) => setExpandedSteps((prev) => {
    const next = new Set(prev)
    if (next.has(n)) next.delete(n); else next.add(n)
    return next
  })

  // Mobile-only tab: at <lg the trade panel and chat stack vertically and the
  // page becomes a long scroll. Segmented control lets the user swap views.
  const [mobileTab, setMobileTab] = useState<'trade' | 'chat'>('trade')
  // Tracks how many messages the user had seen the last time they opened the
  // chat tab — drives the unread red dot on the Trade tab.
  const lastSeenChatCountRef = useRef(0)
  const [unreadChat, setUnreadChat] = useState(false)

  const chatEndRef = useRef<HTMLDivElement>(null)
  // Guards the one-time "I'm sending the crypto" ping so re-opening the proof
  // form doesn't spam the buyer with duplicate messages.
  const announcedSendingRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const chatImageInputRef = useRef<HTMLInputElement>(null)
  const prevMsgCountRef = useRef(0)
  const { upload, uploading } = useFileUpload('payment-proof')
  const { upload: uploadChatImage, uploading: uploadingChatImage } = useFileUpload('chat-image')

  const fetchTrade = useCallback(async () => {
    try {
      const [tradeData, messagesData] = await Promise.all([
        tradesApi.getTrade(id),
        tradesApi.getMessages(id),
      ])
      const extended = tradeData as ExtendedTrade
      setTrade(extended)
      if (extended.ratedByMe) setRatedAlready(true)
      // Preserve any in-flight optimistic messages (id prefix tmp-) so a
      // poll/SSE refresh between user-send and server-ack doesn't make the
      // user's bubble briefly vanish. BUT drop any optimistic bubble whose
      // content already landed on the server — otherwise a send that actually
      // succeeded (response lost on the network, so it was marked "failed")
      // would show forever as a phantom "Failed" duplicate next to the real one.
      setMessages((prev) => {
        const serverMessages: ChatMessage[] = Array.isArray(messagesData)
          ? (messagesData as ChatMessage[])
          : ((messagesData as { messages: ChatMessage[] }).messages ?? [])
        const serverKeys = new Set(serverMessages.map((m) => `${m.senderId}::${m.message}`))
        const optimistic = prev.filter((m) => {
          if (!m.id.startsWith('tmp-')) return false
          // Drop a "failed" bubble whose content already landed on the server —
          // that's the phantom (the send actually went through). In-flight
          // ("sending") bubbles are always kept until their own ack/next poll.
          if (m.sendStatus === 'failed' && serverKeys.has(`${m.senderId}::${m.message}`)) return false
          return true
        })
        return optimistic.length ? [...serverMessages, ...optimistic] : serverMessages
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load trade')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { fetchTrade() }, [fetchTrade])
  // Polling as fallback; SSE triggers immediate refresh on trade events
  usePolling(fetchTrade, 30_000, !loading && !error)

  // High-intent push opt-in: a user inside an active trade is the most likely
  // to want alerts. The banner gates on permission state and snooze.
  const pushPromptedRef = useRef(false)
  useEffect(() => {
    if (pushPromptedRef.current || !trade) return
    const active = ['payment_pending', 'payment_uploaded', 'payment_confirmed', 'crypto_sent']
    if (!active.includes(trade.status)) return
    pushPromptedRef.current = true
    promptPushOptIn('trade')
  }, [trade])

  useSSE((event) => {
    if (event.type === 'notification') {
      const payload = event.payload as { metadata?: { tradeId?: string } } | undefined
      if (payload?.metadata?.tradeId === id) void fetchTrade()
    }
  })

  // Scroll chat to bottom only when new messages arrive
  useEffect(() => {
    if (messages.length > prevMsgCountRef.current) {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
    prevMsgCountRef.current = messages.length
  }, [messages])

  // Unread tracking for the mobile Chat tab. New incoming messages while the
  // user is on the Trade tab light up the red dot; opening Chat resets it.
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

  const isUserBuyer = trade?.buyerId === user?.id

  // ── Actions ──────────────────────────────────────────────────────────────

  // Buyer: upload payment proof (payment_pending → payment_uploaded)
  const handleUploadProof = async (file: File) => {
    setActionError(null)
    try {
      const url = await upload(file)
      await tradesApi.uploadPaymentProof(id, url)
      analytics.paymentProofUploaded({ tradeId: id })
      await fetchTrade()
      hapticNotify('success')
    } catch (err) {
      hapticNotify('error')
      setActionError(err instanceof Error ? err.message : 'Upload failed')
    }
  }

  // Seller: confirm payment received (payment_uploaded → payment_confirmed)
  const handleConfirmPayment = async () => {
    setActionLoading(true)
    setActionError(null)
    try {
      await tradesApi.confirmPayment(id)
      analytics.paymentConfirmed({ tradeId: id })
      await fetchTrade()
      hapticNotify('success')
    } catch (err) {
      hapticNotify('error')
      setActionError(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setActionLoading(false)
    }
  }

  // Seller: mark crypto sent (payment_confirmed → crypto_sent)
  const handleMarkCryptoSent = async () => {
    // Dual proof: a tx hash OR a transfer screenshot (or both). On-chain wallet
    // delivery needs the hash; manual / exchange-UID delivery needs the screenshot.
    const dm = trade?.buyerDeliveryMethod ?? ''
    const isWalletDelivery = dm === 'blockchain' || dm === 'wallet_blockchain' || dm === ''
    if (!txHash.trim() && !deliveryShot) {
      setActionError(isWalletDelivery
        ? 'Enter the transaction hash (or attach a transfer screenshot) for this transfer.'
        : 'Attach a screenshot of the transfer (a reference / hash is optional for this delivery method).')
      return
    }
    setActionLoading(true)
    setActionError(null)
    try {
      let screenshotUrl: string | undefined
      if (deliveryShot) screenshotUrl = await upload(deliveryShot)
      await tradesApi.markCryptoSent(id, txHash.trim(), screenshotUrl)
      await fetchTrade()
      setShowCryptoSentForm(false)
      setTxHash('')
      setDeliveryShot(null)
      hapticNotify('success')
    } catch (err) {
      hapticNotify('error')
      setActionError(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setActionLoading(false)
    }
  }

  // Seller stage 1: announce "I'm sending the crypto now". Opens the proof form
  // and pings the buyer once so they know the transfer is on its way before the
  // hash/screenshot lands. Non-blocking — the form opens regardless.
  const handleStartSending = async () => {
    setShowCryptoSentForm(true)
    if (announcedSendingRef.current) return
    announcedSendingRef.current = true
    try {
      const coin = trade?.coin ?? 'USDT'
      await tradesApi.sendMessage(id, `🔔 I'm sending your ${coin} now — please wait for it to arrive in your wallet/account, then confirm receipt to complete the trade.`)
      await fetchTrade()
    } catch { /* non-blocking: the proof form is already open */ }
  }

  // Buyer: release escrow (crypto_sent → crypto_released)
  const handleRelease = async () => {
    setActionLoading(true)
    setActionError(null)
    try {
      await tradesApi.releaseCrypto(id)
      if (trade) {
        analytics.tradeCompleted({ tradeId: id, amount: parseFloat(trade.amount), coin: trade.coin ?? '' })
      }
      await fetchTrade()
      setShowReleaseModal(false)
      hapticNotify('success')
    } catch (err) {
      hapticNotify('error')
      setActionError(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setActionLoading(false)
    }
  }

  const handleCancel = async () => {
    setActionLoading(true)
    setActionError(null)
    try {
      await tradesApi.cancelTrade(id, cancelReason.trim() || 'Cancelled by user')
      await fetchTrade()
      setShowCancelModal(false)
      setCancelReason('')
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Cancel failed')
    } finally {
      setActionLoading(false)
    }
  }

  const handleOpenDispute = async () => {
    if (!disputeReason.trim()) return
    if (disputeDescription.trim().length < 10) {
      setActionError('Please describe the issue in at least 10 characters')
      return
    }
    setActionLoading(true)
    setActionError(null)
    try {
      await tradesApi.openDispute(id, { reason: disputeReason, description: disputeDescription.trim() })
      // Submission succeeded. Refreshing the trade afterwards is best-effort —
      // a transient blip on the refresh must NOT surface as a "dispute failed"
      // error, because the dispute is already created server-side.
      setShowDisputeForm(false)
      setDisputeReason('')
      setDisputeDescription('')
      try { await fetchTrade() } catch { /* refresh will retry via polling */ }
    } catch (err) {
      // If the dispute already exists (e.g. a prior submit went through but the
      // response was lost on the network), treat it as success rather than an error.
      const msg = err instanceof Error ? err.message : 'Dispute failed'
      if (/already exists/i.test(msg)) {
        setShowDisputeForm(false)
        setDisputeReason('')
        setDisputeDescription('')
        try { await fetchTrade() } catch { /* polling will catch up */ }
      } else {
        setActionError(msg)
      }
    } finally {
      setActionLoading(false)
    }
  }

  const handleSendMessage = async () => {
    if (!messageInput.trim() || sendingMsg) return
    const text = messageInput.trim()
    // Optimistic: push the message immediately with a 'sending' marker so the
    // user sees their bubble appear without waiting for the round trip.
    const tempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const optimistic: ChatMessage = {
      id: tempId,
      senderId: user?.id ?? '',
      message: text,
      createdAt: new Date().toISOString(),
      sendStatus: 'sending',
    }
    setMessages((prev) => [...prev, optimistic])
    setMessageInput('')
    setSendingMsg(true)
    try {
      const msg = await tradesApi.sendMessage(id, text)
      setMessages((prev) =>
        prev.map((m) => m.id === tempId
          ? { id: msg.id, senderId: user?.id ?? '', message: text, createdAt: msg.createdAt }
          : m),
      )
    } catch (err) {
      // Mark the optimistic bubble as failed; user can tap retry.
      setMessages((prev) =>
        prev.map((m) => m.id === tempId ? { ...m, sendStatus: 'failed' } : m),
      )
      setActionError(err instanceof Error ? err.message : 'Failed to send message')
    } finally {
      setSendingMsg(false)
    }
  }

  const handleRetryMessage = async (failedId: string) => {
    const failed = messages.find((m) => m.id === failedId)
    if (!failed) return
    // Reconstruct the payload before resending. Image messages historically
    // stored an empty `message` with the URL in `imageUrl`, so a naive retry
    // sent "" and the backend rejected it ("String must contain at least 1
    // character"). Rebuild the [image]<url> body from imageUrl when needed.
    const payload = failed.message?.trim()
      ? failed.message
      : failed.imageUrl ? `[image]${failed.imageUrl}` : ''
    if (!payload.trim()) {
      setActionError('Cannot retry an empty message')
      return
    }
    setActionError(null)
    setMessages((prev) => prev.map((m) => m.id === failedId ? { ...m, sendStatus: 'sending' } : m))
    try {
      const msg = await tradesApi.sendMessage(id, payload)
      setMessages((prev) =>
        prev.map((m) => m.id === failedId
          ? { id: msg.id, senderId: user?.id ?? '', message: payload, imageUrl: failed.imageUrl, createdAt: msg.createdAt }
          : m),
      )
    } catch (err) {
      setMessages((prev) => prev.map((m) => m.id === failedId ? { ...m, sendStatus: 'failed' } : m))
      setActionError(err instanceof Error ? err.message : 'Failed to send message')
    }
  }

  const handleChatImageUpload = async (file: File) => {
    setActionError(null)
    try {
      const url = await uploadChatImage(file)
      // Send the image URL as a chat message with a special prefix so the UI can
      // render it. Store the full [image]<url> payload as the message (not "")
      // so retry/dedupe logic always has valid, non-empty content to resend.
      const tempId = `tmp-img-${Date.now()}`
      const payload = `[image]${url}`
      const optimistic: ChatMessage = {
        id: tempId,
        senderId: user?.id ?? '',
        message: payload,
        imageUrl: url,
        createdAt: new Date().toISOString(),
        sendStatus: 'sending',
      }
      setMessages((prev) => [...prev, optimistic])
      setSendingMsg(true)
      try {
        const msg = await tradesApi.sendMessage(id, payload)
        setMessages((prev) =>
          prev.map((m) =>
            m.id === tempId
              ? { id: msg.id, senderId: user?.id ?? '', message: payload, imageUrl: url, createdAt: msg.createdAt }
              : m,
          ),
        )
      } catch (err) {
        setMessages((prev) => prev.map((m) => m.id === tempId ? { ...m, sendStatus: 'failed' } : m))
        setActionError(err instanceof Error ? err.message : 'Failed to send image')
      } finally {
        setSendingMsg(false)
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Image upload failed')
    }
  }

  const handleRatingSubmit = async (rating: number, comment: string, tags: string[]) => {
    setActionError(null)
    try {
      await tradesApi.rateTrade(id, { rating, comment: comment.trim() || undefined, tags: tags.length ? tags : undefined })
      setRatedAlready(true)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to submit rating')
    }
  }

  if (loading) return <LoadingState message="Loading trade..." />
  if (error || !trade) return <ErrorState title={error ?? 'Trade not found'} onRetry={fetchTrade} />

  const currentStep = stepIndex(trade.status)

  // ── Flow-aware step model ──────────────────────────────────────────────────
  // The settlement resolver is the single source of truth for who does what next,
  // in BOTH the classic (fiat-first) and taker-first (crypto-first) flows. Card
  // ORDER, active-state, and the action shown all derive from it — so there is one
  // coherent ladder instead of a separate "your turn" banner disagreeing with the
  // cards below it. `flowOrder` index === the ladder rung an action lands on, and
  // `currentStep` is that same ladder position, so they compare directly.
  const takerFirst = !!trade.takerFirst
  const flowStep = flowCurrentStep(takerFirst, trade.status)
  const myRole: FlowActor = isUserBuyer ? 'buyer' : 'seller'
  const myTurn = !!flowStep && flowStep.actor === myRole
  const isAction = (a: FlowAction) => !!flowStep && flowStep.action === a
  const order = flowOrder(takerFirst)
  // State of the card that hosts `actions`, from how far the trade has advanced.
  const legState = (actions: FlowAction[]): StepState => {
    const idxs = actions.map((a) => order.indexOf(a))
    const start = Math.min(...idxs)
    const end = Math.max(...idxs)
    if (currentStep > end) return 'completed'
    if (currentStep >= start) return 'active'
    return 'future'
  }
  // Display order / step numbers: crypto leg leads in taker-first, fiat leg leads
  // in classic; the Complete card is always last.
  const legPos = trade.takerFirst
    ? { crypto: 1, fiat: 2, fiat_confirm: 3, complete: 4 }
    : { fiat: 1, fiat_confirm: 2, crypto: 3, complete: 4 }

  const pmLabel = trade.paymentMethodLabel ?? trade.paymentMethod
  const sellerAccount = trade.sellerPaymentAccount
  const canCancel = isUserBuyer && trade.status === 'payment_pending'
  // Dispute lock (mirrors backend trade.service.ts): the party who confirms the
  // counterparty's leg (lands on payment_confirmed) can't dispute instead of
  // delivering their own. FLOW-DEPENDENT — classic locks the seller (confirmed
  // fiat), taker-first locks the buyer/maker (confirmed crypto) — so derive it.
  const lock = disputeLock(takerFirst)
  const disputeLockedForMe = (lock.actor === 'buyer' ? isUserBuyer : !isUserBuyer) && lock.lockedStatuses.includes(trade.status)
  // crypto_sent included: buyer may need to dispute non-receipt or a tx stuck
  // in admin verification (matches backend disputeStatuses in trade.service.ts)
  const canDispute = ['payment_uploaded', 'payment_confirmed', 'crypto_sent'].includes(trade.status) && !disputeLockedForMe
  // Dispute unlocks DISPUTE_DELAY_MINUTES after payment proof was uploaded.
  // Legacy trades without the timestamp are unlocked immediately (null = no gate).
  const disputeUnlockAt = trade.paymentUploadedAt
    ? new Date(trade.paymentUploadedAt).getTime() + DISPUTE_DELAY_MINUTES * 60_000
    : null
  const counterpartyUser = isUserBuyer ? trade.seller : trade.buyer
  const counterparty = counterpartyUser?.fullName || counterpartyUser?.username || (isUserBuyer ? 'Seller' : 'Buyer')
  const counterpartyBadge = (counterpartyUser?.tradeStats?.badge ?? 'new') as TraderBadge
  const counterpartyStats = counterpartyUser?.tradeStats
  const counterpartyKycVerified = counterpartyUser?.kycLevel === 'basic' || counterpartyUser?.kycLevel === 'enhanced'
  const completionRateColor = (rate: number) =>
    rate >= 0.8 ? 'text-success' : rate >= 0.6 ? 'text-warning' : 'text-danger'

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
      {/* Offline banner */}
      {isOffline && (
        <div className="mb-4 flex items-center gap-3 rounded-xl bg-danger/10 border border-danger/20 px-4 py-3 text-sm text-danger">
          <WifiOff size={16} className="flex-shrink-0" aria-hidden />
          <span>You are offline. Trade actions will not go through until your connection is restored.</span>
        </div>
      )}

      {/* Header — title row, then a single wrapping meta row that keeps the
          status badge inline next to the streak chip so it reads as one tidy
          block (no lone "status" row dangling on its own line on mobile). */}
      <div className="mb-6">
        <div className="flex items-center gap-2 flex-wrap">
          <UserAvatar name={counterparty} avatarUrl={counterpartyUser?.avatarUrl} size="md" />
          <h1 className="text-lg sm:text-xl font-bold text-text-primary">
            Trade with {counterparty}
          </h1>
          <BadgeChip badge={counterpartyBadge} />
        </div>
        <div className="flex items-center gap-x-3 gap-y-2 mt-2 flex-wrap">
          <p className="text-xs text-text-muted font-mono break-words">Trade #{trade.orderRef || trade.id.slice(-6).toUpperCase()}</p>
          {counterpartyStats && (
            <span className="text-xs text-text-muted">
              {counterpartyStats.completedTrades} trades ·{' '}
              <span className={completionRateColor(Number(counterpartyStats.completionRate) ?? 0)}>
                {((Number(counterpartyStats.completionRate) ?? 0) * 100).toFixed(0)}% completion
              </span>
            </span>
          )}
          {counterpartyKycVerified && (
            <span className="inline-flex items-center gap-1 text-xs text-success font-medium">
              <BadgeCheck size={12} />
              KYC Verified
            </span>
          )}
          {typeof trade.streakCount === 'number' && trade.streakCount > 0 && (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 border border-amber-500/25 px-2 py-0.5 text-xs font-semibold text-amber-600 dark:text-amber-400"
              title="Combined completed trades between you two (USDT + community tokens)"
            >
              🤝 {trade.streakCount} {trade.streakCount === 1 ? 'trade' : 'trades'} together
            </span>
          )}
          {(() => {
            const s = getTradeStatus(trade.status)
            return <Badge variant={s.variant} icon={s.icon}>{s.label}</Badge>
          })()}
        </div>
      </div>

      {/* Trade protection banner — only on active trades */}
      {!['crypto_released', 'cancelled', 'expired', 'disputed', 'dispute_resolved'].includes(trade.status) && (
        <div className="mb-4 flex items-start gap-3 rounded-xl bg-primary/5 border border-primary/15 px-4 py-3">
          <ShieldCheck size={16} className="text-primary flex-shrink-0 mt-0.5" aria-hidden />
          <p className="text-sm text-primary/90">
            RupChain monitors this trade and protects both parties. Only confirm receipt after you have verified payment.
          </p>
        </div>
      )}

      {/* Mobile tab switcher */}
      <div className="flex bg-surface border border-border rounded-xl overflow-hidden mb-4 lg:hidden">
        {(['trade', 'chat'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setMobileTab(t)}
            className={`flex-1 px-4 py-2.5 text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
              mobileTab === t ? 'bg-primary text-white' : 'text-text-secondary hover:bg-surface'
            }`}
          >
            {t === 'trade' ? 'Trade' : 'Chat'}
            {t === 'chat' && unreadChat && <span className="w-2 h-2 rounded-full bg-danger" />}
          </button>
        ))}
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Left: status + actions. min-w-0 lets this grid column shrink to the
            viewport instead of being sized up by any wide child (e.g. the
            progress timeline), which would otherwise clip every card. */}
        <div className={`min-w-0 space-y-5 ${mobileTab === 'chat' ? 'hidden lg:block' : ''}`}>
          {/* Countdown */}
          {trade.expiresAt && trade.status === 'payment_pending' && (
            <div className="bg-warning/10 border border-warning/20 rounded-xl p-4 flex items-center gap-3">
              <svg className="w-5 h-5 text-warning flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div>
                {/* In taker-first the opening window is the seller sending crypto,
                    not a buyer payment — keep the label flow-accurate. */}
                <p className="text-sm font-medium text-warning">{takerFirst ? 'Trade window' : 'Payment window'}</p>
                <CountdownTimer expiresAt={trade.expiresAt} />
              </div>
            </div>
          )}

          {/* Progress bar — full-width, flex-distributed so all steps fit any
              screen without a sideways scroll (connectors flex to fill). */}
          <div className="bg-surface rounded-xl border border-border shadow-card p-3 sm:p-4">
            <div className="flex items-start min-w-0">
              {TIMELINE_STEPS.map((step, i) => {
                const { Icon } = step
                const isLast = i === TIMELINE_STEPS.length - 1
                return (
                  <div key={step.key} className={`flex items-start min-w-0 ${isLast ? '' : 'flex-1'}`}>
                    <div className="flex flex-col items-center flex-shrink-0">
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                        i < currentStep ? 'bg-success text-white'
                          : i === currentStep ? 'bg-primary text-white ring-4 ring-primary/15'
                          : 'bg-surface-alt text-text-muted border border-border'
                      }`}>
                        {i < currentStep ? <CheckCircle2 size={14} aria-hidden /> : <Icon size={14} aria-hidden />}
                      </div>
                      <p className={`mt-1.5 w-12 sm:w-16 text-center text-[10px] leading-tight break-words ${
                        i === currentStep ? 'text-primary font-semibold'
                          : i < currentStep ? 'text-success font-medium'
                          : 'text-text-muted'
                      }`}>{trade.takerFirst ? (TIMELINE_LABELS_TAKER_FIRST[step.key] ?? step.label) : step.label}</p>
                    </div>
                    {!isLast && (
                      <div className={`h-0.5 flex-1 min-w-[2px] mt-4 mx-0.5 sm:mx-1 ${i < currentStep ? 'bg-success' : 'bg-border'}`} />
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {trade.status === 'disputed' && (
            <div className="bg-danger/10 border border-danger/30 rounded-xl p-4 text-sm">
              <p className="font-semibold text-danger mb-1">Dispute in progress</p>
              <p className="text-text-muted text-xs">Our team is reviewing this trade. Please respond in the chat with any evidence you have.</p>
            </div>
          )}

          {trade.status === 'dispute_resolved' && (
            <div className="bg-surface-alt border border-border rounded-xl p-4 text-sm">
              <p className="font-semibold text-text-primary mb-1">Dispute resolved</p>
              <p className="text-text-muted text-xs">An admin has resolved this dispute — see your notifications and the chat for the ruling. The platform doesn&apos;t move funds, so settle directly with your counterparty per the decision. The trade details below are kept for your reference.</p>
            </div>
          )}

          {['cancelled', 'expired'].includes(trade.status) && (
            <div className="bg-surface-alt border border-border rounded-xl p-4 text-sm text-center text-text-muted">
              This trade was <span className="font-medium text-text-primary">{trade.status}</span>.
            </div>
          )}

          {/* Guided step flow — the ONE source of truth. Active step auto-expands
              and carries its action; completed steps collapse to a summary line and
              stay re-openable. Order + state come from the flow resolver, so classic
              (fiat-first) and taker-first (crypto-first) share one coherent ladder. */}
          {!['cancelled', 'expired'].includes(trade.status) && (
            <>
              {/* Cards render in flow order via CSS `order`: fiat leg leads in
                  classic, crypto leg leads in taker-first. Only one card is active
                  (interactive) at a time, so visual order carries the sequence. */}
              <div className="flex flex-col gap-4">
              {/* Payment (fiat) leg */}
              <div style={{ order: legPos.fiat }}>
              <StepCard
                stepNum={legPos.fiat}
                title={isUserBuyer ? 'Send Payment' : 'Receive PKR Payment'}
                state={legState(['send_fiat'])}
                summary={`PKR ${Number(trade.fiatAmount ?? trade.totalPkr).toLocaleString()} · ${pmLabel}`}
                expanded={expandedSteps.has(legPos.fiat)}
                onToggle={() => toggleStep(legPos.fiat)}
              >
                <div className="bg-surface-alt/40 rounded-lg p-3 space-y-2 text-sm">
                  <DetailRow label="Amount" value={`${parseFloat(trade.amount).toLocaleString(undefined, { maximumFractionDigits: 3 })} ${trade.coin}`} />
                  <DetailRow label="Price" value={`PKR ${Number(trade.price).toLocaleString()}`} />
                  <DetailRow label="Total PKR" value={`PKR ${Number(trade.fiatAmount ?? trade.totalPkr).toLocaleString()}`} highlight />
                  <div className="flex justify-between">
                    <span className="text-text-muted">Pay via</span>
                    <span className="inline-flex items-center gap-1.5 font-medium text-text-primary">
                      <EntityLogo type={PK_MOBILE_METHODS.includes(pmLabel) ? 'payment_method' : 'bank'} slug={pmLabel} size="xs" className="flex-shrink-0" />
                      {pmLabel}
                    </span>
                  </div>
                </div>
                {sellerAccount && (
                  <div className="space-y-2">
                    <p className="text-xs font-semibold text-text-primary">
                      {isUserBuyer ? 'Send your PKR payment to' : 'Your receiving account'}
                    </p>
                    <PayToRow label="Account name" value={sellerAccount.accountName} />
                    {sellerAccount.mobileNumber && <PayToRow label="Payment number" value={sellerAccount.mobileNumber} copy />}
                    {sellerAccount.accountNumber && <PayToRow label="Account number" value={sellerAccount.accountNumber} copy />}
                    {sellerAccount.ibanNumber && <PayToRow label="IBAN" value={sellerAccount.ibanNumber} copy />}
                    {sellerAccount.bankName && <PayToRow label="Bank" value={sellerAccount.bankName} />}
                    {myTurn && isAction('send_fiat') && (
                      <p className="text-xs text-text-muted leading-snug pt-1">
                        Send exactly <span className="font-semibold text-text-primary">PKR {Number(trade.fiatAmount ?? trade.totalPkr).toLocaleString()}</span> to this account, then upload your payment proof.
                      </p>
                    )}
                  </div>
                )}
                {/* Buyer view: the account the buyer committed to pay FROM — mirrors
                    the seller's "Buyer will pay from" block so both sides see the same
                    pay-from account, not just the seller. */}
                {isUserBuyer && trade.buyerPaymentSnapshot && (() => {
                  const b = trade.buyerPaymentSnapshot!
                  const accounts = b.accounts && b.accounts.length > 0 ? b.accounts : [b]
                  return (
                    <div className="space-y-2">
                      <p className="text-xs font-semibold text-text-primary">You&apos;ll pay from</p>
                      {accounts.map((acc, i) => (
                        <div key={i} className="bg-surface-alt/40 rounded-lg p-3 space-y-2">
                          <PayToRow label="Method" value={acc.label} />
                          <PayToRow label="Account name" value={acc.accountName} />
                          {acc.mobileNumber && <PayToRow label="Payment number" value={acc.mobileNumber} copy />}
                          {acc.accountNumber && <PayToRow label="Account number" value={acc.accountNumber} copy />}
                          {acc.ibanNumber && <PayToRow label="IBAN" value={acc.ibanNumber} copy />}
                          {acc.bankName && <PayToRow label="Bank" value={acc.bankName} />}
                        </div>
                      ))}
                      <p className="text-xs text-text-muted leading-snug">Send the PKR from {accounts.length > 1 ? 'one of these accounts' : 'this account'} so the seller can match your payment.</p>
                    </div>
                  )
                })()}
                {/* Seller view: where the buyer's PKR payment will come from (buy ads) */}
                {!isUserBuyer && trade.buyerPaymentSnapshot && (() => {
                  const b = trade.buyerPaymentSnapshot!
                  const accounts = b.accounts && b.accounts.length > 0 ? b.accounts : [b]
                  return (
                    <div className="space-y-2">
                      <p className="text-xs font-semibold text-text-primary">Buyer will pay from</p>
                      {accounts.map((acc, i) => (
                        <div key={i} className="bg-surface-alt/40 rounded-lg p-3 space-y-2">
                          <PayToRow label="Method" value={acc.label} />
                          <PayToRow label="Account name" value={acc.accountName} />
                          {acc.mobileNumber && <PayToRow label="Payment number" value={acc.mobileNumber} copy />}
                          {acc.accountNumber && <PayToRow label="Account number" value={acc.accountNumber} copy />}
                          {acc.ibanNumber && <PayToRow label="IBAN" value={acc.ibanNumber} copy />}
                          {acc.bankName && <PayToRow label="Bank" value={acc.bankName} />}
                        </div>
                      ))}
                      <p className="text-xs text-text-muted leading-snug">The buyer indicated they'll pay from {accounts.length > 1 ? 'one of these accounts' : 'this account'}. Match it against your incoming payment.</p>
                    </div>
                  )
                })()}
                {myTurn && isAction('send_fiat') && (
                  <>
                    <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUploadProof(f) }} />
                    <Button fullWidth loading={uploading} disabled={uploading || actionLoading} onClick={() => fileInputRef.current?.click()}>
                      Upload Payment Proof
                    </Button>
                    {canCancel && (
                      <Button variant="ghost" fullWidth onClick={() => setShowCancelModal(true)}>Cancel Trade</Button>
                    )}
                  </>
                )}
                {!myTurn && isAction('send_fiat') && (
                  <div className="bg-warning/10 border border-warning/20 rounded-lg p-3 text-xs text-warning">
                    Waiting for the buyer to send PKR and upload payment proof.
                  </div>
                )}
              </StepCard>
              </div>

              {/* Confirm Payment (fiat confirm) leg */}
              <div style={{ order: legPos.fiat_confirm }}>
              <StepCard
                stepNum={legPos.fiat_confirm}
                title="Confirm Payment"
                state={legState(['confirm_fiat'])}
                summary="Payment confirmed by seller"
                expanded={expandedSteps.has(legPos.fiat_confirm)}
                onToggle={() => toggleStep(legPos.fiat_confirm)}
              >
                {trade.paymentProofUrl && (
                  <div>
                    <p className="text-xs text-text-muted mb-2">Payment Proof</p>
                    {isTrustedImageUrl(trade.paymentProofUrl) ? (
                      <a href={trade.paymentProofUrl} target="_blank" rel="noopener noreferrer">
                        <NextImage src={trade.paymentProofUrl} alt="Payment proof" width={320} height={240} className="rounded-lg border border-border hover:opacity-90 transition-opacity cursor-pointer max-h-60 w-auto max-w-full object-contain" referrerPolicy="no-referrer" unoptimized />
                      </a>
                    ) : (
                      <div className="bg-warning/10 border border-warning/20 rounded-lg px-3 py-2 text-xs text-warning">Payment proof URL is from an untrusted source and cannot be displayed.</div>
                    )}
                  </div>
                )}
                {myTurn && isAction('confirm_fiat') && (
                  <>
                    <p className="text-xs text-text-muted">Confirm only after the PKR has actually arrived in your account — a screenshot alone is not proof of funds.</p>
                    <Button fullWidth loading={actionLoading} disabled={actionLoading} onClick={handleConfirmPayment}>Confirm Payment Received</Button>
                  </>
                )}
                {!myTurn && isAction('confirm_fiat') && (
                  <div className="bg-warning/10 border border-warning/20 rounded-lg p-3 text-xs text-warning">Waiting for the seller to confirm they received your payment.</div>
                )}
                {legState(['confirm_fiat']) === 'completed' && (
                  <div className="bg-success/10 border border-success/20 rounded-lg p-3 text-xs text-success">✓ Payment confirmed.</div>
                )}
              </StepCard>
              </div>

              {/* Crypto delivery & release leg */}
              <div style={{ order: legPos.crypto }}>
              <StepCard
                stepNum={legPos.crypto}
                title={isUserBuyer ? 'Receive & Confirm Crypto' : 'Send Crypto'}
                state={legState(['send_crypto', 'confirm_crypto'])}
                summary={`${parseFloat(trade.amount).toLocaleString(undefined, { maximumFractionDigits: 3 })} ${trade.coin} delivered`}
                expanded={expandedSteps.has(legPos.crypto)}
                onToggle={() => toggleStep(legPos.crypto)}
              >
                <div className="bg-surface-alt/40 rounded-lg p-3 space-y-2 text-sm">
                  {/* Amount is shown front-and-centre so the seller knows exactly how
                      much to send without scrolling back up to the order summary. */}
                  <div className="flex justify-between items-center gap-2 pb-2 mb-1 border-b border-border">
                    <span className="text-text-muted flex-shrink-0">{isUserBuyer ? 'Amount to receive' : 'Amount to send'}</span>
                    <span className="font-bold text-text-primary text-base">{parseFloat(trade.amount).toLocaleString(undefined, { maximumFractionDigits: 3 })} {trade.coin}</span>
                  </div>
                  {(() => {
                    // Network only applies to on-chain wallet delivery. For exchange /
                    // internal transfers the funds move off-chain, so show the transfer
                    // type instead of a (misleading) blockchain network.
                    const dm = (trade.buyerDeliveryMethod ?? '').toLowerCase()
                    const isWalletDelivery = dm === 'blockchain' || dm === 'wallet_blockchain' || dm === ''
                    return isWalletDelivery
                      ? <DetailRow label="Network" value={trade.network ?? trade.coin} />
                      : <DetailRow label="Transfer type" value="Internal / Exchange transfer" />
                  })()}
                  <DetailRow label="Method" value={deliveryMethodLabel(trade.buyerDeliveryMethod, trade.buyerWalletAddress)} />
                  {(() => {
                    const dest = trade.buyerDeliveryAddress || trade.buyerWalletAddress
                    if (!dest) {
                      return (
                        <p className="text-xs text-warning leading-snug">
                          {isUserBuyer
                            ? 'No receiving address on file. Tell the seller in chat exactly where to send your crypto.'
                            : 'No receiving address on file — ask the buyer in chat where to send the crypto before sending.'}
                        </p>
                      )
                    }
                    return (
                      // Stacked: the label sits above and the address fills the full
                      // width in a bordered box, so a UID / 0x… address wraps to one or
                      // two lines instead of a narrow vertical column at the right edge.
                      <div className="space-y-1 pt-1">
                        <span className="text-text-muted">{deliveryDestinationLabel(trade.buyerDeliveryMethod, isUserBuyer)}</span>
                        <div className="flex items-center gap-2 bg-surface border border-border rounded-lg px-2.5 py-2">
                          <span className="font-medium text-text-primary break-all font-mono text-xs min-w-0 flex-1">{dest}</span>
                          <CopyButton text={dest} size="sm" className="flex-shrink-0" />
                        </div>
                      </div>
                    )
                  })()}
                </div>

                {trade.sellerTxHash && (
                  <div className="space-y-1.5 text-sm">
                    <span className="text-text-muted">Transaction Hash</span>
                    {/* Full-width box → the hash wraps to one or two lines; the
                        verification badge + explorer link flow left-aligned below. */}
                    <div className="flex items-center gap-2 bg-surface border border-border rounded-lg px-2.5 py-2">
                      <span className="font-medium text-text-primary break-all font-mono text-xs min-w-0 flex-1">{trade.sellerTxHash}</span>
                      <CopyButton text={trade.sellerTxHash} size="sm" className="flex-shrink-0" />
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {trade.txVerificationStatus === 'verified' && (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-green-600 dark:text-green-400 bg-green-500/10 border border-green-500/30 rounded px-2 py-0.5">
                          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                          On-chain verified
                        </span>
                      )}
                      {trade.txVerificationStatus === 'pending' && (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-yellow-700 dark:text-yellow-400 bg-yellow-500/10 border border-yellow-500/30 rounded px-2 py-0.5">⏳ Confirming on-chain</span>
                      )}
                      {(trade.txVerificationStatus === 'skipped' || trade.txVerificationStatus === 'rpc_error') && (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-text-muted bg-surface border border-border rounded px-2 py-0.5">⚠ Verify manually on explorer</span>
                      )}
                      {trade.txVerificationStatus === 'not_found' && (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-orange-700 dark:text-orange-400 bg-orange-500/10 border border-orange-500/30 rounded px-2 py-0.5">⚠ Tx not found — pending or invalid</span>
                      )}
                      {(() => {
                        const url = explorerTxUrl(trade.network ?? '', trade.sellerTxHash!)
                        if (!url) return null
                        return (
                          <a href={url} target="_blank" rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                            View on {explorerName(trade.network ?? '')} ↗
                          </a>
                        )
                      })()}
                    </div>
                  </div>
                )}
                {trade.sellerDeliveryProofUrl && (
                  <div>
                    <p className="text-xs text-text-muted mb-2">Transfer Screenshot</p>
                    {isTrustedImageUrl(trade.sellerDeliveryProofUrl) ? (
                      <a href={trade.sellerDeliveryProofUrl} target="_blank" rel="noopener noreferrer">
                        <NextImage src={trade.sellerDeliveryProofUrl} alt="Transfer screenshot" width={320} height={240} className="rounded-lg border border-border hover:opacity-90 transition-opacity cursor-pointer max-h-60 w-auto max-w-full object-contain" referrerPolicy="no-referrer" unoptimized />
                      </a>
                    ) : (
                      <div className="bg-warning/10 border border-warning/20 rounded-lg px-3 py-2 text-xs text-warning">Screenshot URL is from an untrusted source and cannot be displayed.</div>
                    )}
                  </div>
                )}

                {/* Seller: send crypto (dual proof) */}
                {myTurn && isAction('send_crypto') && !showCryptoSentForm && (
                  <>
                    <div className="bg-primary/5 border border-primary/15 rounded-lg p-3 text-xs text-primary/90">
                      Tap below to let the buyer know you&apos;re sending now, then send the {trade.coin} to the address above and submit your transfer proof.
                    </div>
                    <Button fullWidth onClick={handleStartSending}>I&apos;m Sending the Crypto Now →</Button>
                  </>
                )}
                {myTurn && isAction('send_crypto') && showCryptoSentForm && (() => {
                  const dm = trade.buyerDeliveryMethod ?? ''
                  const isWalletDelivery = dm === 'blockchain' || dm === 'wallet_blockchain' || dm === ''
                  const canSubmit = !!txHash.trim() || !!deliveryShot
                  return (
                    <div className="space-y-3">
                      <p className="text-xs text-text-muted">
                        {isWalletDelivery
                          ? 'Enter the blockchain transaction hash for the transfer you sent to the buyer. You can also attach a screenshot as extra proof.'
                          : 'Attach a screenshot of the transfer you sent (e.g. the exchange / app confirmation). A reference or hash is optional for this delivery method.'}
                      </p>
                      <div>
                        <label className="block text-xs font-medium text-text-primary mb-1">Transaction Hash {isWalletDelivery ? '' : <span className="text-text-muted">(optional)</span>}</label>
                        <input type="text" value={txHash} onChange={(e) => setTxHash(e.target.value)} placeholder="Paste the blockchain transaction hash (e.g. 0xabc123…)" className="w-full px-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary font-mono" />
                        {isWalletDelivery && txHash.trim() && (() => {
                          const url = explorerTxUrl(trade.network ?? '', txHash.trim())
                          if (!url) return null
                          return (
                            <a href={url} target="_blank" rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline mt-1">
                              Check this hash on {explorerName(trade.network ?? '')} ↗
                            </a>
                          )
                        })()}
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-text-primary mb-1">Transfer Screenshot {isWalletDelivery ? <span className="text-text-muted">(optional)</span> : ''}</label>
                        <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setDeliveryShot(e.target.files?.[0] ?? null)} className="w-full text-xs border border-border rounded-lg p-2 file:mr-2 file:rounded file:border-0 file:bg-primary/10 file:px-2 file:py-1 file:text-primary" />
                        {deliveryShot && <p className="text-xs text-text-muted mt-1 truncate">Attached: {deliveryShot.name}</p>}
                      </div>
                      <div className="flex gap-2">
                        <Button variant="secondary" fullWidth onClick={() => { setShowCryptoSentForm(false); setDeliveryShot(null) }}>Cancel</Button>
                        <Button fullWidth loading={actionLoading || uploading} disabled={!canSubmit || actionLoading || uploading} onClick={handleMarkCryptoSent}>I&apos;ve Sent the Crypto</Button>
                      </div>
                    </div>
                  )
                })()}
                {!myTurn && isAction('send_crypto') && (
                  <div className="bg-primary/5 border border-primary/15 rounded-lg p-3 text-xs text-primary/90">The seller is sending your {trade.coin} now. Once it arrives in your wallet, confirm receipt below to complete the trade.</div>
                )}

                {/* Buyer: confirm receipt & release — no verification gate. The
                    buyer is the authority on their own wallet; admin only via dispute. */}
                {myTurn && isAction('confirm_crypto') && (() => {
                  const vs = trade.txVerificationStatus
                  const unverified = vs === 'skipped' || vs === 'rpc_error' || vs === 'pending' || vs === 'not_found'
                  return (
                    <>
                      <ReleaseReminder />
                      {vs === 'verified' && (
                        <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-800 dark:text-green-300">
                          <p className="font-semibold">✓ On-chain verified</p>
                          <p className="text-xs">The transaction was independently verified on the blockchain. Confirm once you have checked it arrived in your wallet.</p>
                        </div>
                      )}
                      {unverified && (
                        <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3 text-sm text-yellow-800 dark:text-yellow-300 space-y-1">
                          <p className="font-semibold">Confirm receipt in your own wallet first</p>
                          <p className="text-xs">We couldn&apos;t auto-verify this transfer — that&apos;s normal for {trade.network ?? 'this network'}, exchange-UID/email delivery, or a momentarily busy node. Check your wallet or account and make sure the crypto actually arrived before you confirm. If it never arrives, open a dispute instead of confirming.</p>
                        </div>
                      )}
                      <Button fullWidth loading={actionLoading} disabled={actionLoading} onClick={() => setShowReleaseModal(true)}>I&apos;ve Received the Crypto — Confirm</Button>
                    </>
                  )
                })()}
                {!myTurn && isAction('confirm_crypto') && (
                  <div className="bg-warning/10 border border-warning/20 rounded-lg p-3 text-xs text-warning">Waiting for the buyer to confirm receipt and release the trade.</div>
                )}
              </StepCard>
              </div>

              {/* Complete leg */}
              <div style={{ order: legPos.complete }}>
              <StepCard
                stepNum={legPos.complete}
                title="Trade Completed"
                state={trade.status === 'crypto_released' ? 'active' : 'future'}
                summary="You can rate your counterparty below"
                expanded={expandedSteps.has(legPos.complete)}
                onToggle={() => toggleStep(legPos.complete)}
              >
                {trade.status === 'crypto_released' ? (
                  <div className="bg-success/10 border border-success/20 rounded-lg p-3 text-sm text-success">✓ Trade complete.{ratedAlready ? ' Thanks for your rating!' : ' You can rate your counterparty below.'}</div>
                ) : (
                  <p className="text-xs text-text-muted">Once the buyer confirms receipt and releases, the trade is complete and you can rate each other.</p>
                )}
              </StepCard>
              </div>
              </div>

              {/* Dispute */}
              {canDispute && trade.status !== 'disputed' && !showDisputeForm && (
                <DisputeUnlockGate unlockAt={disputeUnlockAt} onOpen={() => setShowDisputeForm(true)} />
              )}
              {disputeLockedForMe && trade.status !== 'disputed' && (
                <div className="bg-surface rounded-xl border border-border shadow-card p-4 text-sm text-text-secondary">
                  <p className="mb-2">You already confirmed your counterparty delivered their part, so the only remaining step is to <span className="font-medium text-text-primary">send your own leg</span>. You can&apos;t open a dispute at this stage.</p>
                  <p>If something is genuinely wrong (e.g. the payment was reversed after you confirmed), <a href={supportMailto(`Trade ${trade.orderRef} — issue after confirming`)} className="text-primary underline">contact support</a>.</p>
                </div>
              )}
              {showDisputeForm && (
                <div className="bg-surface rounded-xl border border-border shadow-card p-5 space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-text-primary mb-1">Reason</label>
                    <select value={disputeReason} onChange={(e) => setDisputeReason(e.target.value)} className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-danger">
                      <option value="">Select a reason…</option>
                      <option value="payment_not_received">Payment not received</option>
                      <option value="crypto_not_sent">Crypto not sent</option>
                      <option value="wrong_amount">Wrong amount</option>
                      <option value="fake_proof">Fake payment proof</option>
                      <option value="counterparty_unresponsive">Counterparty unresponsive</option>
                      <option value="other">Other</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-text-primary mb-1">Details <span className="text-text-muted">(min 10 characters)</span></label>
                    <textarea value={disputeDescription} onChange={(e) => setDisputeDescription(e.target.value)} placeholder="Explain what happened in detail. Include any evidence or timeline of events..." rows={4} className="w-full px-3 py-2 text-sm border border-border rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-danger" />
                  </div>
                  <div className="flex gap-2">
                    <Button variant="secondary" fullWidth onClick={() => { setShowDisputeForm(false); setDisputeReason(''); setDisputeDescription('') }}>Cancel</Button>
                    <Button variant="danger" fullWidth loading={actionLoading} disabled={!disputeReason || disputeDescription.trim().length < 10} onClick={handleOpenDispute}>Submit Dispute</Button>
                  </div>
                </div>
              )}
            </>
          )}

          {actionError && (
            <p className="text-sm text-danger bg-danger/10 rounded-lg px-3 py-2">{actionError}</p>
          )}

          {/* Completed card — an optional, collapsible "rate this trade" step at the
              BOTTOM of the trade flow (no longer pinned to the top of the page). */}
          {trade.status === 'crypto_released' && (
            <CompletedTradeCard
              trade={trade}
              isUserBuyer={isUserBuyer}
              counterparty={counterparty}
              ratedAlready={ratedAlready}
              onRatingSubmit={handleRatingSubmit}
              actionError={actionError}
            />
          )}
        </div>

        {/* Right: Chat — display class is conditional so `flex` and `hidden`
            never coexist in the class list (which is ambiguous in Tailwind). */}
        {/* Mobile: chat fills most of the dynamic viewport so it behaves like a
            messaging screen and the send box stays reachable above the keyboard.
            Desktop (lg): fixed 400–600px box inside the two-column layout. */}
        <div className={`min-w-0 bg-surface rounded-xl border border-border shadow-card flex-col min-h-[60dvh] max-h-[75dvh] lg:min-h-[400px] lg:max-h-[600px] ${mobileTab === 'trade' ? 'hidden lg:flex' : 'flex'}`}>
          <div className="px-4 py-3 border-b border-border">
            <h2 className="text-sm font-semibold text-text-primary">Chat with {counterparty}</h2>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {/* Seller's terms carried over from the ad, shown as the first message
                in the thread (left-aligned, like a message from the counterparty). */}
            {trade.ad?.terms?.trim() && (
              <div className={`flex ${isUserBuyer ? 'justify-start' : 'justify-end'}`}>
                <div className={`max-w-[80%] px-3 py-2 rounded-2xl bg-surface border border-border shadow-sm ${isUserBuyer ? 'rounded-bl-sm' : 'rounded-br-sm'}`}>
                  <p className="flex items-center gap-1 text-[11px] font-semibold text-text-secondary mb-1">
                    <FileText size={12} className="flex-shrink-0" aria-hidden />
                    {(trade.seller?.fullName || trade.seller?.username || 'Seller')}&apos;s terms &amp; conditions
                  </p>
                  <p className="text-sm text-text-primary whitespace-pre-wrap leading-relaxed">{trade.ad.terms}</p>
                </div>
              </div>
            )}
            {messages.length === 0 && (
              <p className="text-xs text-text-muted text-center py-4">No messages yet. Start chatting!</p>
            )}
            {messages.map((msg) => {
              const isMine = msg.senderId === user?.id
              // Resolve the human name behind this message's senderId. System
              // status messages carry the senderId of the actor who triggered
              // the step (buyer for "proof uploaded", seller for "confirmed"),
              // so they side + label by the real trader, never a generic brand.
              const senderName = isMine
                ? 'You'
                : msg.senderId === trade.buyerId
                  ? (trade.buyer?.fullName || trade.buyer?.username || 'Buyer')
                  : msg.senderId === trade.sellerId
                    ? (trade.seller?.fullName || trade.seller?.username || 'Seller')
                    : 'RupChain'
              const msgTime = new Date(msg.createdAt).toLocaleTimeString('en-PK', {
                timeZone: 'Asia/Karachi',
                hour: '2-digit',
                minute: '2-digit',
              })
              if (msg.isSystem) {
                return (
                  <div key={msg.id} className={`flex ${isMine ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[80%] px-3 py-2 rounded-2xl bg-surface border border-border shadow-sm ${isMine ? 'rounded-br-sm' : 'rounded-bl-sm'}`}>
                      <p className="flex items-center gap-1 text-[11px] font-semibold text-text-secondary mb-1">
                        <ShieldCheck size={12} className="flex-shrink-0" aria-hidden />
                        {senderName}
                      </p>
                      <p className="text-sm text-text-primary leading-relaxed break-words whitespace-pre-wrap">{msg.message}</p>
                      <p className="text-[10px] text-text-muted/60 mt-0.5">{msgTime}</p>
                    </div>
                  </div>
                )
              }
              const imageUrl = msg.imageUrl ?? (msg.message.startsWith('[image]') ? msg.message.slice(7) : null)
              return (
                <div key={msg.id} className={`flex ${isMine ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[75%] flex flex-col gap-0.5 ${isMine ? 'items-end' : 'items-start'}`}>
                    <span className="text-[11px] font-semibold text-text-secondary px-1">{senderName}</span>
                    {imageUrl ? (
                      <a href={imageUrl} target="_blank" rel="noopener noreferrer" className={`block rounded-2xl overflow-hidden border-2 shadow-sm ${isMine ? 'border-primary/30' : 'border-border'} ${msg.sendStatus === 'failed' ? 'opacity-60' : ''}`}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={imageUrl}
                          alt="Shared image"
                          className="max-w-[200px] max-h-[200px] object-cover"
                        />
                      </a>
                    ) : (
                      <div className={`px-3 py-2 rounded-2xl text-sm leading-relaxed break-words whitespace-pre-wrap ${
                        isMine
                          ? 'bg-primary text-white rounded-br-sm shadow-sm'
                          : 'bg-surface border border-border text-text-primary rounded-bl-sm shadow-sm'
                      } ${msg.sendStatus === 'failed' ? 'opacity-60' : ''}`}>
                        {msg.message}
                      </div>
                    )}
                    <span className="text-[10px] text-text-muted px-1">{msgTime}</span>
                    {isMine && msg.sendStatus === 'sending' && (
                      <span className="text-[10px] text-text-muted">Sending…</span>
                    )}
                    {isMine && msg.sendStatus === 'failed' && (
                      <button onClick={() => handleRetryMessage(msg.id)} className="text-[10px] text-danger hover:underline">
                        Failed — tap to retry
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
            <div ref={chatEndRef} />
          </div>

          {/* Send box */}
          <div className="px-3 py-3 border-t border-border flex gap-2 items-center">
            {/* Hidden image input */}
            <input
              ref={chatImageInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) { handleChatImageUpload(f); e.target.value = '' } }}
            />
            <button
              type="button"
              onClick={() => chatImageInputRef.current?.click()}
              disabled={uploadingChatImage || sendingMsg}
              aria-label="Attach image"
              className="flex-shrink-0 p-2 text-text-muted hover:text-primary hover:bg-primary/10 rounded-lg transition-colors disabled:opacity-40"
            >
              {uploadingChatImage ? (
                <span className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin block" />
              ) : (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              )}
            </button>
            <input
              type="text"
              value={messageInput}
              onChange={(e) => setMessageInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage() } }}
              placeholder="Type a message..."
              className="flex-1 min-w-0 px-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary bg-surface"
            />
            <Button size="sm" className="flex-shrink-0" loading={sendingMsg} onClick={handleSendMessage}>Send</Button>
          </div>
        </div>
      </div>

      {/* Modals */}
      <Modal isOpen={showCancelModal} onClose={() => { setShowCancelModal(false); setCancelReason('') }} title="Cancel Trade">
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">Are you sure you want to cancel this trade? This action cannot be undone.</p>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Reason (optional)</label>
            <textarea
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder="Tell the other party why you're cancelling..."
              rows={3}
              className="w-full px-3 py-2 text-sm border border-border rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
          <div className="flex gap-3">
            <Button variant="secondary" fullWidth onClick={() => { setShowCancelModal(false); setCancelReason('') }}>Keep Trade</Button>
            <Button variant="danger" fullWidth loading={actionLoading} disabled={actionLoading} onClick={handleCancel}>Cancel Trade</Button>
          </div>
        </div>
      </Modal>

      <ConfirmModal
        isOpen={showReleaseModal}
        onClose={() => setShowReleaseModal(false)}
        onConfirm={handleRelease}
        title="Confirm Crypto Received"
        description="Confirm that the crypto has arrived in your wallet. This marks the trade complete and cannot be reversed. If it hasn't arrived yet, don't confirm — open a dispute instead."
        confirmLabel="Confirm Received"
        confirmVariant="primary"
      />

    </div>
  )
}

// Resolves the buyer's chosen crypto-delivery method into a human label.
// Wallet/email/username have fixed labels; anything else is an exchange name
// (Binance / Bitget / Gate …) where the destination is a UID / deposit address.
function deliveryMethodLabel(method?: string, walletAddress?: string): string {
  const m = (method ?? '').toLowerCase()
  if (m === 'blockchain' || m === 'wallet_blockchain') return 'Wallet Address'
  if (m === 'email') return 'Email Transfer'
  if (m === 'username') return 'Username Transfer'
  if (method) return `${method} (UID / deposit address)`
  // Legacy trades stored no method but may carry a wallet address.
  return walletAddress ? 'Wallet Address' : 'Internal Wallet'
}

// Label for the destination row — makes clear, from each side's POV, where the
// crypto is going.
function deliveryDestinationLabel(method: string | undefined, isUserBuyer: boolean): string {
  const m = (method ?? '').toLowerCase()
  if (m === 'email') return isUserBuyer ? 'Your receiving email' : "Send to buyer's email"
  if (m === 'username') return isUserBuyer ? 'Your username' : "Send to buyer's username"
  const isExchange = !!method && !['blockchain', 'wallet_blockchain', 'email', 'username'].includes(m)
  if (isExchange) {
    return isUserBuyer ? `Your ${method} UID / deposit address` : `Send to buyer's ${method} UID / deposit address`
  }
  return isUserBuyer ? 'Your token receiving address' : "Send to buyer's wallet address"
}

function DetailRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={`flex justify-between gap-2 ${highlight ? 'bg-primary/5 border border-primary/20 rounded-lg px-2.5 py-1.5' : ''}`}>
      <span className={`flex-shrink-0 ${highlight ? 'text-text-primary font-semibold' : 'text-text-muted'}`}>{label}</span>
      <span className={`text-right break-words min-w-0 ${highlight ? 'text-primary font-bold text-base' : 'font-medium text-text-primary'}`}>{value}</span>
    </div>
  )
}

function PayToRow({ label, value, copy }: { label: string; value: string; copy?: boolean }) {
  return (
    <div className="flex justify-between items-center gap-2">
      <span className="text-text-muted flex-shrink-0">{label}</span>
      {/* Copy sits in FRONT of the value so a phone number reads "[copy] 0309…". */}
      <span className="inline-flex items-center gap-1.5 min-w-0 justify-end">
        {copy && <CopyButton text={value} size="sm" className="flex-shrink-0" />}
        <span className="font-medium text-text-primary text-right break-all">{value}</span>
      </span>
    </div>
  )
}

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
      <Button variant="danger" fullWidth onClick={onOpen}>
        Open Dispute
      </Button>
    )
  }

  const diff = Math.max(0, (unlockAt as number) - now)
  const m = Math.floor(diff / 60_000)
  const s = Math.floor((diff % 60_000) / 1_000)
  const formatted = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`

  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-text-secondary">Dispute available in</span>
        <span className="font-mono font-semibold text-sm text-text-primary">{formatted}</span>
      </div>
      <p className="text-xs text-text-muted leading-snug">
        Give your counterparty a moment to send or confirm. If the issue isn&apos;t
        resolved, you&apos;ll be able to open a dispute once the timer ends.
      </p>
      <Button variant="danger" fullWidth disabled>
        Open Dispute
      </Button>
    </div>
  )
}

// Honest release reminder. (There is intentionally no automatic auto-release of
// crypto_sent trades on the backend — only the buyer's confirmation or a dispute
// moves the trade forward — so we no longer promise a misleading auto-release.)
function ReleaseReminder() {
  return (
    <div className="bg-primary/5 border border-primary/20 rounded-lg px-3 py-2.5 flex items-start gap-2.5 text-xs">
      <svg className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <span className="text-text-secondary leading-snug">
        The seller is waiting for you to confirm. Only confirm{' '}
        <span className="font-semibold text-primary">after</span> you have verified the
        crypto arrived in your wallet. If it doesn&apos;t arrive, open a dispute instead of confirming.
      </span>
    </div>
  )
}
