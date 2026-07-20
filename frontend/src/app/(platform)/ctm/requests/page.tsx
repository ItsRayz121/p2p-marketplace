'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { ctmApi, apiRequest } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { useAuth } from '@/hooks/useAuth'
import { PK_MOBILE_METHODS, isOpaqueId } from '@/lib/pkPaymentMethods'

const METHOD_LABELS: Record<string, string> = {
  jazzcash: 'JazzCash', easypaisa: 'Easypaisa', sadapay: 'SadaPay', nayapay: 'NayaPay', bank_transfer: 'Bank Transfer',
}
interface SavedPaymentMethod {
  id: string; type: string; accountName: string
  mobileNumber?: string; bankName?: string; ibanNumber?: string; accountNumber?: string
}
function pmLabel(m: SavedPaymentMethod): string {
  const name = m.type === 'bank_transfer' ? (m.bankName ?? 'Bank Transfer') : (METHOD_LABELS[m.type] ?? m.type)
  const sub = m.mobileNumber ?? m.ibanNumber ?? m.accountNumber ?? m.accountName
  return `${name} · ${sub}`
}

function timeLeft(expiresAt: string): string {
  const diff = new Date(expiresAt).getTime() - Date.now()
  if (diff <= 0) return 'Expired'
  const h = Math.floor(diff / 3600000)
  const m = Math.floor((diff % 3600000) / 60000)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

interface Bid { id: string; bidderId: string; pricePerUnit: string; totalPkr: string; message?: string; status: string }
interface Request {
  id: string
  side: string
  amount: string
  targetPricePkr?: string
  paymentMethods: string[]
  note?: string
  status: string
  expiresAt: string
  token: { id: string; slug: string; name: string; symbol: string; logoUrl?: string }
  user: { id: string; username: string }
  bids: Bid[]
  _count?: { bids: number }
}

export default function RequestBoardPage() {
  const { user } = useAuth()
  const [requests, setRequests] = useState<Request[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [page, setPage] = useState(1)
  const [bidModal, setBidModal] = useState<Request | null>(null)
  const [bidPrice, setBidPrice] = useState('')
  const [bidMsg, setBidMsg] = useState('')
  const [bidPaymentMethodId, setBidPaymentMethodId] = useState('')
  const [bidAddress, setBidAddress] = useState('')
  const [bidSubmitting, setBidSubmitting] = useState(false)
  const [bidError, setBidError] = useState('')
  const [actionError, setActionError] = useState('')
  const [savedMethods, setSavedMethods] = useState<SavedPaymentMethod[]>([])
  // Accept-bid modal: the requester confirms their own account (+ address if buyer)
  const [acceptModal, setAcceptModal] = useState<{ requestId: string; bidId: string; side: string; symbol: string } | null>(null)
  const [acceptPaymentMethodId, setAcceptPaymentMethodId] = useState('')
  const [acceptAddress, setAcceptAddress] = useState('')
  const [acceptSubmitting, setAcceptSubmitting] = useState(false)
  const [acceptError, setAcceptError] = useState('')

  useEffect(() => {
    apiRequest<SavedPaymentMethod[]>('/wallet/payment-methods')
      .then((m) => setSavedMethods(Array.isArray(m) ? m : []))
      .catch(() => {})
  }, [])

  const fetchRequests = async () => {
    try {
      const res = await ctmApi.getRequests({ side, page, limit: 20 })
      const data = res as { requests: Request[]; total: number }
      setRequests(data.requests ?? [])
      setTotal(data.total ?? 0)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  usePolling(fetchRequests, 15000)

  // Opening the accept flow needs the requester's account; collect it in a modal.
  const openAcceptModal = (r: Request, bidId: string) => {
    setAcceptError(''); setAcceptPaymentMethodId(''); setAcceptAddress('')
    setAcceptModal({ requestId: r.id, bidId, side: r.side, symbol: r.token.symbol })
  }

  const handleConfirmAccept = async () => {
    if (!acceptModal) return
    const requesterIsBuyer = acceptModal.side === 'buy'
    if (!acceptPaymentMethodId) { setAcceptError(requesterIsBuyer ? 'Select the account you will pay from' : 'Select the account to receive payment'); return }
    if (requesterIsBuyer && !acceptAddress.trim()) { setAcceptError('Enter your token receiving address'); return }
    setAcceptError(''); setAcceptSubmitting(true)
    try {
      const res = await ctmApi.acceptBid(acceptModal.requestId, acceptModal.bidId, {
        paymentMethodId: acceptPaymentMethodId,
        ...(requesterIsBuyer ? { settlementId: acceptAddress.trim() } : {}),
      })
      const trade = res as { tradeRef: string }
      window.location.href = `/ctm/trade/${trade.tradeRef}`
    } catch (err: unknown) {
      setAcceptError((err as Error).message ?? 'Failed to accept bid')
    } finally {
      setAcceptSubmitting(false)
    }
  }

  const handleSubmitBid = async () => {
    if (!bidModal || !bidPrice) return
    const bidderIsBuyer = bidModal.side === 'sell'
    if (!bidPaymentMethodId) { setBidError(bidderIsBuyer ? 'Select the account you will pay from' : 'Select the account to receive payment'); return }
    if (bidderIsBuyer && !bidAddress.trim()) { setBidError('Enter your token receiving address'); return }
    setBidError('')
    setBidSubmitting(true)
    try {
      await ctmApi.submitBid(bidModal.id, {
        pricePerUnit: parseFloat(bidPrice),
        message: bidMsg || undefined,
        paymentMethodId: bidPaymentMethodId,
        ...(bidderIsBuyer ? { buyerSettlementId: bidAddress.trim() } : {}),
      })
      setBidModal(null)
      setBidPrice('')
      setBidMsg('')
      setBidPaymentMethodId('')
      setBidAddress('')
    } catch (err: unknown) {
      setBidError((err as Error).message ?? 'Failed to submit bid')
    } finally {
      setBidSubmitting(false)
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Request Board</h1>
          <p className="text-text-muted text-sm">Post your need, let merchants compete</p>
        </div>
        <div className="flex gap-2">
          <Link href="/ctm/my-requests" className="border border-border px-4 py-2 rounded-xl text-sm font-medium text-text-primary hover:bg-surface transition-colors">My Requests</Link>
          <Link href="/ctm/requests/create" className="bg-primary text-white px-4 py-2.5 rounded-xl font-semibold text-sm hover:bg-primary/90 transition-colors">+ Post Request</Link>
        </div>
      </div>

      {actionError && (
        <div className="mb-4 bg-red-500/10 border border-red-500/30 rounded-xl p-3 text-sm text-red-700 dark:text-red-300 flex items-start justify-between gap-3">
          <span className="flex-1">{actionError}</span>
          <button onClick={() => setActionError('')} className="text-red-500 hover:text-red-700 dark:hover:text-red-300 flex-shrink-0" aria-label="Dismiss">×</button>
        </div>
      )}

      <div className="flex gap-1 bg-surface border border-border rounded-xl p-1 mb-6 w-fit">
        {(['buy', 'sell'] as const).map((s) => (
          <button key={s} onClick={() => { setSide(s); setPage(1) }}
            className={`px-6 py-2 rounded-lg text-sm font-semibold transition-colors ${side === s ? 'bg-surface text-primary shadow-card' : 'text-text-muted hover:text-text-primary'}`}>
            {s === 'buy' ? 'Buy Requests' : 'Sell Requests'}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="bg-surface shadow-card border border-border rounded-xl h-28 animate-pulse" />)}</div>
      ) : requests.length === 0 ? (
        <div className="text-center py-16 text-text-muted">No open {side} requests. <Link href="/ctm/requests/create" className="text-primary hover:underline">Post the first one →</Link></div>
      ) : (
        <div className="space-y-4">
          {requests.map((r) => {
            const isOwner = user?.id === r.user.id
            return (
              <div key={r.id} className="bg-surface shadow-card border border-border rounded-xl p-5">
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <EntityLogo type="token" slug={r.token.symbol} size="xl" logoUrl={r.token.logoUrl} />
                    <div>
                      <p className="font-semibold text-text-primary">{r.amount} {r.token.symbol}</p>
                      <p className="text-xs text-text-muted">by {r.user.username} · {timeLeft(r.expiresAt)} left</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <span className="text-sm text-text-muted">{r._count?.bids ?? r.bids?.length ?? 0} bids</span>
                    {r.targetPricePkr && <span className="text-sm font-medium text-text-primary">~PKR {Number(r.targetPricePkr).toLocaleString()}</span>}
                    {isOwner ? (
                      <Link href="/ctm/my-requests" className="bg-surface border border-border px-3 py-1.5 rounded-lg text-sm font-medium">View Bids</Link>
                    ) : (
                      <button onClick={() => { setBidModal(r); setBidError(''); setBidPrice(''); setBidMsg(''); setBidPaymentMethodId(''); setBidAddress('') }}
                        className="bg-primary text-white px-4 py-1.5 rounded-lg text-sm font-semibold hover:bg-primary/90 transition-colors">
                        Bid
                      </button>
                    )}
                  </div>
                </div>
                {r.note && <p className="text-sm text-text-muted mt-3 border-t border-border pt-3">{r.note}</p>}
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {(r.paymentMethods ?? []).filter((m) => !isOpaqueId(m)).map((m) => (
                    <span key={m} className="inline-flex items-center gap-1 text-xs bg-surface px-2 py-0.5 rounded-full border border-border">
                      <EntityLogo type={PK_MOBILE_METHODS.includes(m) ? 'payment_method' : 'bank'} slug={m} size="xs" className="flex-shrink-0" />
                      {m}
                    </span>
                  ))}
                </div>

                {/* Owner sees bids inline */}
                {isOwner && r.bids && r.bids.length > 0 && (
                  <div className="mt-4 border-t border-border pt-4 space-y-2">
                    <p className="text-xs font-semibold text-text-muted uppercase tracking-wide">Bids received</p>
                    {r.bids.filter((b) => b.status === 'pending').map((b) => (
                      <div key={b.id} className="flex items-center justify-between bg-surface rounded-xl px-3 py-2.5">
                        <div>
                          <p className="font-semibold text-text-primary text-sm">PKR {Number(b.totalPkr).toLocaleString()}</p>
                          <p className="text-xs text-text-muted">PKR {Number(b.pricePerUnit).toLocaleString()} per token{b.message ? ` · ${b.message}` : ''}</p>
                        </div>
                        <button onClick={() => openAcceptModal(r, b.id)} className="bg-green-600 text-white text-xs px-3 py-1.5 rounded-lg font-semibold hover:bg-green-700 transition-colors">Accept</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {total > 20 && (
        <div className="flex justify-center gap-2 mt-8">
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="px-4 py-2 border border-border rounded-lg text-sm disabled:opacity-40">Prev</button>
          <span className="px-4 py-2 text-sm text-text-muted">Page {page}</span>
          <button onClick={() => setPage((p) => p + 1)} disabled={requests.length < 20} className="px-4 py-2 border border-border rounded-lg text-sm disabled:opacity-40">Next</button>
        </div>
      )}

      {/* Bid modal */}
      {bidModal && (
        <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-4">
          <div className="bg-surface rounded-xl w-full max-w-md p-6 space-y-4">
            <h3 className="font-bold text-lg text-text-primary">Submit Bid</h3>
            <p className="text-sm text-text-muted">For: {bidModal.amount} {bidModal.token.symbol}</p>
            {bidError && <div className="bg-red-500/10 text-red-700 dark:text-red-300 border border-red-500/30 rounded-xl p-3 text-sm">{bidError}</div>}
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">Your price per token (PKR) *</label>
              <input type="number" min="0" step="0.01" value={bidPrice} onChange={(e) => setBidPrice(e.target.value)} className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
              {bidPrice && <p className="text-xs text-text-muted mt-1">Total: PKR {(parseFloat(bidPrice) * parseFloat(bidModal.amount)).toLocaleString()}</p>}
            </div>
            {/* Account the bidder will use: receive PKR (buy request) or pay from (sell request). */}
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">
                {bidModal.side === 'sell' ? 'Account you’ll pay from *' : 'Account to receive payment *'}
              </label>
              {savedMethods.length === 0 ? (
                <p className="text-xs text-text-muted bg-yellow-500/10 border border-yellow-500/30 rounded-lg px-3 py-2">No saved payment accounts. <a href="/wallet#payment-methods" className="text-primary underline">Add one →</a></p>
              ) : (
                <select value={bidPaymentMethodId} onChange={(e) => setBidPaymentMethodId(e.target.value)} className="w-full border border-border rounded-xl px-3 py-2.5 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-primary/30">
                  <option value="">Select an account…</option>
                  {savedMethods.map((m) => <option key={m.id} value={m.id}>{pmLabel(m)}</option>)}
                </select>
              )}
            </div>
            {/* Sell request → the bidder is the buyer, so they also need a token receiving address. */}
            {bidModal.side === 'sell' && (
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1.5">Your {bidModal.token.symbol} receiving address *</label>
                <input type="text" value={bidAddress} onChange={(e) => setBidAddress(e.target.value)} placeholder={`Your ${bidModal.token.symbol} wallet address`} className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                <p className="mt-1 text-xs text-text-muted">The seller will send tokens here after you pay.</p>
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">Message (optional)</label>
              <textarea rows={2} value={bidMsg} onChange={(e) => setBidMsg(e.target.value)} placeholder="e.g. I can complete in 30 minutes" className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none resize-none" />
            </div>
            <div className="flex gap-3">
              <button onClick={() => setBidModal(null)} className="flex-1 border border-border py-2.5 rounded-xl text-sm font-medium text-text-primary">Cancel</button>
              <button onClick={handleSubmitBid} disabled={bidSubmitting || !bidPrice} className="flex-1 bg-primary text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-primary/90 disabled:opacity-60">
                {bidSubmitting ? 'Submitting…' : 'Submit Bid'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Accept-bid modal — requester confirms their own account before the trade opens */}
      {acceptModal && (
        <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-4">
          <div className="bg-surface rounded-xl w-full max-w-md p-6 space-y-4">
            <h3 className="font-bold text-lg text-text-primary">Accept Bid</h3>
            <p className="text-sm text-text-muted">Confirm the account you&apos;ll use so the trade has full payment details.</p>
            {acceptError && <div className="bg-red-500/10 text-red-700 dark:text-red-300 border border-red-500/30 rounded-xl p-3 text-sm">{acceptError}</div>}
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">
                {acceptModal.side === 'buy' ? 'Account you’ll pay from *' : 'Account to receive payment *'}
              </label>
              {savedMethods.length === 0 ? (
                <p className="text-xs text-text-muted bg-yellow-500/10 border border-yellow-500/30 rounded-lg px-3 py-2">No saved payment accounts. <a href="/wallet#payment-methods" className="text-primary underline">Add one →</a></p>
              ) : (
                <select value={acceptPaymentMethodId} onChange={(e) => setAcceptPaymentMethodId(e.target.value)} className="w-full border border-border rounded-xl px-3 py-2.5 text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-primary/30">
                  <option value="">Select an account…</option>
                  {savedMethods.map((m) => <option key={m.id} value={m.id}>{pmLabel(m)}</option>)}
                </select>
              )}
            </div>
            {acceptModal.side === 'buy' && (
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1.5">Your {acceptModal.symbol} receiving address *</label>
                <input type="text" value={acceptAddress} onChange={(e) => setAcceptAddress(e.target.value)} placeholder={`Your ${acceptModal.symbol} wallet address`} className="w-full border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                <p className="mt-1 text-xs text-text-muted">The seller will send tokens here after you pay.</p>
              </div>
            )}
            <div className="flex gap-3">
              <button onClick={() => setAcceptModal(null)} className="flex-1 border border-border py-2.5 rounded-xl text-sm font-medium text-text-primary">Cancel</button>
              <button onClick={handleConfirmAccept} disabled={acceptSubmitting} className="flex-1 bg-green-600 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-green-700 disabled:opacity-60">
                {acceptSubmitting ? 'Accepting…' : 'Accept & Open Trade'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
