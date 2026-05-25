'use client'
import { useState, use, useRef, useEffect, useCallback } from 'react'
import { ctmApi } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'
import { useSSE } from '@/hooks/useSSE'
import { useAuth } from '@/hooks/useAuth'

const STATUS_STEPS = ['awaiting_payment', 'payment_uploaded', 'payment_confirmed', 'seller_transferring', 'proof_submitted', 'completed']

type Role = 'buyer' | 'seller' | 'admin'

// Role-aware status labels. Buyer and seller see actionable phrasing for the
// same underlying state ("send payment" vs "waiting for buyer payment").
function statusLabelForRole(status: string, role: Role): string {
  const map: Record<string, Record<Role, string>> = {
    awaiting_payment: {
      buyer: 'Action required: send payment',
      seller: 'Waiting for buyer payment',
      admin: 'Awaiting buyer payment',
    },
    payment_uploaded: {
      buyer: 'Waiting for seller to confirm',
      seller: 'Action required: review payment proof',
      admin: 'Awaiting seller confirmation',
    },
    payment_confirmed: {
      buyer: 'Waiting for seller to send tokens',
      seller: 'Action required: send tokens',
      admin: 'Awaiting token transfer',
    },
    seller_transferring: {
      buyer: 'Tokens being sent',
      seller: 'Submit transfer proof',
      admin: 'Tokens in transit',
    },
    proof_submitted: {
      buyer: 'Action required: confirm receipt',
      seller: 'Waiting for buyer confirmation',
      admin: 'Awaiting buyer confirmation',
    },
    buyer_confirming: {
      buyer: 'Action required: confirm receipt',
      seller: 'Waiting for buyer confirmation',
      admin: 'Awaiting buyer confirmation',
    },
    completed: { buyer: 'Completed', seller: 'Completed', admin: 'Completed' },
    cancelled: { buyer: 'Cancelled', seller: 'Cancelled', admin: 'Cancelled' },
    disputed: { buyer: 'Disputed', seller: 'Disputed', admin: 'Disputed' },
    dispute_resolved: { buyer: 'Dispute resolved', seller: 'Dispute resolved', admin: 'Dispute resolved' },
    expired: { buyer: 'Expired', seller: 'Expired', admin: 'Expired' },
  }
  return map[status]?.[role] ?? status
}

const STEP_INFO = [
  { label: 'Trade Started', actor: null },
  { label: 'Payment Sent', actor: 'Buyer' },
  { label: 'Payment Confirmed', actor: 'Seller' },
  { label: 'Tokens Sent', actor: 'Seller' },
  { label: 'Tokens Received', actor: 'Buyer' },
  { label: 'Completed', actor: null },
]

const DISPUTE_REASONS = ['proof_fake', 'not_received', 'amount_mismatch', 'wrong_token', 'seller_unresponsive', 'buyer_unresponsive', 'other']

// Supports {hash} template (e.g. https://explorer.example.com/tx/{hash}).
// If no placeholder is provided, append /tx/{hash} (the canonical path on
// every supported chain explorer). Appending bare /{hash} produced 404s.
function buildExplorerUrl(baseUrl: string, txHash: string): string {
  if (baseUrl.includes('{hash}')) return baseUrl.replace('{hash}', txHash)
  return `${baseUrl.replace(/\/$/, '')}/tx/${txHash}`
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

interface SellerPaymentSnapshot {
  type: string; label: string; accountName: string
  mobileNumber?: string; bankName?: string; ibanNumber?: string; accountNumber?: string
}

interface Trade {
  id: string; tradeRef: string; status: string
  tokenAmount: string; fiatAmount: string; pricePerUnit: string; paymentMethod: string
  settlementMethod: string; settlementNote: string; buyerSettlementId?: string
  sellerPaymentSnapshot?: SellerPaymentSnapshot
  tokenDeliveryType?: string; settlementType: string
  expiresAt: string; confirmDeadlineAt?: string; proofDeadlineAt?: string
  escrowAddress?: string; escrowAmount?: string; escrowCurrency?: string
  escrowTxHash?: string; escrowConfirmedAt?: string
  token: { name: string; symbol: string; logoUrl?: string; riskTier: string; explorerUrl?: string }
  buyer: { id: string; username: string }
  seller: { id: string; username: string }
  listing?: { side: string }
  proofs: Array<{ id: string; proofType: string; fileUrl?: string; txHash?: string; uploadedBy: string; description?: string; createdAt: string }>
  dispute?: { id: string; reason: string; description: string; status: string; resolution?: string; winner?: string }
  ratings: Array<{ ratedByUserId: string; ratedUserId: string; rating: number; comment?: string | null }>
  ratedByMe?: boolean
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
  const { user } = useAuth()
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
  const [txHash, setTxHash] = useState('')
  const [ratingOpen, setRatingOpen] = useState(false)
  const [rating, setRating] = useState(5)
  const [ratingComment, setRatingComment] = useState('')
  const [ratingError, setRatingError] = useState('')
  const [platformRating, setPlatformRating] = useState(5)
  const [platformComment, setPlatformComment] = useState('')
  const [platformRatingDone, setPlatformRatingDone] = useState(false)
  const [traderRatingDone, setTraderRatingDone] = useState(false)
  const [error, setError] = useState('')
  const chatEndRef = useRef<HTMLDivElement>(null)
  const prevMsgCountRef = useRef(0)

  const fetchTrade = useCallback(async () => {
    try {
      const res = await ctmApi.getTrade(ref) as Trade
      if (!Array.isArray(res.ratings)) res.ratings = []
      setTrade(res)
      // ratedByMe is reflected in trade.ratings after fetch
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

  // Polling as fallback; SSE triggers immediate refresh on trade events.
  // Gated on !loading so we don't double-fetch during initial mount.
  usePolling(fetchTrade, 30_000, !loading)
  usePolling(fetchMessages, 15_000, !loading)

  useSSE((event) => {
    if (event.type === 'notification') {
      const payload = event.payload as { metadata?: { tradeRef?: string; tradeId?: string } } | undefined
      const matchesRef = payload?.metadata?.tradeRef === ref
      const matchesId = payload?.metadata?.tradeId === ref
      if (matchesRef || matchesId) {
        void fetchTrade()
        void fetchMessages()
      }
    }
  })

  if (loading) return <div className="max-w-5xl mx-auto px-4 py-12 animate-pulse"><div className="bg-white rounded-xl h-96 border border-border" /></div>
  if (!trade) return <div className="max-w-5xl mx-auto px-4 py-12 text-center text-text-muted">Trade not found.</div>

  const isBuyer = user?.id === trade.buyer.id
  const isSeller = user?.id === trade.seller.id
  const stepIndex = STATUS_STEPS.indexOf(trade.status)

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
    if (hashRequired && !txHash.trim()) { setError('Transaction hash is required for blockchain token transfers'); return }
    if (!txHash.trim() && !proofFile) { setError('Enter a transfer reference or upload a screenshot'); return }
    setError(''); setActionLoading(true)
    try {
      if (proofFile) {
        const fd = new FormData()
        if (txHash.trim()) fd.append('txHash', txHash.trim())
        fd.append('proofType', txHash.trim() ? 'txhash' : 'screenshot')
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
    try { await ctmApi.sendMessage(ref, { message: msgText }); setMsgText(''); await fetchMessages() }
    catch { /* ignore */ } finally { setSendingMsg(false) }
  }

  const handleOpenDispute = async () => {
    if (!disputeReason || !disputeDesc) { setError('Fill in dispute reason and description'); return }
    await doAction(() => ctmApi.openDispute(ref, { reason: disputeReason, description: disputeDesc }))
    setDisputeOpen(false)
  }

  const handleRate = async () => {
    setRatingError('')
    try {
      await ctmApi.rateTrade(ref, { rating, comment: ratingComment || undefined })
      setTraderRatingDone(true)
      // Keep panel open so user can also rate the platform
    } catch (e: unknown) {
      setRatingError((e as Error).message ?? 'Failed to submit rating')
    }
  }

  const handlePlatformRate = () => {
    setPlatformRatingDone(true)
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Left: Trade panel */}
        <div className="lg:col-span-3 space-y-4">

          {/* ── Header + Progress ── */}
          <div className="bg-white border border-border rounded-xl p-5">
            <div className="flex items-start justify-between gap-3 mb-4">
              <div>
                <h1 className="font-bold text-text-primary text-lg">{trade.tokenAmount} {trade.token.symbol}</h1>
                <p className="text-text-muted text-sm">PKR {Number(trade.fiatAmount).toLocaleString()} · #{trade.tradeRef.slice(-8)}</p>
              </div>
              <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${trade.status === 'completed' ? 'bg-green-100 text-green-700' : trade.status === 'disputed' ? 'bg-red-100 text-red-700' : 'bg-yellow-100 text-yellow-800'}`}>
                {statusLabelForRole(trade.status, isBuyer ? 'buyer' : isSeller ? 'seller' : 'admin')}
              </span>
            </div>

            {trade.status !== 'completed' && trade.status !== 'cancelled' && trade.status !== 'expired' && (
              <div className="bg-surface rounded-xl p-3 text-sm flex items-center justify-between mb-4">
                <span className="text-text-muted">
                  {trade.confirmDeadlineAt ? 'Confirm by:' : trade.proofDeadlineAt ? 'Deadline:' : 'Expires:'}
                </span>
                <Countdown deadline={trade.confirmDeadlineAt ?? trade.proofDeadlineAt ?? trade.expiresAt} />
              </div>
            )}

            <div className="overflow-x-auto pb-2">
              <div className="flex items-start min-w-max">
                {STATUS_STEPS.map((s, i) => (
                  <div key={s} className="flex items-start">
                    <div className="flex flex-col items-center">
                      <div className={`w-7 h-7 rounded-full text-xs flex items-center justify-center font-bold flex-shrink-0 ${i < stepIndex ? 'bg-green-500 text-white' : i === stepIndex ? 'bg-primary text-white' : 'bg-gray-100 text-gray-400'}`}>
                        {i < stepIndex ? '✓' : i + 1}
                      </div>
                      <div className="mt-1.5 w-16 text-center">
                        <p className={`text-[10px] leading-tight ${i === stepIndex ? 'text-primary font-semibold' : i < stepIndex ? 'text-green-600 font-medium' : 'text-gray-400'}`}>
                          {STEP_INFO[i].label}
                        </p>
                        {STEP_INFO[i].actor && (
                          <span className={`text-[9px] mt-0.5 inline-block px-1 py-0.5 rounded font-medium ${i <= stepIndex ? (STEP_INFO[i].actor === 'Buyer' ? 'bg-blue-100 text-blue-600' : 'bg-orange-100 text-orange-600') : 'bg-gray-100 text-gray-400'}`}>
                            {STEP_INFO[i].actor}
                          </span>
                        )}
                      </div>
                    </div>
                    {i < STATUS_STEPS.length - 1 && (
                      <div className={`h-0.5 w-8 mt-3.5 flex-shrink-0 ${i < stepIndex ? 'bg-green-500' : 'bg-gray-200'}`} />
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* ── Order Summary ── */}
          {(() => {
            const totalPkr = Number(trade.fiatAmount)
            const price = Number(trade.pricePerUnit)
            const tokens = Number(trade.tokenAmount)
            // TODO: platform fee is stored (platformFeePkr) but not yet auto-deducted; hidden from UI until collection is automated
            return (
              <div className="bg-white border border-border rounded-xl p-5">
                <h2 className="font-semibold text-text-primary mb-3">Order Summary</h2>
                <div className="bg-surface rounded-xl p-3 space-y-1.5 text-sm">
                  <Row label="Token price" value={`PKR ${price.toLocaleString()}`} />
                  <Row label="Token quantity" value={`${tokens.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${trade.token.symbol}`} />
                  <Row label="Payment method" value={trade.sellerPaymentSnapshot?.label ?? trade.paymentMethod} />
                  <div className="border-t border-border pt-1.5 mt-1">
                    <Row label={isBuyer ? 'Total payable' : 'Total receivable'} value={`PKR ${totalPkr.toLocaleString(undefined, { maximumFractionDigits: 2 })}`} />
                  </div>
                </div>
              </div>
            )
          })()}

          {/* ── Payment Details ── */}
          <div className="bg-white border border-border rounded-xl p-5">
            <h2 className="font-semibold text-text-primary mb-3">
              {isBuyer ? 'Seller Payment Details' : 'Your Payment Details'}
            </h2>
            <p className="text-xs text-text-muted mb-2">
              {isBuyer
                ? `Send PKR ${Number(trade.fiatAmount).toLocaleString()} to the following seller account.`
                : `You will receive PKR ${Number(trade.fiatAmount).toLocaleString()} from the buyer to this account.`}
            </p>
            {trade.sellerPaymentSnapshot ? (
              <div className="bg-surface rounded-xl p-3 space-y-1.5 text-sm">
                <Row label="Method" value={trade.sellerPaymentSnapshot.label} />
                <Row label="Account Name" value={trade.sellerPaymentSnapshot.accountName} copyable />
                {trade.sellerPaymentSnapshot.mobileNumber && <Row label="Account / Payment Number" value={trade.sellerPaymentSnapshot.mobileNumber} mono copyable />}
                {trade.sellerPaymentSnapshot.bankName && <Row label="Bank" value={trade.sellerPaymentSnapshot.bankName} />}
                {trade.sellerPaymentSnapshot.ibanNumber && <Row label="IBAN" value={trade.sellerPaymentSnapshot.ibanNumber} mono breakAll copyable />}
                {trade.sellerPaymentSnapshot.accountNumber && !trade.sellerPaymentSnapshot.ibanNumber && (
                  <Row label="Account No." value={trade.sellerPaymentSnapshot.accountNumber} mono copyable />
                )}
              </div>
            ) : (
              <div className="bg-surface rounded-xl p-3 text-sm text-text-muted">
                Payment via: <span className="font-medium text-text-primary">{trade.paymentMethod}</span>
              </div>
            )}

            {/* Payment proofs inline */}
            {paymentProofs.length > 0 && (
              <div className="mt-3 space-y-2">
                <p className="text-xs font-medium text-text-muted">Payment Proof</p>
                {paymentProofs.map((p) => (
                  <div key={p.id} className="border border-border rounded-xl p-3">
                    <p className="text-xs text-text-muted mb-2">{new Date(p.createdAt).toLocaleString()}</p>
                    {p.fileUrl && <img src={p.fileUrl} alt="payment proof" className="max-h-40 rounded-lg object-contain border border-border" />}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Token Delivery ── */}
          <div className="bg-white border border-border rounded-xl p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-semibold text-text-primary">
                {isBuyer ? 'Your Token Receiving Details' : 'Token Delivery Required'}
              </h2>
              <span className="text-xs px-2 py-0.5 rounded-full bg-surface text-text-muted font-medium">
                {settlementLabel(trade.settlementType)}
              </span>
            </div>

            <div className="bg-surface rounded-xl p-3 space-y-1.5 text-sm mb-3">
              {(trade.buyerSettlementId || trade.settlementMethod) && (
                <Row
                  label={isSeller ? 'Send tokens to' : 'Your receiving address'}
                  value={trade.buyerSettlementId ?? trade.settlementMethod}
                  mono breakAll copyable
                />
              )}
              <Row label="Amount" value={`${trade.tokenAmount} ${trade.token.symbol}`} />
            </div>

            {trade.settlementNote && (
              <div className="mb-3 bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm">
                <p className="font-medium text-amber-800 mb-1">Transfer instructions:</p>
                <p className="text-amber-700">{trade.settlementNote}</p>
              </div>
            )}

            {/* Token transfer proof — shown once submitted */}
            {tokenProofs.length > 0 && (
              <div className="mt-1 space-y-2">
                <p className="text-xs font-medium text-text-muted">Token Transfer Proof</p>
                {tokenProofs.map((p) => (
                  <div key={p.id} className="border border-border rounded-xl p-3 space-y-2">
                    <p className="text-xs text-text-muted">{new Date(p.createdAt).toLocaleString()}</p>
                    {p.txHash && (
                      <div className="bg-surface rounded-lg p-2.5 space-y-1.5">
                        <p className="text-xs text-text-muted font-medium">{proofHashLabel(trade.settlementType)}</p>
                        <CopyableText value={p.txHash} mono />
                        {trade.token.explorerUrl && (
                          <a
                            href={buildExplorerUrl(trade.token.explorerUrl, p.txHash)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-primary font-medium hover:underline"
                          >
                            View on Explorer →
                          </a>
                        )}
                      </div>
                    )}
                    {p.fileUrl && (
                      <img src={p.fileUrl} alt="token transfer proof" className="max-h-40 rounded-lg object-contain border border-border" />
                    )}
                    {p.description && <p className="text-xs text-text-muted">{p.description}</p>}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Error banner ── */}
          {error && <div className="bg-red-50 text-red-700 border border-red-200 rounded-xl p-3 text-sm">{error}</div>}

          {/* ── Dispute info ── */}
          {trade.dispute && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm">
              <p className="font-semibold text-red-800 mb-1">Dispute Open: {trade.dispute.reason.replace(/_/g, ' ')}</p>
              <p className="text-red-700">{trade.dispute.description}</p>
              {trade.dispute.resolution && <p className="mt-2 text-green-700 font-medium">Resolution: {trade.dispute.resolution}</p>}
            </div>
          )}

          {/* ── Actions ── */}
          <div className="bg-white border border-border rounded-xl p-5 space-y-3">
            <h2 className="font-semibold text-text-primary">Actions</h2>

            {/* ─ BUYER: awaiting_payment with escrow ─ */}
            {isBuyer && trade.status === 'awaiting_payment' && trade.settlementType === 'ON_CHAIN' && trade.escrowAddress && (
              <div className="space-y-3">
                <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 space-y-2">
                  <p className="text-sm font-semibold text-blue-800">Send USDT to Escrow Address</p>
                  <div className="bg-white rounded-lg border border-blue-200 p-2">
                    <p className="text-xs text-text-muted mb-1">Escrow Address ({trade.escrowCurrency ?? 'USDT_TRC20'})</p>
                    <p className="font-mono text-xs text-text-primary break-all select-all">{trade.escrowAddress}</p>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-blue-700">Amount required:</span>
                    <span className="font-bold text-blue-900">{trade.escrowAmount ? `PKR ${Number(trade.escrowAmount).toLocaleString()}` : `PKR ${Number(trade.fiatAmount).toLocaleString()}`}</span>
                  </div>
                  {trade.escrowConfirmedAt
                    ? <p className="text-xs text-green-700 font-medium">Deposit confirmed — trade is progressing.</p>
                    : <p className="text-xs text-blue-600">Send exact amount. Deposit auto-confirms within 5 minutes.</p>
                  }
                </div>
                <div>
                  <p className="text-xs text-text-muted mb-1.5">Or upload deposit screenshot as proof:</p>
                  <input type="file" accept="image/*" onChange={(e) => setProofFile(e.target.files?.[0] ?? null)} className="w-full border border-border rounded-xl p-2 text-sm" />
                  <button onClick={handleUploadPaymentProof} disabled={actionLoading || !proofFile} className="w-full mt-2 bg-primary text-white py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60 hover:bg-primary/90">
                    {actionLoading ? 'Uploading…' : 'Upload Deposit Screenshot'}
                  </button>
                </div>
                <button onClick={() => doAction(() => ctmApi.cancelTrade(ref, { reason: 'Cancelled by buyer' }))} disabled={actionLoading} className="w-full border border-red-200 text-red-600 py-2 rounded-xl text-sm hover:bg-red-50">Cancel Trade</button>
              </div>
            )}

            {/* ─ BUYER: awaiting_payment (manual) ─ */}
            {isBuyer && trade.status === 'awaiting_payment' && !(trade.settlementType === 'ON_CHAIN' && trade.escrowAddress) && (
              <div className="space-y-2">
                <p className="text-xs text-text-muted">Upload screenshot of your PKR payment as proof.</p>
                <input type="file" accept="image/*" onChange={(e) => setProofFile(e.target.files?.[0] ?? null)} className="w-full border border-border rounded-xl p-2 text-sm" />
                <button onClick={handleUploadPaymentProof} disabled={actionLoading || !proofFile} className="w-full bg-primary text-white py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60 hover:bg-primary/90">
                  {actionLoading ? 'Uploading…' : 'Upload Payment Proof'}
                </button>
                <button onClick={() => doAction(() => ctmApi.cancelTrade(ref, { reason: 'Cancelled by buyer' }))} disabled={actionLoading} className="w-full border border-red-200 text-red-600 py-2 rounded-xl text-sm hover:bg-red-50">Cancel Trade</button>
              </div>
            )}

            {/* ─ BUYER: payment_uploaded — waiting for seller ─ */}
            {isBuyer && trade.status === 'payment_uploaded' && (
              <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4 text-sm">
                <p className="font-semibold text-yellow-800 mb-1">Payment proof submitted</p>
                <p className="text-yellow-700">Waiting for seller to confirm they received your payment. This usually takes a few minutes.</p>
              </div>
            )}

            {/* ─ BUYER: payment_confirmed — waiting for seller to send tokens ─ */}
            {isBuyer && trade.status === 'payment_confirmed' && (
              <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm">
                <p className="font-semibold text-blue-800 mb-1">Payment confirmed by seller</p>
                <p className="text-blue-700">Seller is now sending your {trade.token.symbol} tokens to your address. Please wait.</p>
              </div>
            )}

            {/* ─ BUYER: seller_transferring — waiting for proof ─ */}
            {isBuyer && trade.status === 'seller_transferring' && (
              <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm">
                <p className="font-semibold text-blue-800 mb-1">Seller is transferring tokens</p>
                <p className="text-blue-700">Seller has started the transfer. They will upload proof shortly. Check your wallet.</p>
              </div>
            )}

            {/* ─ BUYER: proof_submitted — verify and confirm ─ */}
            {isBuyer && trade.status === 'proof_submitted' && (
              <div className="space-y-3">
                <div className="bg-green-50 border border-green-200 rounded-xl p-4 space-y-3">
                  <p className="font-semibold text-green-800">Seller has submitted transfer proof</p>
                  <p className="text-xs text-green-700">Check your wallet / account for the incoming tokens, then confirm below.</p>

                  {/* Delivery summary */}
                  <div className="bg-white rounded-lg border border-green-200 p-3 space-y-1.5 text-sm">
                    <p className="text-xs font-semibold text-text-muted mb-2">Delivery Summary</p>
                    <Row label="Token" value={`${trade.tokenAmount} ${trade.token.symbol}`} />
                    <Row label="Method" value={settlementLabel(trade.settlementType)} />
                    {(trade.buyerSettlementId || trade.settlementMethod) && (
                      <Row label="Your address" value={trade.buyerSettlementId ?? trade.settlementMethod} mono breakAll />
                    )}
                  </div>

                  {/* Transfer proof inline */}
                  {latestTokenProof && (
                    <div className="bg-white rounded-lg border border-green-200 p-3 space-y-2">
                      <p className="text-xs font-semibold text-text-muted">Transfer Proof from Seller</p>
                      {latestTokenProof.txHash && (
                        <div className="space-y-1">
                          <p className="text-xs text-text-muted">{proofHashLabel(trade.settlementType)}</p>
                          <p className="text-xs font-mono text-text-primary break-all">{latestTokenProof.txHash}</p>
                          {trade.token.explorerUrl && (
                            <a
                              href={buildExplorerUrl(trade.token.explorerUrl, latestTokenProof.txHash)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-xs text-primary font-semibold hover:underline"
                            >
                              Verify on Blockchain Explorer →
                            </a>
                          )}
                        </div>
                      )}
                      {latestTokenProof.fileUrl && (
                        <img src={latestTokenProof.fileUrl} alt="token transfer proof" className="max-h-40 rounded-lg object-contain border border-border" />
                      )}
                    </div>
                  )}
                </div>

                <button onClick={() => doAction(() => ctmApi.confirmReceipt(ref))} disabled={actionLoading} className="w-full bg-green-600 text-white py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60 hover:bg-green-700">
                  {actionLoading ? '…' : 'I Received the Tokens'}
                </button>
                <p className="text-xs text-center text-text-muted">Did not receive? Use the chat to contact the seller or open a dispute below.</p>
              </div>
            )}

            {/* ─ BUYER: completed ─ */}
            {isBuyer && trade.status === 'completed' && !ratingOpen && (
              <CompletedSummary
                trade={trade}
                userId={user?.id ?? ''}
                counterparty={trade.seller.username}
                ratingError={ratingError}
                onOpenRating={() => setRatingOpen(true)}
              />
            )}

            {/* ─ SELLER: awaiting_payment ─ */}
            {isSeller && trade.status === 'awaiting_payment' && (
              <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4 text-sm">
                <p className="font-semibold text-yellow-800 mb-1">Waiting for buyer payment</p>
                <p className="text-yellow-700">The buyer is sending PKR to your account. You&apos;ll be notified when payment proof is uploaded.</p>
              </div>
            )}

            {/* ─ SELLER: payment_uploaded ─ */}
            {isSeller && trade.status === 'payment_uploaded' && (
              <div className="space-y-3">
                <div className="bg-surface rounded-xl p-3 text-sm">
                  <p className="text-text-muted text-xs mb-2">Buyer has uploaded payment proof. Review then confirm.</p>
                  {paymentProofs[0]?.fileUrl && (
                    <img src={paymentProofs[0].fileUrl} alt="payment proof" className="max-h-40 rounded-lg object-contain border border-border mb-2" />
                  )}
                </div>
                <button onClick={() => doAction(() => ctmApi.confirmPayment(ref))} disabled={actionLoading} className="w-full bg-primary text-white py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60">
                  {actionLoading ? '…' : 'Confirm Payment Received'}
                </button>
              </div>
            )}

            {/* ─ SELLER: payment_confirmed ─ */}
            {isSeller && trade.status === 'payment_confirmed' && (
              <div className="space-y-3">
                <div className="bg-surface rounded-xl p-3 text-sm space-y-1.5">
                  <p className="text-xs font-medium text-text-muted mb-1">Send tokens to buyer</p>
                  {(trade.buyerSettlementId || trade.settlementMethod) && (
                    <Row label="Buyer address" value={trade.buyerSettlementId ?? trade.settlementMethod} mono breakAll />
                  )}
                  <Row label="Amount" value={`${trade.tokenAmount} ${trade.token.symbol}`} />
                </div>
                <button onClick={() => doAction(() => ctmApi.markTransferring(ref))} disabled={actionLoading} className="w-full bg-primary text-white py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60">
                  {actionLoading ? '…' : 'I Have Started Sending Tokens'}
                </button>
              </div>
            )}

            {/* ─ SELLER: seller_transferring — context-aware proof form ─ */}
            {isSeller && trade.status === 'seller_transferring' && (
              <div className="space-y-3">
                <div className="bg-surface rounded-xl p-3 text-sm space-y-1.5 mb-1">
                  <p className="text-xs font-medium text-text-muted mb-1">Sending to</p>
                  {(trade.buyerSettlementId || trade.settlementMethod) && (
                    <Row label="Buyer address" value={trade.buyerSettlementId ?? trade.settlementMethod} mono breakAll />
                  )}
                  <Row label="Amount" value={`${trade.tokenAmount} ${trade.token.symbol}`} />
                </div>

                <div>
                  <label className="block text-xs font-medium text-text-primary mb-1.5">
                    {proofHashLabel(trade.settlementType)}
                    {isHashRequired(trade.settlementType) && <span className="text-primary font-semibold ml-1">(required)</span>}
                    {!isHashRequired(trade.settlementType) && <span className="text-text-muted font-normal ml-1">(optional)</span>}
                  </label>
                  <input
                    type="text"
                    value={txHash}
                    onChange={(e) => setTxHash(e.target.value)}
                    placeholder={proofHashPlaceholder(trade.settlementType)}
                    className="w-full border border-border rounded-xl px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                  {(trade.settlementType === 'ON_CHAIN' || trade.token.explorerUrl) && (
                    <p className="text-xs text-text-muted mt-1">
                      Paste the blockchain transaction hash so the buyer can verify it on the explorer.
                    </p>
                  )}
                  {trade.settlementType === 'MANUAL' && (
                    <p className="text-xs text-text-muted mt-1">Enter the transfer reference number from your payment app or bank.</p>
                  )}
                </div>

                <div>
                  <label className="block text-xs font-medium text-text-primary mb-1.5">
                    Screenshot
                    <span className="text-text-muted font-normal ml-1">(optional)</span>
                  </label>
                  <input type="file" accept="image/*" onChange={(e) => setProofFile(e.target.files?.[0] ?? null)} className="w-full border border-border rounded-xl p-2 text-sm" />
                </div>

                <button
                  onClick={handleUploadTokenProof}
                  disabled={actionLoading || (isHashRequired(trade.settlementType) ? !txHash.trim() : (!txHash.trim() && !proofFile))}
                  className="w-full bg-primary text-white py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60"
                >
                  {actionLoading ? 'Uploading…' : 'Submit Transfer Proof'}
                </button>
              </div>
            )}

            {/* ─ SELLER: proof_submitted — waiting for buyer ─ */}
            {isSeller && trade.status === 'proof_submitted' && (
              <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4 text-sm">
                <p className="font-semibold text-yellow-800 mb-1">Waiting for buyer confirmation</p>
                <p className="text-yellow-700">Transfer proof submitted. Buyer has 30 minutes to confirm receipt. If they don&apos;t respond, the trade escalates to admin.</p>
              </div>
            )}

            {/* ─ SELLER: completed ─ */}
            {isSeller && trade.status === 'completed' && !ratingOpen && (
              <CompletedSummary
                trade={trade}
                userId={user?.id ?? ''}
                counterparty={trade.buyer.username}
                ratingError={ratingError}
                onOpenRating={() => setRatingOpen(true)}
              />
            )}

            {/* ─ Dispute button ─ */}
            {(isBuyer || isSeller) && ['payment_confirmed', 'seller_transferring', 'proof_submitted', 'buyer_confirming'].includes(trade.status) && !trade.dispute && (
              <button onClick={() => setDisputeOpen(true)} className="w-full border border-red-200 text-red-600 py-2 rounded-xl text-sm hover:bg-red-50">Open Dispute</button>
            )}
          </div>

          {/* ── Rating ── */}
          {ratingOpen && (
            <div className="bg-white border border-border rounded-xl p-5 space-y-5">
              <h2 className="font-semibold text-text-primary">Leave a Review</h2>

              {/* Trader rating */}
              <div className="space-y-3">
                <div>
                  <p className="text-sm font-semibold text-text-primary">Rate this trader</p>
                  <p className="text-xs text-text-muted">How was your experience with @{isBuyer ? trade.seller.username : trade.buyer.username}?</p>
                </div>
                {traderRatingDone ? (
                  <div className="bg-green-50 border border-green-200 rounded-xl p-3 text-sm text-green-700">
                    ✓ Trader rating submitted.
                  </div>
                ) : (
                  <>
                    {ratingError && <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">{ratingError}</div>}
                    <div className="flex gap-2">
                      {[1, 2, 3, 4, 5].map((s) => (
                        <button key={s} onClick={() => setRating(s)} className={`text-2xl ${s <= rating ? 'text-yellow-400' : 'text-gray-200'}`}>★</button>
                      ))}
                    </div>
                    <textarea rows={2} placeholder="Trader feedback (optional)" value={ratingComment} onChange={(e) => setRatingComment(e.target.value)} className="w-full border border-border rounded-xl px-3 py-2 text-sm focus:outline-none resize-none" />
                    <div className="flex gap-2">
                      <button onClick={() => setRatingOpen(false)} className="flex-1 border border-border py-2 rounded-xl text-sm">Skip</button>
                      <button onClick={handleRate} className="flex-1 bg-primary text-white py-2 rounded-xl text-sm font-semibold">Submit Trader Rating</button>
                    </div>
                  </>
                )}
              </div>

              {/* Platform rating */}
              <div className="border-t border-border pt-4 space-y-3">
                <div>
                  <p className="text-sm font-semibold text-text-primary">Rate PakSwap platform</p>
                  <p className="text-xs text-text-muted">Share suggestions to improve PakSwap.</p>
                </div>
                {platformRatingDone ? (
                  <div className="bg-green-50 border border-green-200 rounded-xl p-3 text-sm text-green-700">
                    ✓ Platform feedback received. Thank you!
                  </div>
                ) : (
                  <>
                    <div className="flex gap-2">
                      {[1, 2, 3, 4, 5].map((s) => (
                        <button key={s} onClick={() => setPlatformRating(s)} className={`text-2xl ${s <= platformRating ? 'text-yellow-400' : 'text-gray-200'}`}>★</button>
                      ))}
                    </div>
                    <textarea rows={2} placeholder="Suggestions (optional)" value={platformComment} onChange={(e) => setPlatformComment(e.target.value)} className="w-full border border-border rounded-xl px-3 py-2 text-sm focus:outline-none resize-none" />
                    <button onClick={handlePlatformRate} className="w-full border border-border py-2 rounded-xl text-sm font-medium hover:bg-surface transition-colors">Submit Platform Feedback</button>
                  </>
                )}
              </div>

              {/* Close button — always available at the bottom */}
              <button onClick={() => setRatingOpen(false)} className="w-full border border-border py-2 rounded-xl text-sm text-text-muted hover:bg-surface transition-colors">
                Close
              </button>
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
            <p className="text-sm text-text-muted">Try messaging the {isBuyer ? 'seller' : 'buyer'} first using the chat. If unresolved, open a dispute and an admin will review.</p>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">Reason</label>
              <select value={disputeReason} onChange={(e) => setDisputeReason(e.target.value)} className="w-full border border-border rounded-xl px-3 py-2.5 text-sm bg-white focus:outline-none">
                <option value="">Select reason</option>
                {DISPUTE_REASONS.map((r) => <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">Description</label>
              <textarea rows={4} value={disputeDesc} onChange={(e) => setDisputeDesc(e.target.value)} className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none resize-none" placeholder="Describe the issue in detail. Include any evidence from the chat." />
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

// Completed trade summary card with rate prompt
function CompletedSummary({
  trade,
  userId,
  counterparty,
  ratingError,
  onOpenRating,
}: {
  trade: Trade
  userId: string
  counterparty: string
  ratingError: string
  onOpenRating: () => void
}) {
  const myRating = trade.ratings?.find((r) => r.ratedByUserId === userId)
  const theirRating = trade.ratings?.find((r) => r.ratedUserId === userId)

  const starRow = (rating: number) =>
    Array.from({ length: 5 }, (_, i) => (
      <span key={i} className={i < rating ? 'text-yellow-400' : 'text-gray-300'}>★</span>
    ))

  return (
    <div className="bg-green-50 border border-green-200 rounded-xl p-4 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-green-600 text-lg">✓</span>
        <p className="font-bold text-green-800">Trade Completed!</p>
      </div>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <p className="text-xs text-text-muted">Token</p>
          <p className="font-semibold text-text-primary">{trade.tokenAmount} {trade.token.symbol}</p>
        </div>
        <div>
          <p className="text-xs text-text-muted">Total PKR</p>
          <p className="font-semibold text-text-primary">PKR {Number(trade.fiatAmount).toLocaleString()}</p>
        </div>
        <div>
          <p className="text-xs text-text-muted">Payment</p>
          <p className="font-semibold text-text-primary">{trade.sellerPaymentSnapshot?.label ?? trade.paymentMethod}</p>
        </div>
        <div>
          <p className="text-xs text-text-muted">Counterparty</p>
          <p className="font-semibold text-text-primary">@{counterparty}</p>
        </div>
      </div>
      <div className="border-t border-green-200 pt-3 space-y-2">
        {myRating && (
          <p className="text-sm text-green-700 flex items-center gap-1.5">
            <span>You rated @{counterparty}:</span>
            <span className="flex">{starRow(myRating.rating)}</span>
          </p>
        )}
        {theirRating && (
          <p className="text-sm text-green-700 flex items-center gap-1.5">
            <span>@{counterparty} rated you:</span>
            <span className="flex">{starRow(theirRating.rating)}</span>
          </p>
        )}
        {!myRating && (
          <>
            {ratingError && <p className="text-xs text-red-600">{ratingError}</p>}
            <button
              onClick={onOpenRating}
              className="w-full border border-green-600 text-green-700 py-2 rounded-xl text-sm font-semibold hover:bg-green-100 transition-colors"
            >
              ★ Rate This Trade
            </button>
          </>
        )}
      </div>
      <p className="text-xs text-center text-green-700">Thank you for using PakSwap.</p>
    </div>
  )
}

// Inline copyable text block (used for tx hashes)
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
          <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5 text-green-600" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" /></svg>
        ) : (
          <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor"><path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z" /><path d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z" /></svg>
        )}
      </button>
    </div>
  )
}

// Small helper component to reduce repetition in key-value rows
function Row({ label, value, mono, breakAll, copyable }: { label: string; value: string; mono?: boolean; breakAll?: boolean; copyable?: boolean }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard not available
    }
  }

  return (
    <div className={`flex items-center ${breakAll ? 'gap-4' : 'justify-between'}`}>
      <span className="text-text-muted flex-shrink-0">{label}</span>
      <div className={`flex items-center gap-1.5 ${breakAll ? 'text-right' : ''}`}>
        <span className={`text-text-primary font-medium ${mono ? 'font-mono' : ''} ${breakAll ? 'break-all' : ''}`}>{value}</span>
        {copyable && (
          <button
            onClick={handleCopy}
            title="Copy"
            className="flex-shrink-0 p-0.5 rounded text-text-muted hover:text-primary hover:bg-primary/10 transition-colors"
          >
            {copied ? (
              <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5 text-green-600" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                <path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z" />
                <path d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z" />
              </svg>
            )}
          </button>
        )}
      </div>
    </div>
  )
}
