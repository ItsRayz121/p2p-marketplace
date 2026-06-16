'use client'
import { useState, useEffect, useRef, useCallback } from 'react'
import Link from 'next/link'
import { ctmApi } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'
import { Modal } from '@/components/ui/Modal'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { CtmStatusTimeline } from '@/components/admin/CtmStatusTimeline'

const STATUS_COLORS: Record<string, string> = {
  awaiting_payment:    'bg-yellow-500/15 text-yellow-700',
  payment_uploaded:    'bg-blue-500/15 text-blue-700',
  payment_confirmed:   'bg-blue-500/15 text-blue-700',
  seller_transferring: 'bg-indigo-500/15 text-indigo-700',
  proof_submitted:     'bg-purple-500/15 text-purple-700',
  completed:           'bg-green-500/15 text-green-700',
  cancelled:           'bg-surface-alt text-text-secondary',
  disputed:            'bg-red-500/15 text-red-700',
  dispute_resolved:    'bg-green-500/15 text-green-700',
  expired:             'bg-surface-alt text-text-secondary',
}

const STATUS_BADGE: Record<string, 'success' | 'warning' | 'danger' | 'default'> = {
  completed:        'success',
  dispute_resolved: 'success',
  disputed:         'danger',
  cancelled:        'default',
  expired:          'default',
  payment_uploaded: 'warning',
  payment_confirmed:'warning',
  seller_transferring: 'warning',
  proof_submitted:  'warning',
  awaiting_payment: 'warning',
}

interface CtmAdminTrade {
  id: string; tradeRef: string; tokenId: string; status: string
  fiatAmount: string; tokenAmount: string; pricePerUnit: string
  createdAt: string; expiresAt: string; completedAt?: string
  buyer: { id: string; username: string }; seller: { id: string; username: string }
  token: { id: string; name: string; symbol: string }
  proofs?: Array<{ id: string; fileUrl?: string; proofType: string; uploadedBy: string; createdAt: string; description?: string }>
  messages?: Array<{ id: string; senderId: string; senderUsername?: string; message: string; createdAt: string; isAdmin?: boolean }>
  dispute?: { id: string; reason: string; status: string; messages?: Array<{ id: string; senderId: string; message: string; createdAt: string }> }
}

// Full detail shape returned by GET /ctm/trades/:ref
interface CtmTradeDetail extends CtmAdminTrade {
  buyer: { id: string; username: string; fullName?: string }
  seller: { id: string; username: string; fullName?: string }
  listing?: {
    id: string; side: string; price: string; paymentMethods: string[]
    receivingWalletAddress?: string; networkLabel?: string
  }
  paymentProofUrl?: string
  sellerWalletAddress?: string
  networkLabel?: string
  ratings?: Array<{ rating: number; comment?: string; ratedByUserId: string }>
}

function timeLeft(expiresAt: string) {
  const ms = new Date(expiresAt).getTime() - Date.now()
  if (ms <= 0) return 'Expired'
  const m = Math.floor(ms / 60000)
  return m < 60 ? `${m}m left` : `${Math.floor(m / 60)}h ${m % 60}m left`
}

function fmtDt(iso: string) {
  return new Date(iso).toLocaleString('en-PK', { dateStyle: 'short', timeStyle: 'short' })
}

function InfoRow({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null
  return (
    <div className="flex gap-2">
      <span className="text-text-muted text-xs w-32 flex-shrink-0">{label}</span>
      <span className="text-text-primary text-xs font-medium break-all">{value}</span>
    </div>
  )
}

function TradeDetailModal({
  tradeRef, onClose, onAction,
}: {
  tradeRef: string
  onClose: () => void
  onAction: () => void
}) {
  const [trade, setTrade] = useState<CtmTradeDetail | null>(null)
  const [chat, setChat] = useState<Array<{ id: string; senderId: string; senderUsername?: string; message: string; createdAt: string }>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Fetch full detail on mount
  useState(() => {
    ctmApi.getTrade(tradeRef)
      .then((d) => setTrade(d as CtmTradeDetail))
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load trade'))
      .finally(() => setLoading(false))
    // Trade chat is a separate endpoint — fetch best-effort.
    ctmApi.getMessages(tradeRef)
      .then((m) => setChat(Array.isArray(m) ? (m as typeof chat) : []))
      .catch(() => setChat([]))
  })

  async function adminAction(action: string) {
    if (!trade) return
    setSubmitting(true)
    try {
      if (action === 'confirm-payment') await ctmApi.adminConfirmPayment(trade.tradeRef)
      else if (action === 'release') await ctmApi.adminForceRelease(trade.tradeRef)
      onAction()
      onClose()
    } catch (err) {
      alert((err as Error).message ?? 'Action failed')
    } finally {
      setSubmitting(false)
    }
  }

  const isDone = trade && ['completed','cancelled','expired','dispute_resolved'].includes(trade.status)

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={`Trade #${tradeRef.slice(-10)}`}
      size="lg"
      footer={
        trade ? (
          <div className="flex flex-wrap gap-2">
            {trade.status === 'payment_uploaded' && (
              <Button onClick={() => adminAction('confirm-payment')} disabled={submitting}>
                {submitting ? <Spinner size="sm" /> : 'Confirm Payment'}
              </Button>
            )}
            {['payment_confirmed','seller_transferring','proof_submitted'].includes(trade.status) && (
              <Button onClick={() => adminAction('release')} disabled={submitting}>
                {submitting ? <Spinner size="sm" /> : 'Force Complete'}
              </Button>
            )}
            <Button variant="secondary" onClick={onClose}>Close</Button>
          </div>
        ) : <Button variant="secondary" onClick={onClose}>Close</Button>
      }
    >
      {loading && (
        <div className="flex items-center justify-center py-12">
          <Spinner size="lg" />
        </div>
      )}
      {error && (
        <div className="py-8 text-center text-danger text-sm">{error}</div>
      )}
      {trade && (
        <div className="space-y-5">

          {/* Status + Timer */}
          <div className="flex items-center gap-3 flex-wrap">
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[trade.status] ?? 'bg-surface-alt text-text-secondary'}`}>
              {trade.status.replace(/_/g, ' ')}
            </span>
            {!isDone && (
              <span className="text-xs text-warning font-medium">{timeLeft(trade.expiresAt)}</span>
            )}
            {trade.completedAt && (
              <span className="text-xs text-success">Completed {fmtDt(trade.completedAt)}</span>
            )}
          </div>

          {/* Status timeline */}
          <div className="bg-surface-alt/50 border border-border rounded-xl p-4">
            <CtmStatusTimeline status={trade.status} />
          </div>

          {/* Parties + Trade Info */}
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-surface rounded-xl p-3 space-y-1.5 border border-border">
              <p className="text-[11px] font-semibold text-text-muted uppercase tracking-wide">Buyer</p>
              <Link href={`/admin/users/${trade.buyer.id}`} className="font-semibold text-text-primary text-sm hover:text-primary hover:underline">{trade.buyer.username}</Link>
              {trade.buyer.fullName && <p className="text-xs text-text-muted">{trade.buyer.fullName}</p>}
            </div>
            <div className="bg-surface rounded-xl p-3 space-y-1.5 border border-border">
              <p className="text-[11px] font-semibold text-text-muted uppercase tracking-wide">Seller</p>
              <Link href={`/admin/users/${trade.seller.id}`} className="font-semibold text-text-primary text-sm hover:text-primary hover:underline">{trade.seller.username}</Link>
              {trade.seller.fullName && <p className="text-xs text-text-muted">{trade.seller.fullName}</p>}
            </div>
            <div className="bg-surface rounded-xl p-3 border border-border">
              <p className="text-[11px] font-semibold text-text-muted uppercase tracking-wide mb-1">PKR Amount</p>
              <p className="font-bold text-text-primary text-lg">PKR {Number(trade.fiatAmount).toLocaleString()}</p>
            </div>
            <div className="bg-surface rounded-xl p-3 border border-border">
              <p className="text-[11px] font-semibold text-text-muted uppercase tracking-wide mb-1">Token Amount</p>
              <p className="font-bold text-text-primary text-lg">{Number(trade.tokenAmount).toLocaleString()} {trade.token?.symbol}</p>
              {trade.pricePerUnit && (
                <p className="text-xs text-text-muted">@ PKR {Number(trade.pricePerUnit).toLocaleString()} / {trade.token?.symbol}</p>
              )}
            </div>
          </div>

          {/* Trade Details */}
          <div className="bg-surface border border-border rounded-xl p-3 space-y-1.5">
            <p className="text-[11px] font-semibold text-text-muted uppercase tracking-wide mb-2">Trade Details</p>
            <InfoRow label="Ref" value={trade.tradeRef} />
            <InfoRow label="Token" value={`${trade.token?.name} (${trade.token?.symbol})`} />
            <InfoRow label="Network" value={trade.listing?.networkLabel ?? trade.networkLabel} />
            <InfoRow label="Seller receives" value={trade.listing?.receivingWalletAddress ?? trade.sellerWalletAddress} />
            <InfoRow label="Payment method" value={trade.listing?.paymentMethods?.join(', ')} />
            <InfoRow label="Created" value={fmtDt(trade.createdAt)} />
            <InfoRow label="Expires" value={fmtDt(trade.expiresAt)} />
          </div>

          {/* Payment Proof Image */}
          {trade.paymentProofUrl && (
            <div>
              <p className="text-sm font-medium text-text-primary mb-2">Payment Proof</p>
              <a href={trade.paymentProofUrl} target="_blank" rel="noopener noreferrer">
                <img src={trade.paymentProofUrl} alt="Payment proof" className="w-full max-h-48 object-contain rounded-xl border border-border" />
              </a>
            </div>
          )}

          {/* All Proofs */}
          {(trade.proofs?.length ?? 0) > 0 && (
            <div>
              <p className="text-sm font-medium text-text-primary mb-2">Proofs ({trade.proofs!.length})</p>
              <div className="grid grid-cols-3 gap-2">
                {trade.proofs!.map((p, i) => (
                  p.fileUrl ? (
                    <a key={p.id ?? i} href={p.fileUrl} target="_blank" rel="noopener noreferrer" className="group">
                      <img src={p.fileUrl} alt="proof" className="w-full h-24 object-cover rounded-xl border border-border group-hover:opacity-90 transition" />
                      <p className="text-xs text-text-muted mt-0.5">{p.proofType} · {fmtDt(p.createdAt)}</p>
                    </a>
                  ) : (
                    <div key={p.id ?? i} className="h-24 rounded-xl border border-border bg-surface flex items-center justify-center">
                      <span className="text-xs text-text-muted">{p.proofType}</span>
                    </div>
                  )
                ))}
              </div>
            </div>
          )}

          {/* Chat Messages */}
          {chat.length > 0 && (
            <div>
              <p className="text-sm font-medium text-text-primary mb-2">Chat ({chat.length} messages)</p>
              <div className="bg-surface-alt/50 rounded-xl border border-border p-3 max-h-52 overflow-y-auto space-y-2">
                {chat.map((m, i) => {
                  const isBuyer = m.senderId === trade.buyer.id
                  const isSeller = m.senderId === trade.seller.id
                  const label = isBuyer ? `${trade.buyer.username} (Buyer)` : isSeller ? `${trade.seller.username} (Seller)` : m.senderUsername ?? 'Admin'
                  return (
                    <div key={m.id ?? i} className={`text-xs flex gap-2 ${isBuyer ? '' : 'flex-row-reverse'}`}>
                      <div className={`rounded-lg px-2.5 py-1.5 max-w-[80%] ${
                        isBuyer ? 'bg-blue-500/10 text-blue-800 dark:bg-blue-500/15 dark:text-blue-200' : isSeller ? 'bg-green-500/10 text-green-800 dark:bg-green-500/15 dark:text-green-200' : 'bg-purple-500/10 text-purple-800 dark:bg-purple-500/15 dark:text-purple-200'
                      }`}>
                        <p className="font-semibold text-[10px] mb-0.5">{label}</p>
                        <p>{m.message}</p>
                        <p className="text-[9px] opacity-60 mt-0.5">{fmtDt(m.createdAt)}</p>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Dispute */}
          {trade.dispute && (
            <div className="bg-danger/5 border border-danger/30 rounded-xl p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <p className="font-semibold text-danger text-sm">Dispute</p>
                  <Badge variant="danger" size="sm">{trade.dispute.status.replace(/_/g, ' ')}</Badge>
                </div>
                <Link href="/admin/ctm/disputes" className="text-xs text-primary hover:underline">Manage in Disputes →</Link>
              </div>
              <p className="text-danger text-xs">Reason: {trade.dispute.reason.replace(/_/g, ' ')}</p>
              {(trade.dispute.messages?.length ?? 0) > 0 && (
                <div className="max-h-32 overflow-y-auto space-y-1 mt-2">
                  {trade.dispute.messages!.map((m, i) => (
                    <p key={m.id ?? i} className="text-xs text-text-secondary">
                      <span className="text-text-muted">{fmtDt(m.createdAt)} · </span>
                      {m.message}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

export default function AdminCtmTradesPage() {
  const [trades, setTrades] = useState<CtmAdminTrade[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [token, setToken] = useState('')
  const [minAmount, setMinAmount] = useState('')
  const [maxAmount, setMaxAmount] = useState('')
  const [searching, setSearching] = useState(false)
  const [page, setPage] = useState(1)
  const [viewRef, setViewRef] = useState<string | null>(null)

  const fetchTrades = useCallback(async () => {
    try {
      const params: Record<string, string | number> = { page, limit: 20 }
      if (statusFilter) params.status = statusFilter
      if (search) params.search = search
      if (token) params.token = token
      if (minAmount) params.minAmount = minAmount
      if (maxAmount) params.maxAmount = maxAmount
      const res = await ctmApi.adminGetTrades(params)
      const data = res as { trades: CtmAdminTrade[]; total: number }
      setTrades(data.trades ?? [])
      setTotal(data.total ?? 0)
    } catch {
      // ignore
    } finally {
      setLoading(false)
      setSearching(false)
    }
  }, [page, statusFilter, search, token, minAmount, maxAmount])

  usePolling(fetchTrades, 30000)

  // Debounced live search
  const firstRun = useRef(true)
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return }
    setSearching(true)
    const t = setTimeout(() => { setSearch(searchInput.trim()); setPage(1) }, 350)
    return () => clearTimeout(t)
  }, [searchInput])

  // Refetch when committed filters / page change
  useEffect(() => { fetchTrades() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [search, statusFilter, token, minAmount, maxAmount, page])

  function runSearchNow() { setSearch(searchInput.trim()); setPage(1) }

  const timeLeftLabel = (expiresAt: string) => {
    const ms = new Date(expiresAt).getTime() - Date.now()
    if (ms <= 0) return 'Expired'
    const m = Math.floor(ms / 60000)
    return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3">
        <h1 className="text-2xl font-bold text-text-primary">CTM Trades ({total})</h1>
        <div className="flex flex-wrap gap-2 items-center">
          <input
            type="text"
            placeholder="Ref, token, buyer/seller username or email…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') runSearchNow() }}
            className="border border-border rounded-lg px-3 py-2 text-sm bg-surface text-text-primary flex-1 min-w-56 focus:outline-none focus:ring-2 focus:ring-primary"
          />
          <Button size="sm" onClick={runSearchNow} loading={searching}>Search</Button>
          <input
            type="text"
            placeholder="Token symbol"
            value={token}
            onChange={(e) => { setToken(e.target.value); setPage(1) }}
            className="border border-border rounded-lg px-3 py-2 text-sm bg-surface text-text-primary w-32 focus:outline-none focus:ring-2 focus:ring-primary"
          />
          <input
            type="number"
            placeholder="Min PKR"
            value={minAmount}
            onChange={(e) => { setMinAmount(e.target.value); setPage(1) }}
            className="border border-border rounded-lg px-3 py-2 text-sm bg-surface text-text-primary w-28 focus:outline-none focus:ring-2 focus:ring-primary"
          />
          <input
            type="number"
            placeholder="Max PKR"
            value={maxAmount}
            onChange={(e) => { setMaxAmount(e.target.value); setPage(1) }}
            className="border border-border rounded-lg px-3 py-2 text-sm bg-surface text-text-primary w-28 focus:outline-none focus:ring-2 focus:ring-primary"
          />
          <select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1) }}
            className="border border-border rounded-lg px-3 py-2 text-sm bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-primary"
          >
            <option value="">All statuses</option>
            <option value="awaiting_payment">Awaiting Payment</option>
            <option value="payment_uploaded">Payment Uploaded</option>
            <option value="payment_confirmed">Payment Confirmed</option>
            <option value="seller_transferring">Seller Transferring</option>
            <option value="proof_submitted">Proof Submitted</option>
            <option value="disputed">Disputed</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
            <option value="expired">Expired</option>
          </select>
          {(search || token || minAmount || maxAmount || statusFilter) && (
            <Button size="sm" variant="ghost" onClick={() => { setSearchInput(''); setSearch(''); setToken(''); setMinAmount(''); setMaxAmount(''); setStatusFilter(''); setPage(1) }}>Clear</Button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-surface shadow-card border border-border rounded-xl h-14 animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="bg-surface shadow-card border border-border rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface border-b border-border">
              <tr>
                <th className="text-left px-4 py-3 text-text-muted font-medium">Ref</th>
                <th className="text-left px-4 py-3 text-text-muted font-medium">Parties</th>
                <th className="text-left px-4 py-3 text-text-muted font-medium">Amount</th>
                <th className="text-left px-4 py-3 text-text-muted font-medium">Status</th>
                <th className="text-left px-4 py-3 text-text-muted font-medium">Timer</th>
                <th className="text-right px-4 py-3 text-text-muted font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {trades.map((t) => (
                <tr key={t.id} className="hover:bg-surface/50 transition-colors">
                  <td className="px-4 py-3 font-mono text-xs">
                    <Link href={`/admin/ctm/trades/${t.tradeRef}`} className="text-primary hover:underline">#{t.tradeRef.slice(-10)}</Link>
                  </td>
                  <td className="px-4 py-3">
                    <p className="text-xs">
                      <Link href={`/admin/users/${t.buyer.id}`} className="text-text-primary hover:text-primary hover:underline">{t.buyer.username}</Link>
                      <span className="text-text-muted"> → </span>
                      <Link href={`/admin/users/${t.seller.id}`} className="text-text-primary hover:text-primary hover:underline">{t.seller.username}</Link>
                    </p>
                    {t.token && <p className="text-text-muted text-xs">{t.token.symbol}</p>}
                  </td>
                  <td className="px-4 py-3 text-text-primary font-medium">
                    PKR {Number(t.fiatAmount).toLocaleString()}
                    <p className="text-xs text-text-muted">{Number(t.tokenAmount).toLocaleString()} {t.token?.symbol}</p>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={STATUS_BADGE[t.status] ?? 'default'} size="sm">
                      {t.status.replace(/_/g, ' ')}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-xs text-text-muted">
                    {['completed','cancelled','expired','dispute_resolved'].includes(t.status)
                      ? '—'
                      : timeLeftLabel(t.expiresAt)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end">
                      <button
                        onClick={() => setViewRef(t.tradeRef)}
                        className="text-xs border border-border px-3 py-1.5 rounded-lg hover:bg-primary hover:text-white hover:border-primary transition-colors font-medium"
                      >
                        View
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          {trades.length === 0 && <p className="text-center py-12 text-text-muted">No trades found.</p>}
        </div>
      )}

      {total > 20 && (
        <div className="flex justify-center gap-2">
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="px-4 py-2 border border-border rounded-lg text-sm disabled:opacity-40">Prev</button>
          <span className="px-4 py-2 text-sm text-text-muted">Page {page}</span>
          <button onClick={() => setPage((p) => p + 1)} disabled={trades.length < 20} className="px-4 py-2 border border-border rounded-lg text-sm disabled:opacity-40">Next</button>
        </div>
      )}

      {viewRef && (
        <TradeDetailModal
          tradeRef={viewRef}
          onClose={() => setViewRef(null)}
          onAction={() => { setViewRef(null); void fetchTrades() }}
        />
      )}
    </div>
  )
}
