'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { ctmApi, apiRequest } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'
import { EntityLogo } from '@/components/ui/EntityLogo'
import { ConfirmModal } from '@/components/ui/ConfirmModal'

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

interface Bid { id: string; pricePerUnit: string; totalPkr: string; message?: string; status: string; expiresAt: string }
interface Request {
  id: string; side: string; amount: string; status: string; expiresAt: string; createdAt: string
  token: { name: string; symbol: string; logoUrl?: string }
  bids: Bid[]
}
interface MyBid {
  id: string; status: string; pricePerUnit: string; totalPkr: string; createdAt: string
  request: { id: string; side: string; amount: string; status: string; token: { name: string; symbol: string } }
}

export default function MyRequestsPage() {
  const [requests, setRequests] = useState<Request[]>([])
  const [bids, setBids] = useState<MyBid[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'requests' | 'bids'>('requests')
  const [actionError, setActionError] = useState('')
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null)
  const [confirmWithdraw, setConfirmWithdraw] = useState<{ requestId: string; bidId: string } | null>(null)
  const [savedMethods, setSavedMethods] = useState<SavedPaymentMethod[]>([])
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

  const fetchData = async () => {
    try {
      const res = await ctmApi.getMyRequests()
      const data = res as { requests: Request[]; bids: MyBid[] }
      setRequests(data.requests ?? [])
      setBids(data.bids ?? [])
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  usePolling(fetchData, 15000)

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

  const handleConfirmedCancel = async () => {
    if (!confirmCancel) return
    setActionError('')
    try {
      await ctmApi.cancelRequest(confirmCancel)
      await fetchData()
    } catch (err: unknown) {
      setActionError((err as Error).message ?? 'Failed to cancel request')
    } finally {
      setConfirmCancel(null)
    }
  }

  const handleConfirmedWithdraw = async () => {
    if (!confirmWithdraw) return
    setActionError('')
    try {
      await ctmApi.withdrawBid(confirmWithdraw.requestId, confirmWithdraw.bidId)
      await fetchData()
    } catch (err: unknown) {
      setActionError((err as Error).message ?? 'Failed to withdraw bid')
    } finally {
      setConfirmWithdraw(null)
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-text-primary">My Requests & Bids</h1>
        <Link href="/ctm/requests/create" className="bg-primary text-white px-4 py-2.5 rounded-xl font-semibold text-sm hover:bg-primary/90 transition-colors">+ Post Request</Link>
      </div>

      {actionError && (
        <div className="mb-4 bg-red-500/10 border border-red-500/30 rounded-xl p-3 text-sm text-red-700 dark:text-red-300 flex items-start justify-between gap-3">
          <span className="flex-1">{actionError}</span>
          <button onClick={() => setActionError('')} className="text-red-500 hover:text-red-700 dark:hover:text-red-300 flex-shrink-0" aria-label="Dismiss">×</button>
        </div>
      )}

      <ConfirmModal
        isOpen={!!confirmCancel}
        onClose={() => setConfirmCancel(null)}
        onConfirm={handleConfirmedCancel}
        title="Cancel this request?"
        description="Any pending bids on this request will be withdrawn."
        confirmLabel="Cancel Request"
        confirmVariant="danger"
      />
      <ConfirmModal
        isOpen={!!confirmWithdraw}
        onClose={() => setConfirmWithdraw(null)}
        onConfirm={handleConfirmedWithdraw}
        title="Withdraw your bid?"
        description="The merchant will no longer see this bid. You can submit a new one if the request is still open."
        confirmLabel="Withdraw Bid"
        confirmVariant="danger"
      />

      <div className="flex gap-1 bg-surface border border-border rounded-xl p-1 mb-6 w-fit">
        {(['requests', 'bids'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-5 py-2 rounded-lg text-sm font-semibold capitalize transition-colors ${tab === t ? 'bg-surface text-primary shadow-card' : 'text-text-muted hover:text-text-primary'}`}>
            My {t}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="bg-surface shadow-card border border-border rounded-xl h-24 animate-pulse" />)}</div>
      ) : tab === 'requests' ? (
        requests.length === 0 ? (
          <div className="text-center py-16 text-text-muted">No requests yet. <Link href="/ctm/requests/create" className="text-primary hover:underline">Post one →</Link></div>
        ) : (
          <div className="space-y-4">
            {requests.map((r) => (
              <div key={r.id} className="bg-surface shadow-card border border-border rounded-xl p-5">
                <div className="flex items-start justify-between gap-3 mb-4">
                  <div className="flex items-center gap-2.5">
                    <EntityLogo type="token" slug={r.token.symbol} size="md" logoUrl={r.token.logoUrl} />
                    <div>
                      <p className="font-semibold text-text-primary">{r.side === 'buy' ? 'Buying' : 'Selling'} {r.amount} {r.token.symbol}</p>
                      <p className="text-xs text-text-muted">{r.status} · {timeLeft(r.expiresAt)} left</p>
                    </div>
                  </div>
                  {r.status === 'open' && (
                    <button onClick={() => setConfirmCancel(r.id)} className="text-xs border border-red-500/30 text-red-600 dark:text-red-400 px-3 py-1.5 rounded-lg hover:bg-red-500/10">Cancel</button>
                  )}
                </div>

                {(r.bids ?? []).length > 0 ? (
                  <div className="space-y-2">
                    <p className="text-xs font-semibold text-text-muted uppercase tracking-wide">Bids ({(r.bids ?? []).filter((b) => b.status === 'pending').length} pending)</p>
                    {(r.bids ?? []).map((b) => (
                      <div key={b.id} className={`flex items-center justify-between bg-surface rounded-xl px-3 py-2.5 ${b.status !== 'pending' ? 'opacity-50' : ''}`}>
                        <div>
                          <p className="font-semibold text-text-primary text-sm">PKR {Number(b.totalPkr).toLocaleString()}</p>
                          <p className="text-xs text-text-muted">PKR {Number(b.pricePerUnit).toLocaleString()}/token{b.message ? ` · ${b.message}` : ''} · {b.status}</p>
                        </div>
                        {b.status === 'pending' && r.status === 'open' && (
                          <button onClick={() => openAcceptModal(r, b.id)} className="bg-green-600 text-white text-xs px-3 py-1.5 rounded-lg font-semibold hover:bg-green-700">Accept</button>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-text-muted">No bids yet.</p>
                )}
              </div>
            ))}
          </div>
        )
      ) : (
        bids.length === 0 ? (
          <div className="text-center py-16 text-text-muted">No bids submitted yet.</div>
        ) : (
          <div className="space-y-3">
            {bids.map((b) => (
              <div key={b.id} className="bg-surface shadow-card border border-border rounded-xl p-4 flex items-center justify-between gap-4">
                <div>
                  <p className="font-semibold text-text-primary">{b.request.side === 'buy' ? 'Buy' : 'Sell'} {b.request.amount} {b.request.token.symbol}</p>
                  <p className="text-xs text-text-muted">Your bid: PKR {Number(b.totalPkr).toLocaleString()} · {b.status}</p>
                </div>
                {b.status === 'pending' && (
                  <button onClick={() => setConfirmWithdraw({ requestId: b.request.id, bidId: b.id })} className="text-xs border border-red-500/30 text-red-600 dark:text-red-400 px-3 py-1.5 rounded-lg hover:bg-red-500/10">Withdraw</button>
                )}
              </div>
            ))}
          </div>
        )
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
                <p className="text-xs text-text-muted bg-yellow-500/10 border border-yellow-500/30 rounded-lg px-3 py-2">No saved payment accounts. <a href="/payment-methods" className="text-primary underline">Add one →</a></p>
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
