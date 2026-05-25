'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams } from 'next/navigation'
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
import type { TraderBadge } from '@/components/ui/TraderLevelCard'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { PK_MOBILE_METHODS } from '@/lib/pkPaymentMethods'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChatMessage {
  id: string
  senderId: string
  message: string
  isSystem?: boolean
  createdAt: string
}

interface ExtendedTrade extends Trade {
  paymentProofUrl?: string
  txHash?: string
  buyerRated?: boolean
  sellerRated?: boolean
  buyerDeliveryMethod?: string
  buyerDeliveryAddress?: string
  ratedByMe?: boolean
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TIMELINE_STEPS = [
  { key: 'payment_pending', label: 'Order Created', icon: '📋' },
  { key: 'payment_uploaded', label: 'Proof Uploaded', icon: '💳' },
  { key: 'payment_confirmed', label: 'Payment Confirmed', icon: '✔️' },
  { key: 'crypto_sent', label: 'Crypto Sent', icon: '🚀' },
  { key: 'crypto_released', label: 'Trade Complete', icon: '✅' },
]

function stepIndex(status: string): number {
  if (status === 'payment_pending') return 0
  if (status === 'payment_uploaded') return 1
  if (status === 'payment_confirmed') return 2
  if (status === 'crypto_sent') return 3
  if (status === 'crypto_released') return 4
  return 0
}

function statusVariant(status: string): 'success' | 'warning' | 'danger' | 'default' {
  if (status === 'crypto_released') return 'success'
  if (['payment_uploaded', 'payment_confirmed', 'crypto_sent'].includes(status)) return 'warning'
  if (['disputed', 'cancelled', 'expired'].includes(status)) return 'danger'
  return 'default'
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    payment_pending: 'Awaiting Payment',
    payment_uploaded: 'Proof Uploaded',
    payment_confirmed: 'Payment Confirmed',
    crypto_sent: 'Crypto Sent',
    crypto_released: 'Completed',
    disputed: 'Disputed',
    cancelled: 'Cancelled',
    expired: 'Expired',
  }
  return labels[status] ?? status
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
        <div className="flex gap-2">
          {[1, 2, 3, 4, 5].map((star) => (
            <button
              key={star}
              onClick={() => setRating(star)}
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
        <div className="w-10 h-10 rounded-full bg-success/10 flex items-center justify-center text-xl">✅</div>
        <div>
          <h2 className="text-lg font-bold text-success">Trade Completed!</h2>
          <p className="text-sm text-text-muted">Thank you for using PakSwap.</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 text-sm">
        <div className="bg-white rounded-lg border border-border p-3">
          <p className="text-text-muted text-xs mb-0.5">Token</p>
          <p className="font-semibold text-text-primary">{parseFloat(trade.amount).toFixed(4)} {trade.coin}</p>
        </div>
        <div className="bg-white rounded-lg border border-border p-3">
          <p className="text-text-muted text-xs mb-0.5">Total PKR</p>
          <p className="font-semibold text-text-primary">PKR {Number(trade.fiatAmount ?? trade.totalPkr).toLocaleString()}</p>
        </div>
        <div className="bg-white rounded-lg border border-border p-3">
          <p className="text-text-muted text-xs mb-0.5">Payment Method</p>
          <p className="font-semibold text-text-primary">{trade.paymentMethod}</p>
        </div>
        <div className="bg-white rounded-lg border border-border p-3">
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

  const chatEndRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const prevMsgCountRef = useRef(0)
  const { upload, uploading } = useFileUpload('payment-proof')

  const fetchTrade = useCallback(async () => {
    try {
      const [tradeData, messagesData] = await Promise.all([
        tradesApi.getTrade(id),
        tradesApi.getMessages(id),
      ])
      const extended = tradeData as ExtendedTrade
      setTrade(extended)
      if (extended.ratedByMe) setRatedAlready(true)
      setMessages(messagesData.messages)
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
    setSendingMsg(true)
    setMessageInput('')
    try {
      const msg = await tradesApi.sendMessage(id, text)
      setMessages((prev) => [
        ...prev,
        { id: msg.id, senderId: user?.id ?? '', message: text, createdAt: msg.createdAt },
      ])
    } catch (err) {
      setMessageInput(text) // restore so user can retry
      setActionError(err instanceof Error ? err.message : 'Failed to send message')
    } finally {
      setSendingMsg(false)
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
  const counterparty = counterpartyUser?.username || (isUserBuyer ? 'Seller' : 'Buyer')
  const counterpartyBadge = (counterpartyUser?.tradeStats?.badge ?? 'new') as TraderBadge
  const counterpartyStats = counterpartyUser?.tradeStats

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6 pb-24 lg:pb-6">
      {/* L-6: Offline banner — warn user that actions won't go through */}
      {isOffline && (
        <div className="mb-4 flex items-center gap-3 rounded-lg bg-danger/10 border border-danger/30 px-4 py-3 text-sm text-danger">
          <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 5.636a9 9 0 010 12.728M15.536 8.464a5 5 0 010 7.072M12 12h.01M8.464 15.536a5 5 0 01-.001-7.072M5.636 18.364a9 9 0 010-12.728" />
          </svg>
          <span>You are offline. Trade actions will not go through until your connection is restored.</span>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-xl font-bold text-text-primary">
              Trade with {counterparty}
            </h1>
            <BadgeChip badge={counterpartyBadge} />
          </div>
          <div className="flex items-center gap-3 mt-1">
            <p className="text-xs text-text-muted font-mono">{trade.id}</p>
            {counterpartyStats && (
              <span className="text-xs text-text-muted">
                {counterpartyStats.completedTrades} trades · {((Number(counterpartyStats.completionRate) ?? 0) * 100).toFixed(0)}% completion
              </span>
            )}
          </div>
        </div>
        <Badge variant={statusVariant(trade.status)}>
          {statusLabel(trade.status)}
        </Badge>
      </div>

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

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Left: status + actions */}
        <div className="space-y-5">
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
          <div className="bg-white rounded-xl border border-border p-5">
            <h2 className="text-sm font-semibold text-text-primary mb-4">Trade Progress</h2>
            <div className="space-y-4">
              {TIMELINE_STEPS.map((step, idx) => {
                const done = idx < currentStep
                const active = idx === currentStep
                return (
                  <div key={step.key} className="flex items-center gap-3">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm flex-shrink-0 ${
                      done ? 'bg-success text-white' : active ? 'bg-primary text-white' : 'bg-surface text-text-muted border border-border'
                    }`}>
                      {done ? '✓' : step.icon}
                    </div>
                    <span className={`text-sm ${active ? 'font-semibold text-text-primary' : done ? 'text-success' : 'text-text-muted'}`}>
                      {step.label}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Payment Settlement */}
          <div className="bg-white rounded-xl border border-border p-5">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-base">💳</span>
              <h2 className="text-sm font-semibold text-text-primary">
                {isUserBuyer ? 'You are sending PKR payment' : 'Awaiting PKR payment from buyer'}
              </h2>
            </div>
            <div className="space-y-2 text-sm">
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
            </div>
            {/* Payment proof thumbnail */}
            {trade.paymentProofUrl && (
              <div className="mt-3 pt-3 border-t border-border">
                <p className="text-xs text-text-muted mb-2">Payment Proof</p>
                <a href={trade.paymentProofUrl} target="_blank" rel="noopener noreferrer">
                  <img
                    src={trade.paymentProofUrl}
                    alt="Payment proof"
                    className="w-full max-w-xs rounded-lg border border-border hover:opacity-90 transition-opacity cursor-pointer"
                  />
                </a>
              </div>
            )}
          </div>

          {/* Token Delivery */}
          <div className="bg-white rounded-xl border border-border p-5">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-base">📦</span>
              <h2 className="text-sm font-semibold text-text-primary">Token Delivery</h2>
            </div>
            <div className="space-y-2 text-sm">
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
                /* Legacy: show buyerWalletAddress if delivery fields not set */
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
                <div className="flex justify-between items-start gap-2">
                  <span className="text-text-muted flex-shrink-0">Transaction Hash</span>
                  <span className="font-medium text-text-primary text-right break-all font-mono text-xs">{trade.sellerTxHash}</span>
                </div>
              )}
            </div>
          </div>

          {/* Actions — hidden for completed trades (CompletedTradeCard handles the final state) */}
          {trade.status !== 'crypto_released' && (
          <div className="bg-white rounded-xl border border-border p-5 space-y-3">
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
              <Button fullWidth loading={actionLoading} disabled={actionLoading} onClick={() => setShowReleaseModal(true)}>
                I Received the Crypto — Release
              </Button>
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
                    className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-danger"
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

        {/* Right: Chat */}
        <div className="bg-white rounded-xl border border-border flex flex-col" style={{ minHeight: '400px', maxHeight: '600px' }}>
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
              if (msg.isSystem) {
                return (
                  <div key={msg.id} className="text-center">
                    <span className="text-xs text-text-muted italic bg-surface px-3 py-1 rounded-full">{msg.message}</span>
                  </div>
                )
              }
              return (
                <div key={msg.id} className={`flex ${isMine ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[75%] px-3 py-2 rounded-2xl text-sm ${
                    isMine ? 'bg-primary text-white rounded-br-sm' : 'bg-surface text-text-primary rounded-bl-sm'
                  }`}>
                    {msg.message}
                  </div>
                </div>
              )
            })}
            <div ref={chatEndRef} />
          </div>

          {/* Send box */}
          <div className="px-3 py-3 border-t border-border flex gap-2">
            <input
              type="text"
              value={messageInput}
              onChange={(e) => setMessageInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage() } }}
              placeholder="Type a message..."
              className="flex-1 px-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary bg-white"
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
