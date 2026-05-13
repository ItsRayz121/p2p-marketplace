'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams } from 'next/navigation'
import { tradesApi } from '@/lib/api'
import type { Trade } from '@/lib/api'
import { useAuth } from '@/hooks/useAuth'
import { usePolling } from '@/hooks/usePolling'
import { useFileUpload } from '@/hooks/useFileUpload'
import { CountdownTimer } from '@/components/ui/CountdownTimer'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { ConfirmModal } from '@/components/ui/ConfirmModal'
import { Modal } from '@/components/ui/Modal'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'

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

// ─── Rating Modal ─────────────────────────────────────────────────────────────

const RATING_TAGS = ['Fast Payment', 'Good Communication', 'Smooth Trade', 'Trustworthy', 'Patient']

function RatingModal({
  isOpen, onClose, onSubmit,
}: {
  isOpen: boolean
  onClose: () => void
  onSubmit: (rating: number, comment: string, tags: string[]) => Promise<void>
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
    <Modal isOpen={isOpen} onClose={onClose} title="Rate this Trade">
      <div className="space-y-5">
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

        <div className="flex gap-3">
          <Button variant="secondary" fullWidth onClick={onClose}>Skip</Button>
          <Button fullWidth loading={submitting} onClick={handleSubmit}>Submit Rating</Button>
        </div>
      </div>
    </Modal>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function TradePage() {
  const { id } = useParams<{ id: string }>()
  const { user } = useAuth()

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
  const [showRatingModal, setShowRatingModal] = useState(false)
  const [ratedAlready, setRatedAlready] = useState(false)

  const [showDisputeForm, setShowDisputeForm] = useState(false)
  const [disputeReason, setDisputeReason] = useState('')
  const [showCryptoSentForm, setShowCryptoSentForm] = useState(false)
  const [txHash, setTxHash] = useState('')

  const chatEndRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { upload, uploading } = useFileUpload('payment-proof')

  const fetchTrade = useCallback(async () => {
    try {
      const [tradeData, messagesData] = await Promise.all([
        tradesApi.getTrade(id),
        tradesApi.getMessages(id),
      ])
      setTrade(tradeData as ExtendedTrade)
      setMessages(messagesData.messages)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load trade')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { fetchTrade() }, [fetchTrade])
  usePolling(fetchTrade, 10_000, !loading && !error)

  // Scroll chat to bottom
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Show rating modal after trade completes
  useEffect(() => {
    if (trade?.status === 'crypto_released' && !ratedAlready) {
      const timeout = setTimeout(() => setShowRatingModal(true), 1000)
      return () => clearTimeout(timeout)
    }
  }, [trade?.status, ratedAlready])

  const isUserBuyer = trade?.buyerId === user?.id

  // ── Actions ──────────────────────────────────────────────────────────────

  // Buyer: upload payment proof (payment_pending → payment_uploaded)
  const handleUploadProof = async (file: File) => {
    setActionError(null)
    try {
      const url = await upload(file)
      await tradesApi.uploadPaymentProof(id, url)
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
    setActionLoading(true)
    setActionError(null)
    try {
      await tradesApi.openDispute(id, { reason: disputeReason })
      await fetchTrade()
      setShowDisputeForm(false)
      setDisputeReason('')
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Dispute failed')
    } finally {
      setActionLoading(false)
    }
  }

  const handleSendMessage = async () => {
    if (!messageInput.trim() || sendingMsg) return
    setSendingMsg(true)
    try {
      await tradesApi.sendMessage(id, messageInput.trim())
      setMessageInput('')
      await fetchTrade()
    } catch { /* silently fail */ }
    finally { setSendingMsg(false) }
  }

  const handleRatingSubmit = async (rating: number, comment: string, tags: string[]) => {
    try {
      await tradesApi.rateTrade(id, { rating, comment: comment.trim() || undefined, tags: tags.length ? tags : undefined })
    } catch { /* non-critical */ }
    setRatedAlready(true)
    setShowRatingModal(false)
  }

  if (loading) return <LoadingState message="Loading trade..." />
  if (error || !trade) return <ErrorState title={error ?? 'Trade not found'} onRetry={fetchTrade} />

  const currentStep = stepIndex(trade.status)
  const canCancel = isUserBuyer && trade.status === 'payment_pending'
  const canDispute = ['payment_uploaded', 'payment_confirmed'].includes(trade.status)
  const counterparty = isUserBuyer
    ? (trade.seller?.username || 'Seller')
    : (trade.buyer?.username || 'Buyer')

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6 pb-24 lg:pb-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-xl font-bold text-text-primary">
            Trade with {counterparty}
          </h1>
          <p className="text-xs text-text-muted font-mono mt-0.5">{trade.id}</p>
        </div>
        <Badge variant={statusVariant(trade.status)}>
          {statusLabel(trade.status)}
        </Badge>
      </div>

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

          {/* Trade details */}
          <div className="bg-white rounded-xl border border-border p-5">
            <h2 className="text-sm font-semibold text-text-primary mb-3">Trade Details</h2>
            <div className="space-y-2 text-sm">
              <DetailRow label="Coin" value={`${parseFloat(trade.amount).toFixed(4)} ${trade.coin}`} />
              <DetailRow label="Price" value={`PKR ${Number(trade.price).toLocaleString()}`} />
              <DetailRow label="Total PKR" value={`PKR ${Number(trade.totalPkr).toLocaleString()}`} />
              <DetailRow label="Payment" value={trade.paymentMethod} />
            </div>
          </div>

          {/* Actions */}
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
                  placeholder="Enter transaction hash (txHash)"
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
                <textarea
                  value={disputeReason}
                  onChange={(e) => setDisputeReason(e.target.value)}
                  placeholder="Describe the issue..."
                  rows={3}
                  className="w-full px-3 py-2 text-sm border border-border rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-primary"
                />
                <div className="flex gap-2">
                  <Button variant="secondary" fullWidth onClick={() => setShowDisputeForm(false)}>Cancel</Button>
                  <Button variant="danger" fullWidth loading={actionLoading} onClick={handleOpenDispute}>
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

      <RatingModal
        isOpen={showRatingModal}
        onClose={() => setShowRatingModal(false)}
        onSubmit={handleRatingSubmit}
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
