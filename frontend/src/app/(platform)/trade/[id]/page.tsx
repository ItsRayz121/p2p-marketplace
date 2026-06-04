'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams } from 'next/navigation'
import NextImage from 'next/image'
import { tradesApi } from '@/lib/api'
import type { Trade } from '@/lib/api'
import { analytics } from '@/lib/analytics'
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
import type { TraderBadge } from '@/components/ui/TraderLevelCard'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { PK_MOBILE_METHODS } from '@/lib/pkPaymentMethods'
import { getTradeStatus } from '@/lib/tradeStatus'
import { isTrustedImageUrl } from '@/lib/utils'
import {
  FileText,
  Upload,
  CheckCheck,
  ArrowUpRight,
  CheckCircle2,
  CreditCard,
  Package,
  ShieldCheck,
  WifiOff,
  BadgeCheck,
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

const AUTO_RELEASE_HOURS = 2


interface ExtendedTrade extends Trade {
  paymentProofUrl?: string
  txHash?: string
  buyerRated?: boolean
  sellerRated?: boolean
  buyerDeliveryMethod?: string
  buyerDeliveryAddress?: string
  ratedByMe?: boolean
  txVerificationStatus?: string
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TIMELINE_STEPS = [
  { key: 'payment_pending',   label: 'Order Created',     Icon: FileText      },
  { key: 'payment_uploaded',  label: 'Proof Uploaded',    Icon: Upload        },
  { key: 'payment_confirmed', label: 'Payment Confirmed', Icon: CheckCheck    },
  { key: 'crypto_sent',       label: 'Crypto Sent',       Icon: ArrowUpRight  },
  { key: 'crypto_released',   label: 'Trade Complete',    Icon: CheckCircle2  },
]

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

function InlineRatingForm({ onSubmit, actionError }: {
  onSubmit: (rating: number, comment: string, tags: string[]) => Promise<void>
  actionError: string | null
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
      <Button fullWidth loading={submitting} onClick={handleSubmit}>Submit Rating</Button>
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
  return (
    <div className="bg-success/5 border border-success/20 rounded-xl p-6 mb-6 space-y-5">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-success/10 flex items-center justify-center">
          <CheckCircle2 size={22} className="text-success" aria-hidden />
        </div>
        <div>
          <h2 className="text-lg font-bold text-success">Trade Completed</h2>
          <p className="text-sm text-text-muted">Thank you for using RupChain.</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 text-sm">
        <div className="bg-surface rounded-lg border border-border p-3">
          <p className="text-text-muted text-xs mb-0.5">Token</p>
          <p className="font-semibold text-text-primary">{parseFloat(trade.amount).toFixed(4)} {trade.coin}</p>
        </div>
        <div className="bg-surface rounded-lg border border-border p-3">
          <p className="text-text-muted text-xs mb-0.5">Total PKR</p>
          <p className="font-semibold text-text-primary">PKR {Number(trade.fiatAmount ?? trade.totalPkr).toLocaleString()}</p>
        </div>
        <div className="bg-surface rounded-lg border border-border p-3">
          <p className="text-text-muted text-xs mb-0.5">Payment Method</p>
          <p className="font-semibold text-text-primary">{trade.paymentMethod}</p>
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
            <p className="text-sm font-semibold text-text-primary mb-3">Rate your experience with {counterparty}</p>
            <InlineRatingForm onSubmit={onRatingSubmit} actionError={actionError} />
          </>
        )}
      </div>
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

  const [openSections, setOpenSections] = useState({ timeline: true, payment: true, delivery: true })
  const toggleSection = (key: keyof typeof openSections) =>
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }))

  const paymentSectionRef = useRef<HTMLDivElement>(null)
  const deliverySectionRef = useRef<HTMLDivElement>(null)

  const handleStepClick = (stepKey: string) => {
    if (stepKey === 'payment_uploaded' || stepKey === 'payment_confirmed') {
      setOpenSections((prev) => ({ ...prev, payment: true }))
      setTimeout(() => paymentSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
    } else if (stepKey === 'crypto_sent' || stepKey === 'crypto_released') {
      setOpenSections((prev) => ({ ...prev, delivery: true }))
      setTimeout(() => deliverySectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
    }
  }

  // Mobile-only tab: at <lg the trade panel and chat stack vertically and the
  // page becomes a long scroll. Segmented control lets the user swap views.
  const [mobileTab, setMobileTab] = useState<'trade' | 'chat'>('trade')
  // Tracks how many messages the user had seen the last time they opened the
  // chat tab — drives the unread red dot on the Trade tab.
  const lastSeenChatCountRef = useRef(0)
  const [unreadChat, setUnreadChat] = useState(false)

  const chatEndRef = useRef<HTMLDivElement>(null)
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
      // user's bubble briefly vanish.
      setMessages((prev) => {
        const optimistic = prev.filter((m) => m.id.startsWith('tmp-'))
        const serverMessages: ChatMessage[] = Array.isArray(messagesData)
          ? (messagesData as ChatMessage[])
          : ((messagesData as { messages: ChatMessage[] }).messages ?? [])
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
    } catch (err) {
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
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setActionLoading(false)
    }
  }

  // Seller: mark crypto sent (payment_confirmed → crypto_sent)
  const handleMarkCryptoSent = async () => {
    if (!txHash.trim()) return
    setActionLoading(true)
    setActionError(null)
    try {
      await tradesApi.markCryptoSent(id, txHash.trim())
      await fetchTrade()
      setShowCryptoSentForm(false)
      setTxHash('')
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setActionLoading(false)
    }
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
    } catch (err) {
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
      await fetchTrade()
      setShowDisputeForm(false)
      setDisputeReason('')
      setDisputeDescription('')
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Dispute failed')
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
    setMessages((prev) => prev.map((m) => m.id === failedId ? { ...m, sendStatus: 'sending' } : m))
    try {
      const msg = await tradesApi.sendMessage(id, failed.message)
      setMessages((prev) =>
        prev.map((m) => m.id === failedId
          ? { id: msg.id, senderId: user?.id ?? '', message: failed.message, createdAt: msg.createdAt }
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
      // Send the image URL as a chat message with a special prefix so the UI can render it
      const tempId = `tmp-img-${Date.now()}`
      const optimistic: ChatMessage = {
        id: tempId,
        senderId: user?.id ?? '',
        message: '',
        imageUrl: url,
        createdAt: new Date().toISOString(),
        sendStatus: 'sending',
      }
      setMessages((prev) => [...prev, optimistic])
      setSendingMsg(true)
      try {
        const msg = await tradesApi.sendMessage(id, `[image]${url}`)
        setMessages((prev) =>
          prev.map((m) =>
            m.id === tempId
              ? { id: msg.id, senderId: user?.id ?? '', message: `[image]${url}`, imageUrl: url, createdAt: msg.createdAt }
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
  const canCancel = isUserBuyer && trade.status === 'payment_pending'
  const canDispute = ['payment_uploaded', 'payment_confirmed'].includes(trade.status)
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

      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <UserAvatar name={counterparty} avatarUrl={counterpartyUser?.avatarUrl} size="md" />
            <h1 className="text-xl font-bold text-text-primary">
              Trade with {counterparty}
            </h1>
            <BadgeChip badge={counterpartyBadge} />
          </div>
          <div className="flex items-center gap-3 mt-1 flex-wrap">
            <p className="text-xs text-text-muted font-mono">{trade.id}</p>
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
          </div>
        </div>
        {(() => {
          const s = getTradeStatus(trade.status)
          return <Badge variant={s.variant} icon={s.icon}>{s.label}</Badge>
        })()}
      </div>

      {/* Trade protection banner — only on active trades */}
      {!['crypto_released', 'cancelled', 'expired', 'disputed'].includes(trade.status) && (
        <div className="mb-4 flex items-start gap-3 rounded-xl bg-primary/5 border border-primary/15 px-4 py-3">
          <ShieldCheck size={16} className="text-primary flex-shrink-0 mt-0.5" aria-hidden />
          <p className="text-sm text-primary/90">
            RupChain monitors this trade and protects both parties. Only confirm receipt after you have verified payment.
          </p>
        </div>
      )}

      {/* Completed card */}
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
        {/* Left: status + actions */}
        <div className={`space-y-5 ${mobileTab === 'chat' ? 'hidden lg:block' : ''}`}>
          {/* Countdown */}
          {trade.expiresAt && trade.status === 'payment_pending' && (
            <div className="bg-warning/10 border border-warning/20 rounded-xl p-4 flex items-center gap-3">
              <svg className="w-5 h-5 text-warning flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div>
                <p className="text-sm font-medium text-warning">Payment window</p>
                <CountdownTimer expiresAt={trade.expiresAt} />
              </div>
            </div>
          )}

          {/* Timeline */}
          <div className="bg-surface rounded-xl border border-border shadow-card">
            <button
              onClick={() => toggleSection('timeline')}
              className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-surface-alt/50 transition-colors rounded-xl"
            >
              <h2 className="text-sm font-semibold text-text-primary">Trade Progress</h2>
              <svg className={`w-4 h-4 text-text-muted transition-transform duration-200 ${openSections.timeline ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {openSections.timeline && (
              <div className="px-5 pb-5">
                {TIMELINE_STEPS.map((step, idx) => {
                  const done    = idx < currentStep
                  const active  = idx === currentStep
                  const last    = idx === TIMELINE_STEPS.length - 1
                  const clickable = done && (
                    step.key === 'payment_uploaded' ||
                    step.key === 'payment_confirmed' ||
                    step.key === 'crypto_sent' ||
                    step.key === 'crypto_released'
                  )
                  const { Icon } = step
                  return (
                    <div
                      key={step.key}
                      onClick={() => done && handleStepClick(step.key)}
                      className={`flex gap-3 ${clickable ? 'cursor-pointer group' : ''}`}
                    >
                      {/* Spine column */}
                      <div className="flex flex-col items-center flex-shrink-0">
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 transition-all ${
                          done
                            ? 'bg-success text-white'
                            : active
                            ? 'bg-primary text-white ring-4 ring-primary/15'
                            : 'bg-surface-alt text-text-muted border border-border'
                        } ${clickable ? 'group-hover:scale-105' : ''}`}>
                          <Icon size={14} aria-hidden />
                        </div>
                        {!last && (
                          <div className={`w-px flex-1 my-1 min-h-[20px] ${
                            done ? 'bg-success/40' : 'bg-border'
                          }`} />
                        )}
                      </div>

                      {/* Label */}
                      <div className={`flex-1 flex items-center justify-between min-h-[32px] ${last ? 'pb-0' : 'pb-4'}`}>
                        <span className={`text-sm ${
                          active ? 'font-semibold text-text-primary'
                          : done  ? 'text-success font-medium'
                          :         'text-text-muted'
                        }`}>
                          {step.label}
                        </span>
                        {active && (
                          <span className="text-xs font-medium text-primary bg-primary/10 px-2 py-0.5 rounded-full">
                            Current
                          </span>
                        )}
                        {done && clickable && (
                          <svg className="w-3.5 h-3.5 text-success/40 group-hover:text-success transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                          </svg>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Payment Settlement */}
          <div ref={paymentSectionRef} className="bg-surface rounded-xl border border-border shadow-card">
            <button
              onClick={() => toggleSection('payment')}
              className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-surface-alt/50 transition-colors rounded-xl"
            >
              <div className="flex items-center gap-2">
                <CreditCard size={16} className="text-text-muted flex-shrink-0" aria-hidden />
                <h2 className="text-sm font-semibold text-text-primary">
                  {isUserBuyer ? 'You are sending PKR payment' : 'Awaiting PKR payment from buyer'}
                </h2>
              </div>
              <svg className={`w-4 h-4 text-text-muted transition-transform duration-200 flex-shrink-0 ml-2 ${openSections.payment ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {openSections.payment && (
              <div className="px-5 pb-5 space-y-2 text-sm">
                <DetailRow label="Amount" value={`${parseFloat(trade.amount).toFixed(4)} ${trade.coin}`} />
                <DetailRow label="Price" value={`PKR ${Number(trade.price).toLocaleString()}`} />
                <DetailRow label="Total PKR" value={`PKR ${Number(trade.fiatAmount ?? trade.totalPkr).toLocaleString()}`} />
                <div className="flex justify-between">
                  <span className="text-text-muted">Pay via</span>
                  <span className="inline-flex items-center gap-1.5 font-medium text-text-primary">
                    <EntityLogo
                      type={PK_MOBILE_METHODS.includes(trade.paymentMethod) ? 'payment_method' : 'bank'}
                      slug={trade.paymentMethod}
                      size="xs"
                      className="flex-shrink-0"
                    />
                    {trade.paymentMethod}
                  </span>
                </div>
                {trade.paymentProofUrl && (
                  <div className="pt-3 border-t border-border">
                    <p className="text-xs text-text-muted mb-2">Payment Proof</p>
                    {isTrustedImageUrl(trade.paymentProofUrl) ? (
                      <a href={trade.paymentProofUrl} target="_blank" rel="noopener noreferrer">
                        <NextImage
                          src={trade.paymentProofUrl}
                          alt="Payment proof"
                          width={320}
                          height={240}
                          className="rounded-lg border border-border hover:opacity-90 transition-opacity cursor-pointer object-cover"
                          referrerPolicy="no-referrer"
                          unoptimized
                        />
                      </a>
                    ) : (
                      <div className="bg-warning/10 border border-warning/20 rounded-lg px-3 py-2 text-xs text-warning">
                        Payment proof URL is from an untrusted source and cannot be displayed.
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Token Delivery */}
          <div ref={deliverySectionRef} className="bg-surface rounded-xl border border-border shadow-card">
            <button
              onClick={() => toggleSection('delivery')}
              className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-surface-alt/50 transition-colors rounded-xl"
            >
              <div className="flex items-center gap-2">
                <Package size={16} className="text-text-muted flex-shrink-0" aria-hidden />
                <h2 className="text-sm font-semibold text-text-primary">Token Delivery</h2>
              </div>
              <svg className={`w-4 h-4 text-text-muted transition-transform duration-200 flex-shrink-0 ml-2 ${openSections.delivery ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {openSections.delivery && (
              <div className="px-5 pb-5 space-y-2 text-sm">
                <DetailRow label="Network" value={trade.network ?? trade.coin} />
                {trade.buyerDeliveryMethod ? (
                  <>
                    <DetailRow
                      label="Method"
                      value={
                        trade.buyerDeliveryMethod === 'blockchain' ? 'Wallet Address'
                        : trade.buyerDeliveryMethod === 'email' ? 'Email Transfer'
                        : trade.buyerDeliveryMethod === 'username' ? 'Username Transfer'
                        : 'Internal Wallet'
                      }
                    />
                    {trade.buyerDeliveryAddress && (
                      <div className="flex justify-between items-start gap-2">
                        <span className="text-text-muted flex-shrink-0">
                          {isUserBuyer ? 'Your token receiving address' : "Buyer's token receiving address"}
                        </span>
                        <span className="font-medium text-text-primary text-right break-all font-mono text-xs">{trade.buyerDeliveryAddress}</span>
                      </div>
                    )}
                  </>
                ) : (
                  trade.buyerWalletAddress ? (
                    <div className="flex justify-between items-start gap-2">
                      <span className="text-text-muted flex-shrink-0">
                        {isUserBuyer ? 'Your token receiving address' : "Buyer's token receiving address"}
                      </span>
                      <span className="font-medium text-text-primary text-right break-all font-mono text-xs">{trade.buyerWalletAddress}</span>
                    </div>
                  ) : (
                    <p className="text-xs text-text-muted">Delivery details not specified.</p>
                  )
                )}
                {trade.sellerTxHash && (
                  <div className="flex flex-col gap-1">
                    <div className="flex justify-between items-start gap-2">
                      <span className="text-text-muted flex-shrink-0">Transaction Hash</span>
                      <div className="flex flex-col items-end gap-1">
                        <span className="font-medium text-text-primary text-right break-all font-mono text-xs">{trade.sellerTxHash}</span>
                        {trade.txVerificationStatus === 'verified' && (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-green-600 bg-green-50 border border-green-200 rounded px-2 py-0.5">
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                            On-chain verified
                          </span>
                        )}
                        {trade.txVerificationStatus === 'pending' && (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-yellow-700 bg-yellow-50 border border-yellow-200 rounded px-2 py-0.5">
                            ⏳ Confirming on-chain
                          </span>
                        )}
                        {(trade.txVerificationStatus === 'skipped' || trade.txVerificationStatus === 'rpc_error') && (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-text-muted bg-surface border border-border rounded px-2 py-0.5">
                            ⚠ Verify manually on explorer
                          </span>
                        )}
                        {trade.txVerificationStatus === 'not_found' && (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-orange-700 bg-orange-50 border border-orange-200 rounded px-2 py-0.5">
                            ⚠ Tx not found — pending or invalid
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Actions — hidden for completed trades */}
          {trade.status !== 'crypto_released' && (
          <div className="bg-surface rounded-xl border border-border shadow-card p-5 space-y-3">
            <h2 className="text-sm font-semibold text-text-primary mb-1">Actions</h2>

            {/* Buyer: upload payment proof (payment_pending) */}
            {isUserBuyer && trade.status === 'payment_pending' && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUploadProof(f) }}
                />
                <Button
                  fullWidth
                  loading={uploading}
                  disabled={uploading || actionLoading}
                  onClick={() => fileInputRef.current?.click()}
                >
                  Upload Payment Proof
                </Button>
              </>
            )}

            {/* Seller: confirm payment received (payment_uploaded) */}
            {!isUserBuyer && trade.status === 'payment_uploaded' && (
              <Button fullWidth loading={actionLoading} disabled={actionLoading} onClick={handleConfirmPayment}>
                Confirm Payment Received
              </Button>
            )}

            {/* Seller: mark crypto sent (payment_confirmed) */}
            {!isUserBuyer && trade.status === 'payment_confirmed' && !showCryptoSentForm && (
              <Button fullWidth onClick={() => setShowCryptoSentForm(true)}>
                I&apos;ve Sent the Crypto
              </Button>
            )}

            {showCryptoSentForm && !isUserBuyer && (
              <div className="space-y-3">
                <p className="text-xs text-text-muted">Enter the exact blockchain transaction hash for the transfer you sent to the buyer&apos;s wallet. The system will verify the transaction on-chain.</p>
                <input
                  type="text"
                  value={txHash}
                  onChange={(e) => setTxHash(e.target.value)}
                  placeholder="Paste the blockchain transaction hash (e.g. 0xabc123…)"
                  className="w-full px-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary font-mono"
                />
                <div className="flex gap-2">
                  <Button variant="secondary" fullWidth onClick={() => setShowCryptoSentForm(false)}>Cancel</Button>
                  <Button fullWidth loading={actionLoading} disabled={!txHash.trim() || actionLoading} onClick={handleMarkCryptoSent}>
                    Confirm Sent
                  </Button>
                </div>
              </div>
            )}

            {/* Buyer: release escrow (crypto_sent) */}
            {isUserBuyer && trade.status === 'crypto_sent' && (
              <>
                <AutoReleaseCountdown updatedAt={trade.updatedAt} hoursWindow={AUTO_RELEASE_HOURS} />
                {trade.txVerificationStatus && trade.txVerificationStatus !== 'verified' && (
                  <p className="text-xs text-yellow-700 bg-yellow-50 border border-yellow-200 rounded p-2">
                    ⚠ The transaction hash has not been independently verified on-chain. Please check the explorer link before releasing.
                  </p>
                )}
                <Button fullWidth loading={actionLoading} disabled={actionLoading} onClick={() => setShowReleaseModal(true)}>
                  I Received the Crypto — Release
                </Button>
              </>
            )}

            {/* Dispute */}
            {canDispute && !showDisputeForm && (
              <Button variant="danger" fullWidth onClick={() => setShowDisputeForm(true)}>
                Open Dispute
              </Button>
            )}

            {showDisputeForm && (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-text-primary mb-1">Reason</label>
                  <select
                    value={disputeReason}
                    onChange={(e) => setDisputeReason(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-danger"
                  >
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
                  <textarea
                    value={disputeDescription}
                    onChange={(e) => setDisputeDescription(e.target.value)}
                    placeholder="Explain what happened in detail. Include any evidence or timeline of events..."
                    rows={4}
                    className="w-full px-3 py-2 text-sm border border-border rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-danger"
                  />
                </div>
                <div className="flex gap-2">
                  <Button variant="secondary" fullWidth onClick={() => { setShowDisputeForm(false); setDisputeReason(''); setDisputeDescription('') }}>Cancel</Button>
                  <Button variant="danger" fullWidth loading={actionLoading} disabled={!disputeReason || disputeDescription.trim().length < 10} onClick={handleOpenDispute}>
                    Submit Dispute
                  </Button>
                </div>
              </div>
            )}

            {/* Cancel */}
            {canCancel && (
              <Button variant="ghost" fullWidth onClick={() => setShowCancelModal(true)}>
                Cancel Trade
              </Button>
            )}

            {actionError && (
              <p className="text-sm text-danger bg-danger/10 rounded-lg px-3 py-2">{actionError}</p>
            )}
          </div>
          )}
        </div>

        {/* Right: Chat — display class is conditional so `flex` and `hidden`
            never coexist in the class list (which is ambiguous in Tailwind). */}
        <div className={`bg-surface rounded-xl border border-border shadow-card flex-col ${mobileTab === 'trade' ? 'hidden lg:flex' : 'flex'}`} style={{ minHeight: '400px', maxHeight: '600px' }}>
          <div className="px-4 py-3 border-b border-border">
            <h2 className="text-sm font-semibold text-text-primary">Chat with {counterparty}</h2>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.length === 0 && (
              <p className="text-xs text-text-muted text-center py-4">No messages yet. Start chatting!</p>
            )}
            {messages.map((msg) => {
              const isMine = msg.senderId === user?.id
              const msgTime = new Date(msg.createdAt).toLocaleTimeString('en-PK', {
                timeZone: 'Asia/Karachi',
                hour: '2-digit',
                minute: '2-digit',
              })
              if (msg.isSystem) {
                return (
                  <div key={msg.id} className="flex justify-center my-1">
                    <div className="bg-surface border border-border rounded-xl px-3 py-1.5 text-center max-w-[85%]">
                      <p className="text-xs text-text-muted italic">{msg.message}</p>
                      <p className="text-[10px] text-text-muted/60 mt-0.5">{msgTime}</p>
                    </div>
                  </div>
                )
              }
              const imageUrl = msg.imageUrl ?? (msg.message.startsWith('[image]') ? msg.message.slice(7) : null)
              return (
                <div key={msg.id} className={`flex ${isMine ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[75%] flex flex-col gap-0.5 ${isMine ? 'items-end' : 'items-start'}`}>
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
                      <div className={`px-3 py-2 rounded-2xl text-sm leading-relaxed ${
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
              className="flex-1 px-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary bg-surface"
            />
            <Button size="sm" loading={sendingMsg} onClick={handleSendMessage}>Send</Button>
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
        title="Release Crypto"
        description="Confirm that you have received the payment. Once released, crypto will be sent to the buyer and this action cannot be reversed."
        confirmLabel="Release Crypto"
        confirmVariant="primary"
      />

    </div>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-text-muted">{label}</span>
      <span className="font-medium text-text-primary">{value}</span>
    </div>
  )
}

function AutoReleaseCountdown({ updatedAt, hoursWindow }: { updatedAt: string; hoursWindow: number }) {
  const [remaining, setRemaining] = useState('')

  useEffect(() => {
    const releaseAt = new Date(updatedAt).getTime() + hoursWindow * 3_600_000

    function tick() {
      const diff = releaseAt - Date.now()
      if (diff <= 0) {
        setRemaining('shortly')
        return
      }
      const h = Math.floor(diff / 3_600_000)
      const m = Math.floor((diff % 3_600_000) / 60_000)
      const s = Math.floor((diff % 60_000) / 1_000)
      setRemaining(h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`)
    }

    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [updatedAt, hoursWindow])

  return (
    <div className="bg-primary/5 border border-primary/20 rounded-lg px-3 py-2.5 flex items-start gap-2.5 text-xs">
      <svg className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <span className="text-text-secondary leading-snug">
        If you don&apos;t confirm or dispute within{' '}
        <span className="font-bold text-primary">{remaining}</span>, the escrow
        will auto-release to the seller.
        Only confirm after verifying you received the crypto.
      </span>
    </div>
  )
}
