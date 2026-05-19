'use client'
import { useState, use, useRef, useEffect } from 'react'
import { ctmApi } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'
import { useAuthStore } from '@/store/auth.store'

const STATUS_STEPS = ['awaiting_payment', 'payment_uploaded', 'payment_confirmed', 'seller_transferring', 'proof_submitted', 'completed']
const STATUS_LABELS: Record<string, string> = {
  awaiting_payment: 'Awaiting Payment',
  payment_uploaded: 'Payment Uploaded',
  payment_confirmed: 'Payment Confirmed',
  seller_transferring: 'Seller Transferring',
  proof_submitted: 'Proof Submitted',
  buyer_confirming: 'Confirming Receipt',
  completed: 'Completed',
  cancelled: 'Cancelled',
  disputed: 'Disputed',
  dispute_resolved: 'Dispute Resolved',
  expired: 'Expired',
}

const DISPUTE_REASONS = ['proof_fake', 'not_received', 'amount_mismatch', 'wrong_token', 'seller_unresponsive', 'buyer_unresponsive', 'other']

interface Trade {
  id: string; tradeRef: string; status: string
  tokenAmount: string; fiatAmount: string; pricePerUnit: string; paymentMethod: string
  settlementMethod: string; settlementNote: string; buyerSettlementId?: string
  expiresAt: string; confirmDeadlineAt?: string; proofDeadlineAt?: string
  token: { name: string; symbol: string; logoUrl?: string; riskTier: string }
  buyer: { id: string; username: string }
  seller: { id: string; username: string }
  proofs: Array<{ id: string; proofType: string; fileUrl?: string; txHash?: string; uploadedBy: string; description?: string; createdAt: string }>
  dispute?: { id: string; reason: string; description: string; status: string; resolution?: string; winner?: string }
}

interface Message { id: string; senderId: string; message: string; createdAt: string }

function Countdown({ deadline }: { deadline: string }) {
  const [diff, setDiff] = useState(new Date(deadline).getTime() - Date.now())
  useEffect(() => {
    const t = setInterval(() => setDiff(new Date(deadline).getTime() - Date.now()), 1000)
    return () => clearInterval(t)
  }, [deadline])
  if (diff <= 0) return <span className="text-red-600 font-bold">Expired</span>
  const h = Math.floor(diff / 3600000); const m = Math.floor((diff % 3600000) / 60000); const s = Math.floor((diff % 60000) / 1000)
  return <span className="font-mono font-bold text-primary">{h > 0 ? `${h}:` : ''}{String(m).padStart(2, '0')}:{String(s).padStart(2, '0')}</span>
}

export default function CtmTradeRoomPage({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = use(params)
  const { user } = useAuthStore()
  const [trade, setTrade] = useState<Trade | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)
  const [msgText, setMsgText] = useState('')
  const [sendingMsg, setSendingMsg] = useState(false)
  const [actionLoading, setActionLoading] = useState(false)
  const [proofFile, setProofFile] = useState<File | null>(null)
  const [disputeOpen, setDisputeOpen] = useState(false)
  const [disputeReason, setDisputeReason] = useState('')
  const [disputeDesc, setDisputeDesc] = useState('')
  const [ratingOpen, setRatingOpen] = useState(false)
  const [rating, setRating] = useState(5)
  const [ratingComment, setRatingComment] = useState('')
  const [error, setError] = useState('')
  const chatEndRef = useRef<HTMLDivElement>(null)

  const fetchTrade = async () => {
    try {
      const res = await ctmApi.getTrade(ref)
      setTrade(res as Trade)
    } catch { /* ignore */ } finally { setLoading(false) }
  }

  const fetchMessages = async () => {
    try {
      const res = await ctmApi.getMessages(ref)
      setMessages(res as Message[])
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    } catch { /* ignore */ }
  }

  usePolling(fetchTrade, 15000)
  usePolling(fetchMessages, 10000)

  if (loading) return <div className="max-w-5xl mx-auto px-4 py-12 animate-pulse"><div className="bg-white rounded-xl h-96 border border-border" /></div>
  if (!trade) return <div className="max-w-5xl mx-auto px-4 py-12 text-center text-text-muted">Trade not found.</div>

  const isBuyer = user?.id === trade.buyer.id
  const isSeller = user?.id === trade.seller.id
  const stepIndex = STATUS_STEPS.indexOf(trade.status)

  const doAction = async (fn: () => Promise<unknown>) => {
    setError(''); setActionLoading(true)
    try { await fn(); await fetchTrade() }
    catch (e: unknown) { setError((e as Error).message ?? 'Action failed') }
    finally { setActionLoading(false) }
  }

  const handleUploadProof = async (folder: 'payment' | 'token') => {
    if (!proofFile) { setError('Select a file first'); return }
    setError(''); setActionLoading(true)
    try {
      const fd = new FormData(); fd.append('file', proofFile)
      if (folder === 'payment') await ctmApi.uploadPaymentProof(ref, fd)
      else await ctmApi.uploadTokenProof(ref, fd)
      setProofFile(null); await fetchTrade()
    } catch (e: unknown) { setError((e as Error).message ?? 'Upload failed') }
    finally { setActionLoading(false) }
  }

  const handleSendMessage = async () => {
    if (!msgText.trim()) return
    setSendingMsg(true)
    try { await ctmApi.sendMessage(ref, { message: msgText }); setMsgText(''); await fetchMessages() }
    catch { /* ignore */ } finally { setSendingMsg(false) }
  }

  const handleOpenDispute = async () => {
    if (!disputeReason || !disputeDesc) { setError('Fill in dispute reason and description'); return }
    await doAction(() => ctmApi.openDispute(ref, { reason: disputeReason, description: disputeDesc }))
    setDisputeOpen(false)
  }

  const handleRate = async () => {
    await doAction(() => ctmApi.rateTrade(ref, { rating, comment: ratingComment || undefined }))
    setRatingOpen(false)
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Left: Trade panel */}
        <div className="lg:col-span-3 space-y-4">
          {/* Header */}
          <div className="bg-white border border-border rounded-xl p-5">
            <div className="flex items-start justify-between gap-3 mb-4">
              <div>
                <h1 className="font-bold text-text-primary text-lg">{trade.tokenAmount} {trade.token.symbol}</h1>
                <p className="text-text-muted text-sm">PKR {Number(trade.fiatAmount).toLocaleString()} · #{trade.tradeRef.slice(-8)}</p>
              </div>
              <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${trade.status === 'completed' ? 'bg-green-100 text-green-700' : trade.status === 'disputed' ? 'bg-red-100 text-red-700' : 'bg-yellow-100 text-yellow-800'}`}>
                {STATUS_LABELS[trade.status] ?? trade.status}
              </span>
            </div>

            {/* Countdown */}
            {trade.status !== 'completed' && trade.status !== 'cancelled' && trade.status !== 'expired' && (
              <div className="bg-surface rounded-xl p-3 text-sm flex items-center justify-between">
                <span className="text-text-muted">
                  {trade.confirmDeadlineAt ? 'Confirm by:' : trade.proofDeadlineAt ? 'Deadline:' : 'Expires:'}
                </span>
                <Countdown deadline={trade.confirmDeadlineAt ?? trade.proofDeadlineAt ?? trade.expiresAt} />
              </div>
            )}

            {/* Progress steps */}
            <div className="flex items-center gap-1 mt-4 overflow-x-auto pb-1">
              {STATUS_STEPS.map((s, i) => (
                <div key={s} className="flex items-center gap-1 flex-shrink-0">
                  <div className={`w-6 h-6 rounded-full text-xs flex items-center justify-center font-bold ${i < stepIndex ? 'bg-green-500 text-white' : i === stepIndex ? 'bg-primary text-white' : 'bg-gray-100 text-gray-400'}`}>{i + 1}</div>
                  {i < STATUS_STEPS.length - 1 && <div className={`w-6 h-0.5 ${i < stepIndex ? 'bg-green-500' : 'bg-gray-200'}`} />}
                </div>
              ))}
            </div>
          </div>

          {/* Settlement info */}
          <div className="bg-white border border-border rounded-xl p-5">
            <h2 className="font-semibold text-text-primary mb-3">Settlement Info</h2>
            <div className="text-sm space-y-2 text-text-muted">
              <div className="flex justify-between"><span>Payment via:</span><span className="text-text-primary font-medium">{trade.paymentMethod}</span></div>
              <div className="flex justify-between"><span>Settlement method:</span><span className="text-text-primary font-medium">{trade.settlementMethod}</span></div>
              {trade.buyerSettlementId && <div className="flex justify-between"><span>Buyer&apos;s ID:</span><span className="text-text-primary font-medium">{trade.buyerSettlementId}</span></div>}
            </div>
            <div className="mt-3 bg-surface rounded-xl p-3 text-sm text-text-muted">{trade.settlementNote}</div>
          </div>

          {/* Proofs */}
          {trade.proofs.length > 0 && (
            <div className="bg-white border border-border rounded-xl p-5 space-y-3">
              <h2 className="font-semibold text-text-primary">Proofs</h2>
              {trade.proofs.map((p) => (
                <div key={p.id} className="border border-border rounded-xl p-3">
                  <p className="text-xs text-text-muted mb-2">{p.proofType} · {new Date(p.createdAt).toLocaleString()}</p>
                  {p.fileUrl && <img src={p.fileUrl} alt="proof" className="max-h-48 rounded-lg object-contain border border-border" />}
                  {p.txHash && <p className="text-xs font-mono text-text-primary break-all">{p.txHash}</p>}
                  {p.description && <p className="text-xs text-text-muted mt-1">{p.description}</p>}
                </div>
              ))}
            </div>
          )}

          {/* Error */}
          {error && <div className="bg-red-50 text-red-700 border border-red-200 rounded-xl p-3 text-sm">{error}</div>}

          {/* Actions */}
          <div className="bg-white border border-border rounded-xl p-5 space-y-3">
            <h2 className="font-semibold text-text-primary">Actions</h2>

            {/* Buyer actions */}
            {isBuyer && trade.status === 'awaiting_payment' && (
              <div className="space-y-2">
                <input type="file" accept="image/*" onChange={(e) => setProofFile(e.target.files?.[0] ?? null)} className="w-full border border-border rounded-xl p-2 text-sm" />
                <button onClick={() => handleUploadProof('payment')} disabled={actionLoading || !proofFile} className="w-full bg-primary text-white py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60 hover:bg-primary/90">
                  {actionLoading ? 'Uploading…' : 'Upload Payment Proof'}
                </button>
                <button onClick={() => doAction(() => ctmApi.cancelTrade(ref, { reason: 'Cancelled by buyer' }))} disabled={actionLoading} className="w-full border border-red-200 text-red-600 py-2 rounded-xl text-sm hover:bg-red-50">Cancel Trade</button>
              </div>
            )}
            {isBuyer && trade.status === 'proof_submitted' && (
              <button onClick={() => doAction(() => ctmApi.confirmReceipt(ref))} disabled={actionLoading} className="w-full bg-green-600 text-white py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60">
                {actionLoading ? '…' : 'Confirm Token Received'}
              </button>
            )}
            {isBuyer && trade.status === 'completed' && !ratingOpen && (
              <button onClick={() => setRatingOpen(true)} className="w-full border border-primary text-primary py-2.5 rounded-xl text-sm font-semibold hover:bg-primary/5">Rate This Trade</button>
            )}

            {/* Seller actions */}
            {isSeller && trade.status === 'payment_uploaded' && (
              <button onClick={() => doAction(() => ctmApi.confirmPayment(ref))} disabled={actionLoading} className="w-full bg-primary text-white py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60">
                {actionLoading ? '…' : 'Confirm Payment Received'}
              </button>
            )}
            {isSeller && trade.status === 'payment_confirmed' && (
              <button onClick={() => doAction(() => ctmApi.markTransferring(ref))} disabled={actionLoading} className="w-full bg-primary text-white py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60">
                {actionLoading ? '…' : 'Mark: I am Sending Tokens'}
              </button>
            )}
            {isSeller && trade.status === 'seller_transferring' && (
              <div className="space-y-2">
                <input type="file" accept="image/*" onChange={(e) => setProofFile(e.target.files?.[0] ?? null)} className="w-full border border-border rounded-xl p-2 text-sm" />
                <button onClick={() => handleUploadProof('token')} disabled={actionLoading || !proofFile} className="w-full bg-primary text-white py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60">
                  {actionLoading ? 'Uploading…' : 'Upload Token Transfer Proof'}
                </button>
              </div>
            )}

            {/* Dispute button */}
            {(isBuyer || isSeller) && ['payment_confirmed', 'seller_transferring', 'proof_submitted', 'buyer_confirming'].includes(trade.status) && !trade.dispute && (
              <button onClick={() => setDisputeOpen(true)} className="w-full border border-red-200 text-red-600 py-2 rounded-xl text-sm hover:bg-red-50">Open Dispute</button>
            )}

            {/* Dispute info */}
            {trade.dispute && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm">
                <p className="font-semibold text-red-800 mb-1">Dispute Open: {trade.dispute.reason.replace(/_/g, ' ')}</p>
                <p className="text-red-700">{trade.dispute.description}</p>
                {trade.dispute.resolution && <p className="mt-2 text-green-700 font-medium">Resolution: {trade.dispute.resolution}</p>}
              </div>
            )}
          </div>

          {/* Rating modal */}
          {ratingOpen && (
            <div className="bg-white border border-border rounded-xl p-5 space-y-3">
              <h2 className="font-semibold text-text-primary">Rate this trade</h2>
              <div className="flex gap-2">
                {[1, 2, 3, 4, 5].map((s) => (
                  <button key={s} onClick={() => setRating(s)} className={`text-2xl ${s <= rating ? 'text-yellow-400' : 'text-gray-200'}`}>★</button>
                ))}
              </div>
              <textarea rows={2} placeholder="Comment (optional)" value={ratingComment} onChange={(e) => setRatingComment(e.target.value)} className="w-full border border-border rounded-xl px-3 py-2 text-sm focus:outline-none resize-none" />
              <div className="flex gap-2">
                <button onClick={() => setRatingOpen(false)} className="flex-1 border border-border py-2 rounded-xl text-sm">Skip</button>
                <button onClick={handleRate} disabled={actionLoading} className="flex-1 bg-primary text-white py-2 rounded-xl text-sm font-semibold disabled:opacity-60">Submit</button>
              </div>
            </div>
          )}
        </div>

        {/* Right: Chat */}
        <div className="lg:col-span-2 flex flex-col bg-white border border-border rounded-xl overflow-hidden" style={{ maxHeight: '70vh' }}>
          <div className="p-4 border-b border-border font-semibold text-text-primary text-sm">
            Chat — {trade.buyer.username} & {trade.seller.username}
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.map((m) => {
              const isMe = m.senderId === user?.id
              return (
                <div key={m.id} className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[80%] px-3 py-2 rounded-xl text-sm ${isMe ? 'bg-primary text-white' : 'bg-surface text-text-primary'}`}>
                    <p>{m.message}</p>
                    <p className={`text-xs mt-1 ${isMe ? 'text-primary-foreground/70' : 'text-text-muted'}`}>{new Date(m.createdAt).toLocaleTimeString()}</p>
                  </div>
                </div>
              )
            })}
            <div ref={chatEndRef} />
          </div>
          <div className="p-3 border-t border-border flex gap-2">
            <input
              type="text" value={msgText} onChange={(e) => setMsgText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage() } }}
              placeholder="Type a message…" className="flex-1 border border-border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
            <button onClick={handleSendMessage} disabled={sendingMsg || !msgText.trim()} className="bg-primary text-white px-4 py-2 rounded-xl text-sm font-semibold disabled:opacity-60">Send</button>
          </div>
        </div>
      </div>

      {/* Dispute modal */}
      {disputeOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-md p-6 space-y-4">
            <h3 className="font-bold text-lg text-text-primary">Open Dispute</h3>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">Reason</label>
              <select value={disputeReason} onChange={(e) => setDisputeReason(e.target.value)} className="w-full border border-border rounded-xl px-3 py-2.5 text-sm bg-white focus:outline-none">
                <option value="">Select reason</option>
                {DISPUTE_REASONS.map((r) => <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">Description</label>
              <textarea rows={4} value={disputeDesc} onChange={(e) => setDisputeDesc(e.target.value)} className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none resize-none" placeholder="Describe the issue in detail…" />
            </div>
            <div className="flex gap-3">
              <button onClick={() => setDisputeOpen(false)} className="flex-1 border border-border py-2.5 rounded-xl text-sm font-medium">Cancel</button>
              <button onClick={handleOpenDispute} disabled={actionLoading} className="flex-1 bg-red-600 text-white py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60">Open Dispute</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
