'use client'
import { useState, useCallback } from 'react'
import Link from 'next/link'
import { adminApi } from '@/lib/api'
import { fmtDate, fmtDateTime, fmtTime } from '@/lib/fmt'
import { usePolling } from '@/hooks/usePolling'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Badge } from '@/components/ui/Badge'
import { ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { ConfirmModal } from '@/components/ui/ConfirmModal'
import { explorerTxUrl, explorerName } from '@/lib/explorers'

// ─── Types ──────────────────────────────────────────────────────────────────────

interface TradeMessage { id: string; senderId: string; message: string; createdAt: string }

interface PaymentSnapshot {
  type?: string
  label?: string
  accountName?: string
  mobileNumber?: string
  bankName?: string
  ibanNumber?: string
  accountNumber?: string
}

interface DisputeTrade {
  id: string
  orderRef: string
  buyerId: string
  sellerId: string
  coin: string
  network?: string
  amount: string
  price?: string
  fiatAmount: string
  totalPkr?: string
  paymentMethod: string
  sellerPaymentSnapshot?: PaymentSnapshot | null
  paymentProofUrl?: string
  sellerTxHash?: string
  txVerificationStatus?: string
  buyerWalletAddress?: string
  buyerDeliveryMethod?: string
  buyerDeliveryAddress?: string
  sellerDeliveryProofUrl?: string
  status: string
  disputeReason?: string
  disputeDescription?: string
  disputeMessages?: TradeMessage[]
  messages?: TradeMessage[]
  buyer?: { id: string; email: string; username: string; tradeStats?: { disputesWon: number; disputesLost: number } | null }
  seller?: { id: string; email: string; username: string; tradeStats?: { disputesWon: number; disputesLost: number } | null }
  ad?: { side: string }
  createdAt: string
  updatedAt: string
}

interface DisputeRecord {
  id: string
  tradeId: string
  openedById: string
  reason: string
  description: string
  status: string
  resolution?: string
  winner?: string
  resolvedAt?: string
  resolvedBy?: string
  createdAt: string
  updatedAt: string
  trade: DisputeTrade
  messages?: Array<{ id: string; senderId: string; message: string; createdAt: string }>
  openedBy?: { id: string; username: string; email: string } | null
}

interface DisputesResponse {
  disputes: DisputeRecord[]
  total?: number
  pagination?: { total: number }
}

// A raw PaymentMethod id (cuid) — never show this to the admin as the method.
function isOpaqueId(v: string): boolean {
  return /^c[a-z0-9]{20,}$/i.test(v.trim())
}

const DELIVERY_METHOD_LABELS: Record<string, string> = {
  wallet_blockchain: 'Wallet / Blockchain', blockchain: 'Wallet / Blockchain',
  Binance: 'Binance', OKX: 'OKX', Bitget: 'Bitget', Gate: 'Gate', MEXC: 'MEXC',
}
function deliveryMethodLabel(m?: string): string {
  if (!m) return '—'
  return DELIVERY_METHOD_LABELS[m] ?? m
}

function daysAgo(date: string) {
  return Math.floor((Date.now() - new Date(date).getTime()) / (1000 * 60 * 60 * 24))
}

function slaLabel(date: string): string {
  const ms = Date.now() - new Date(date).getTime()
  const h = Math.floor(ms / 3600000)
  const d = Math.floor(h / 24)
  if (d >= 1) return `${d}d ${h % 24}h`
  return `${h}h ${Math.floor((ms % 3600000) / 60000)}m`
}

function slaBadgeClass(date: string): string {
  const days = daysAgo(date)
  if (days >= 3) return 'bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30'
  if (days >= 1) return 'bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/30'
  return 'bg-green-500/15 text-green-700 dark:text-green-300 border-green-500/30'
}

const statusVariant = (s: string): 'default' | 'success' | 'warning' | 'danger' => {
  if (s === 'disputed' || s === 'open' || s === 'escalated') return 'danger'
  if (s === 'resolved') return 'success'
  return 'warning'
}

const DISPUTE_STATUS_LABELS: Record<string, string> = {
  disputed:  'Disputed',
  open:      'Open',
  escalated: 'Escalated',
  resolved:  'Resolved',
  pending:   'Pending',
}
const disputeStatusLabel = (s: string) => DISPUTE_STATUS_LABELS[s] ?? s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

const DIRECTION_LABELS: Record<string, string> = { buy: 'Buyer listing', sell: 'Seller listing' }

// Quick-pick resolution summaries for USDT/P2P disputes, split by who wins.
// Platform is non-custodial: rulings are guidance, parties settle off-platform.
const RESOLUTION_TEMPLATES: Record<'buyer' | 'seller', string[]> = {
  buyer: [
    'Buyer provided valid proof of PKR payment to the seller’s account. Ruling in the buyer’s favour — the seller must deliver the agreed USDT to the buyer’s wallet.',
    'Seller failed to deliver USDT after payment was confirmed. Ruling in the buyer’s favour — seller to complete the USDT transfer without further delay.',
    'Seller became unresponsive after receiving payment. Ruling in the buyer’s favour based on the evidence provided.',
  ],
  seller: [
    'Buyer did not send the PKR payment within the trade window, or the payment could not be verified. Ruling in the seller’s favour — no USDT is owed.',
    'The submitted payment proof was found to be invalid/fabricated. Ruling in the seller’s favour — the buyer’s claim is dismissed.',
    'Buyer became unresponsive and provided no valid evidence of payment. Ruling in the seller’s favour.',
  ],
}

export default function DisputesPage() {
  const [disputes, setDisputes] = useState<DisputeRecord[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState('open')

  const [selected, setSelected] = useState<DisputeRecord | null>(null)
  const [modalOpen, setModalOpen] = useState(false)

  // Resolve form
  const [winner, setWinner] = useState<'buyer' | 'seller'>('buyer')
  const [resolution, setResolution] = useState('')
  const [resolutionNote, setResolutionNote] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)

  // Close form
  const [showCloseForm, setShowCloseForm] = useState(false)
  const [closeNote, setCloseNote] = useState('')
  const [confirmClose, setConfirmClose] = useState(false)

  // Add note form
  const [showNoteForm, setShowNoteForm] = useState(false)
  const [adminNote, setAdminNote] = useState('')

  const [actionError, setActionError] = useState<string | null>(null)
  const [actionSuccess, setActionSuccess] = useState<string | null>(null)

  const limit = 20

  const fetchDisputes = useCallback(async () => {
    try {
      const params: Record<string, string | number> = { page, limit }
      if (statusFilter !== 'all') params.status = statusFilter
      const data = await adminApi.getDisputes(params) as unknown as DisputesResponse
      setDisputes(data.disputes ?? [])
      setTotal(data.pagination?.total ?? data.total ?? 0)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load disputes')
    } finally {
      setLoading(false)
    }
  }, [page, statusFilter])

  usePolling(fetchDisputes, 30_000)

  function openModal(d: DisputeRecord) {
    setSelected(d)
    setWinner('buyer')
    setResolution('')
    setResolutionNote('')
    setShowCloseForm(false)
    setCloseNote('')
    setShowNoteForm(false)
    setAdminNote('')
    setActionError(null)
    setActionSuccess(null)
    setModalOpen(true)
  }

  async function handleResolve() {
    if (!selected || !resolution.trim()) return
    setActionError(null)
    try {
      await adminApi.resolveDispute(selected.id, { winner, resolution, resolutionNote })
      setConfirmOpen(false)
      setModalOpen(false)
      // Resolved disputes are retained, not deleted — switch to the Resolved tab
      // so the admin sees where it went instead of it appearing to vanish.
      setStatusFilter('resolved')
      setPage(1)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to resolve dispute')
    }
  }

  async function handleClose() {
    if (!selected || !closeNote.trim()) return
    setActionError(null)
    try {
      await adminApi.closeDispute(selected.id, { note: closeNote.trim() })
      setConfirmClose(false)
      setModalOpen(false)
      // Closed disputes are retained under Resolved — show them there.
      setStatusFilter('resolved')
      setPage(1)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to close dispute')
    }
  }

  async function handleAddNote() {
    if (!selected || !adminNote.trim()) return
    setActionError(null)
    try {
      await adminApi.addDisputeNote(selected.id, { note: adminNote.trim() })
      setActionSuccess('Note added successfully.')
      setAdminNote('')
      setShowNoteForm(false)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to add note')
    }
  }

  const totalPages = Math.ceil(total / limit)
  const isResolved = selected?.status === 'resolved'

  if (loading) return <LoadingState message="Loading disputes..." />
  if (error && disputes.length === 0) return <ErrorState title={error} onRetry={fetchDisputes} />

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Disputes</h1>
        <p className="text-text-muted text-sm mt-0.5">{total} disputes found</p>
      </div>

      {/* Filters */}
      <div className="bg-surface shadow-card p-4 rounded-xl border border-border admin-toolbar gap-2">
        {[
          { value: 'open', label: 'Open' },
          { value: 'resolved', label: 'Resolved' },
          { value: 'escalated', label: 'Escalated' },
          { value: 'all', label: 'All' },
        ].map((f) => (
          <button
            key={f.value}
            onClick={() => { setStatusFilter(f.value); setPage(1) }}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors border ${
              statusFilter === f.value
                ? 'bg-primary text-white border-primary'
                : 'bg-surface text-text-secondary border-border hover:bg-surface'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {disputes.length === 0 ? (
        <EmptyState icon={ShieldAlert} title="No disputes found" description="No disputes match the current filter." />
      ) : (
        <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm stack-sm">
              <thead className="bg-surface border-b border-border">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Trade ID</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Buyer</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Seller</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Opened</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">SLA</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Status</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {disputes.map((d) => (
                  <tr key={d.id} className="hover:bg-surface/50 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs text-text-secondary" data-label="Trade ID">
                      #{d.trade?.orderRef?.slice(0, 8) ?? d.tradeId.slice(0, 8)}
                    </td>
                    <td className="px-4 py-3 text-text-primary" data-label="Buyer">{d.trade?.buyer?.username || d.trade?.buyerId?.slice(0, 8) || 'Unknown'}</td>
                    <td className="px-4 py-3 text-text-primary" data-label="Seller">{d.trade?.seller?.username || d.trade?.sellerId?.slice(0, 8) || 'Unknown'}</td>
                    <td className="px-4 py-3 text-text-secondary" data-label="Opened">{fmtDate(d.createdAt)}</td>
                    <td className="px-4 py-3" data-label="SLA">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${slaBadgeClass(d.createdAt)}`}>
                        {slaLabel(d.createdAt)}
                      </span>
                    </td>
                    <td className="px-4 py-3" data-label="Status">
                      <Badge variant={statusVariant(d.status)} size="sm">{disputeStatusLabel(d.status)}</Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button size="sm" variant="ghost" onClick={() => openModal(d)}>View</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-border">
              <p className="text-text-muted text-sm">Page {page} of {totalPages}</p>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Prev</Button>
                <Button size="sm" variant="secondary" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next</Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Dispute Detail Modal ──────────────────────────────────────────────── */}
      <Modal isOpen={modalOpen} onClose={() => setModalOpen(false)} title={`Dispute — Trade #${selected?.trade?.orderRef?.slice(0, 8) ?? ''}`} size="xl">
        {selected && (
          <div className="space-y-5 max-h-[80vh] overflow-y-auto pr-1">

            {/* Trade Summary */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 p-4 bg-surface rounded-xl text-sm">
              <div>
                <p className="text-text-muted text-xs">Trade ID</p>
                <p className="font-mono text-xs text-text-primary break-all">{selected.trade?.orderRef ?? selected.tradeId}</p>
              </div>
              <div>
                <p className="text-text-muted text-xs">Token / Amount</p>
                <p className="font-semibold text-text-primary">{selected.trade?.amount} {selected.trade?.coin}{selected.trade?.network ? ` · ${selected.trade.network}` : ''}</p>
              </div>
              <div>
                <p className="text-text-muted text-xs">PKR Amount</p>
                <p className="font-semibold text-text-primary">PKR {Number(selected.trade?.fiatAmount ?? selected.trade?.totalPkr ?? 0).toLocaleString()}</p>
              </div>
              <div>
                <p className="text-text-muted text-xs">Direction</p>
                <p className="text-text-primary">{DIRECTION_LABELS[selected.trade?.ad?.side ?? ''] ?? selected.trade?.ad?.side ?? '—'}</p>
              </div>
              <div>
                <p className="text-text-muted text-xs">Trade Status</p>
                <p className="text-text-primary">{(selected.trade?.status ?? '—').replace(/_/g, ' ')}</p>
              </div>
              <div>
                <p className="text-text-muted text-xs">Dispute Status</p>
                <Badge variant={statusVariant(selected.status)} size="sm">{disputeStatusLabel(selected.status)}</Badge>
              </div>
              <div className="col-span-2 sm:col-span-3 border-t border-border pt-2 mt-1">
                <p className="text-text-muted text-xs">Opened / Last update</p>
                <p className="text-text-primary text-xs">{fmtDateTime(selected.createdAt)}{selected.trade?.updatedAt ? ` · updated ${fmtDateTime(selected.trade.updatedAt)}` : ''}</p>
              </div>
            </div>

            {/* Settlement details — how PKR was to be paid and where USDT was to be delivered */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="p-3 bg-surface shadow-card border border-border rounded-xl text-sm">
                <p className="text-text-muted text-xs mb-1">PKR paid to (seller&apos;s account)</p>
                {selected.trade?.sellerPaymentSnapshot?.label ? (
                  <>
                    <p className="font-semibold text-text-primary">{selected.trade.sellerPaymentSnapshot.label}</p>
                    {selected.trade.sellerPaymentSnapshot.accountName && <p className="text-xs text-text-secondary">{selected.trade.sellerPaymentSnapshot.accountName}</p>}
                    <p className="font-mono text-xs text-text-muted break-all">
                      {selected.trade.sellerPaymentSnapshot.mobileNumber ?? selected.trade.sellerPaymentSnapshot.accountNumber ?? selected.trade.sellerPaymentSnapshot.ibanNumber ?? ''}
                    </p>
                  </>
                ) : (
                  <p className="text-text-secondary text-xs">{isOpaqueId(selected.trade?.paymentMethod ?? '') ? 'Account snapshot unavailable' : (selected.trade?.paymentMethod || '—')}</p>
                )}
              </div>
              <div className="p-3 bg-surface shadow-card border border-border rounded-xl text-sm">
                <p className="text-text-muted text-xs mb-1">USDT delivery destination (buyer)</p>
                <p className="font-semibold text-text-primary">{deliveryMethodLabel(selected.trade?.buyerDeliveryMethod)}</p>
                <p className="font-mono text-xs text-text-muted break-all">{selected.trade?.buyerDeliveryAddress || selected.trade?.buyerWalletAddress || '—'}</p>
              </div>
            </div>

            {/* Parties */}
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 bg-surface shadow-card border border-border rounded-xl text-sm">
                <p className="text-text-muted text-xs mb-1">Buyer</p>
                <Link href={`/admin/users/${selected.trade?.buyer?.id ?? selected.trade?.buyerId}`} className="font-semibold text-primary hover:underline">
                  {selected.trade?.buyer?.username || 'Unknown'}
                </Link>
                <p className="text-xs text-text-muted">{selected.trade?.buyer?.email}</p>
                {(selected.trade?.buyer?.tradeStats?.disputesLost ?? 0) > 0 && (
                  <p className="text-xs text-orange-600 dark:text-orange-400 mt-1 font-medium">⚠ {selected.trade!.buyer!.tradeStats!.disputesLost} prior dispute loss(es)</p>
                )}
              </div>
              <div className="p-3 bg-surface shadow-card border border-border rounded-xl text-sm">
                <p className="text-text-muted text-xs mb-1">Seller</p>
                <Link href={`/admin/users/${selected.trade?.seller?.id ?? selected.trade?.sellerId}`} className="font-semibold text-primary hover:underline">
                  {selected.trade?.seller?.username || 'Unknown'}
                </Link>
                <p className="text-xs text-text-muted">{selected.trade?.seller?.email}</p>
                {(selected.trade?.seller?.tradeStats?.disputesLost ?? 0) > 0 && (
                  <p className="text-xs text-orange-600 dark:text-orange-400 mt-1 font-medium">⚠ {selected.trade!.seller!.tradeStats!.disputesLost} prior dispute loss(es)</p>
                )}
              </div>
            </div>

            {/* Who opened */}
            <div className="text-sm text-text-muted">
              Dispute opened by{' '}
              <span className="font-semibold text-text-primary">
                {selected.openedBy?.username ?? selected.openedById.slice(0, 8)}
              </span>
              {' '}on {fmtDateTime(selected.createdAt)}
            </div>

            {/* Dispute Reason & Description */}
            <div className="space-y-2">
              <div>
                <p className="text-sm font-medium text-text-primary mb-1">Dispute Reason</p>
                <p className="text-sm text-text-secondary bg-danger/5 border border-danger/10 rounded-lg px-3 py-2">
                  {selected.reason}
                </p>
              </div>
              {selected.description && (
                <div>
                  <p className="text-sm font-medium text-text-primary mb-1">Description</p>
                  <p className="text-sm text-text-secondary whitespace-pre-wrap bg-surface border border-border rounded-lg px-3 py-2">
                    {selected.description}
                  </p>
                </div>
              )}
            </div>

            {/* Payment Proof */}
            {selected.trade?.paymentProofUrl && (
              <div>
                <p className="text-sm font-medium text-text-primary mb-2">Payment Proof</p>
                <a href={selected.trade.paymentProofUrl} target="_blank" rel="noopener noreferrer">
                  <img
                    src={selected.trade.paymentProofUrl}
                    alt="Payment proof"
                    className="max-w-xs rounded-lg border border-border hover:opacity-90 transition-opacity cursor-pointer"
                  />
                </a>
              </div>
            )}

            {/* Token Transfer Hash + on-chain verification (wallet deliveries only) */}
            {selected.trade?.sellerTxHash && (
              <div>
                <p className="text-sm font-medium text-text-primary mb-1">Token Transfer Hash</p>
                <p className="font-mono text-xs text-primary break-all bg-surface border border-border rounded-lg px-3 py-2">
                  {selected.trade.sellerTxHash}
                </p>
                <div className="flex items-center gap-3 mt-1.5">
                  {selected.trade.txVerificationStatus && (
                    <span className="text-xs text-text-muted">
                      Verification: <span className="font-medium text-text-secondary">{selected.trade.txVerificationStatus.replace(/_/g, ' ')}</span>
                    </span>
                  )}
                  {(() => {
                    const url = explorerTxUrl(selected.trade?.network ?? '', selected.trade?.sellerTxHash ?? '')
                    return url
                      ? <a href={url} target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-primary hover:underline">View on {explorerName(selected.trade?.network ?? '')} ↗</a>
                      : null
                  })()}
                </div>
              </div>
            )}

            {/* Seller's token-transfer screenshot (for exchange/internal deliveries the
                screenshot is the proof, since there is no verifiable on-chain hash). */}
            {selected.trade?.sellerDeliveryProofUrl && (
              <div>
                <p className="text-sm font-medium text-text-primary mb-2">Token Transfer Screenshot (seller)</p>
                <a href={selected.trade.sellerDeliveryProofUrl} target="_blank" rel="noopener noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={selected.trade.sellerDeliveryProofUrl} alt="Token transfer proof" className="max-w-xs rounded-lg border border-border hover:opacity-90 transition-opacity cursor-pointer" />
                </a>
              </div>
            )}

            {/* Chat Messages */}
            {(selected.trade?.messages ?? []).length > 0 && (
              <div>
                <p className="text-sm font-medium text-text-primary mb-2">Trade Chat</p>
                <div className="space-y-2 max-h-48 overflow-y-auto border border-border rounded-xl p-3 bg-surface">
                  {(selected.trade?.messages ?? []).map((msg) => {
                    const isBuyer = msg.senderId === (selected.trade?.buyer?.id ?? selected.trade?.buyerId)
                    return (
                      <div key={msg.id} className="text-xs">
                        <span className={`font-semibold ${isBuyer ? 'text-blue-600 dark:text-blue-400' : 'text-green-700 dark:text-green-300'}`}>
                          {isBuyer ? selected.trade?.buyer?.username ?? 'Buyer' : selected.trade?.seller?.username ?? 'Seller'}:
                        </span>
                        <span className="text-text-secondary ml-1">{msg.message}</span>
                        <span className="text-text-muted ml-2">{fmtTime(msg.createdAt)}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Dispute Messages (from DisputeMessage table) */}
            {(selected.messages ?? []).length > 0 && (
              <div>
                <p className="text-sm font-medium text-text-primary mb-2">Dispute Evidence & Notes</p>
                <div className="space-y-2 max-h-36 overflow-y-auto border border-border rounded-xl p-3 bg-surface">
                  {(selected.messages ?? []).map((msg) => (
                    <div key={msg.id} className="text-xs">
                      <span className="font-semibold text-text-secondary">
                        {msg.senderId === (selected.trade?.buyer?.id ?? selected.trade?.buyerId) ? 'Buyer' :
                         msg.senderId === (selected.trade?.seller?.id ?? selected.trade?.sellerId) ? 'Seller' : 'Admin'}:
                      </span>
                      <span className="text-text-secondary ml-1">{msg.message}</span>
                      <span className="text-text-muted ml-2">{fmtTime(msg.createdAt)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Resolution info (if already resolved) */}
            {isResolved && selected.resolution && (
              <div className="p-3 bg-success/5 border border-success/20 rounded-xl text-sm">
                <p className="font-semibold text-success mb-0.5">Resolved — {selected.winner ? `in favour of ${selected.winner}` : 'closed'}</p>
                <p className="text-text-secondary">{selected.resolution}</p>
                {selected.resolvedAt && <p className="text-xs text-text-muted mt-1">{fmtDateTime(selected.resolvedAt)}</p>}
              </div>
            )}

            {actionError && (
              <div className="px-3 py-2 bg-danger/10 border border-danger/20 rounded-lg text-danger text-sm">
                {actionError}
              </div>
            )}
            {actionSuccess && (
              <div className="px-3 py-2 bg-success/10 border border-success/20 rounded-lg text-success text-sm">
                {actionSuccess}
              </div>
            )}

            {/* Action Buttons */}
            {!isResolved && (
              <div className="space-y-4 pt-2 border-t border-border">
                {/* Resolve in buyer/seller favor */}
                <div>
                  <p className="text-sm font-medium text-text-primary mb-2">Award in favor of</p>
                  <div className="flex gap-3 mb-3">
                    <button
                      onClick={() => setWinner('buyer')}
                      className={`flex-1 py-2.5 rounded-lg border text-sm font-medium transition-colors ${
                        winner === 'buyer' ? 'bg-primary text-white border-primary' : 'bg-surface text-text-secondary border-border hover:bg-surface'
                      }`}
                    >
                      Buyer — {selected.trade?.buyer?.username}
                    </button>
                    <button
                      onClick={() => setWinner('seller')}
                      className={`flex-1 py-2.5 rounded-lg border text-sm font-medium transition-colors ${
                        winner === 'seller' ? 'bg-primary text-white border-primary' : 'bg-surface text-text-secondary border-border hover:bg-surface'
                      }`}
                    >
                      Seller — {selected.trade?.seller?.username}
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {RESOLUTION_TEMPLATES[winner].map((tpl, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => setResolution(tpl)}
                        title={tpl}
                        className="px-2.5 py-1 rounded-full text-xs border border-border text-text-secondary hover:bg-primary/10 hover:border-primary/40 transition-colors text-left max-w-full truncate"
                      >
                        {tpl.length > 48 ? `${tpl.slice(0, 48)}…` : tpl}
                      </button>
                    ))}
                  </div>
                  <textarea
                    value={resolution}
                    onChange={(e) => setResolution(e.target.value)}
                    rows={3}
                    placeholder="Resolution summary (required)... or pick a template above"
                    className="w-full px-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-surface focus:outline-none focus:ring-2 focus:ring-primary resize-none"
                  />
                  <textarea
                    value={resolutionNote}
                    onChange={(e) => setResolutionNote(e.target.value)}
                    rows={1}
                    placeholder="Internal note (optional)..."
                    className="w-full mt-1.5 px-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-surface focus:outline-none focus:ring-2 focus:ring-primary resize-none"
                  />
                  <p className="text-xs text-text-muted mt-2">
                    On resolve, the losing party automatically receives a graduated strike:
                    1st = warning, 2nd = 48h trading cooldown, 3rd+ = 7-day cooldown + under review.
                    Account bans remain a manual action.
                  </p>
                  <Button
                    variant="primary"
                    fullWidth
                    disabled={!resolution.trim()}
                    onClick={() => setConfirmOpen(true)}
                    className="mt-2"
                  >
                    Resolve Dispute
                  </Button>
                </div>

                {/* Close without winner */}
                {showCloseForm ? (
                  <div className="space-y-2">
                    <p className="text-sm font-medium text-text-primary">Close Dispute (no winner)</p>
                    <textarea
                      value={closeNote}
                      onChange={(e) => setCloseNote(e.target.value)}
                      rows={2}
                      placeholder="Reason for closing..."
                      className="w-full px-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-surface focus:outline-none focus:ring-2 focus:ring-danger resize-none"
                    />
                    <div className="flex gap-2">
                      <Button variant="secondary" fullWidth onClick={() => setShowCloseForm(false)}>Cancel</Button>
                      <Button variant="danger" fullWidth disabled={!closeNote.trim()} onClick={() => setConfirmClose(true)}>Close Dispute</Button>
                    </div>
                  </div>
                ) : (
                  <Button variant="ghost" fullWidth onClick={() => setShowCloseForm(true)}>
                    Close Dispute (No Winner)
                  </Button>
                )}

                {/* Add admin note */}
                {showNoteForm ? (
                  <div className="space-y-2">
                    <p className="text-sm font-medium text-text-primary">Add Admin Note</p>
                    <textarea
                      value={adminNote}
                      onChange={(e) => setAdminNote(e.target.value)}
                      rows={2}
                      placeholder="Internal note visible in dispute messages..."
                      className="w-full px-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-surface focus:outline-none focus:ring-2 focus:ring-primary resize-none"
                    />
                    <div className="flex gap-2">
                      <Button variant="secondary" fullWidth onClick={() => setShowNoteForm(false)}>Cancel</Button>
                      <Button variant="primary" fullWidth disabled={!adminNote.trim()} onClick={handleAddNote}>Add Note</Button>
                    </div>
                  </div>
                ) : (
                  <Button variant="ghost" fullWidth onClick={() => setShowNoteForm(true)}>
                    Add Admin Note
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </Modal>

      <ConfirmModal
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={handleResolve}
        title="Confirm Resolution"
        description={`Resolve this dispute in favor of the ${winner}? This action cannot be undone.`}
        confirmLabel="Resolve"
        confirmVariant="danger"
      />

      <ConfirmModal
        isOpen={confirmClose}
        onClose={() => setConfirmClose(false)}
        onConfirm={handleClose}
        title="Close Dispute"
        description="Close this dispute without awarding either party? This action cannot be undone."
        confirmLabel="Close Dispute"
        confirmVariant="danger"
      />
    </div>
  )
}
