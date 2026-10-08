'use client'
import { useState, useCallback, useEffect } from 'react'
import Link from 'next/link'
import { ctmApi, adminApi, type DisputeFilter, type DisputeOverview, type DisputeOverviewRow } from '@/lib/api'
import { usePolling } from '@/hooks/usePolling'
import { Modal } from '@/components/ui/Modal'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { ErrorState } from '@/components/ui/ErrorState'
import { ShieldAlert } from 'lucide-react'
import { DisputeMarketTabs } from '@/components/admin/disputes/DisputeMarketTabs'
import { DisputeFilterBar } from '@/components/admin/disputes/DisputeFilterBar'
import { DisputeCasesTable } from '@/components/admin/disputes/DisputeCasesTable'
import { DisputeInsightsPanel } from '@/components/admin/disputes/DisputeInsightsPanel'
import { disputeOutcomeLabel, disputeOutcomeVariant } from '@/components/admin/disputes/disputeLabels'

/* eslint-disable @typescript-eslint/no-explicit-any */

function fmtDt(iso: string) {
  return new Date(iso).toLocaleString('en-PK', { dateStyle: 'short', timeStyle: 'short' })
}

// Quick-pick resolution notes for CTM disputes, split by ruling. CTM settlement
// is manual (platform moves no tokens), so these read as rulings/guidance.
const CTM_RESOLUTION_TEMPLATES: Record<'buyer' | 'seller' | 'split' | 'dismissed', string[]> = {
  buyer: [
    'Buyer paid the agreed PKR but the seller did not deliver the tokens. Ruling in the buyer’s favour — seller to deliver the tokens or refund. Settle manually.',
    'Tokens delivered did not match the agreed amount/token. Ruling in the buyer’s favour based on the evidence.',
  ],
  seller: [
    'Buyer did not complete the PKR payment, or proof was invalid. Ruling in the seller’s favour — no tokens are owed.',
    'Buyer’s claim is unsupported by the evidence; tokens were delivered as agreed. Ruling in the seller’s favour.',
  ],
  split: [
    'Both parties share responsibility (e.g. partial delivery / partial payment). Recommend a proportional settlement to be arranged manually.',
  ],
  dismissed: [
    'Dispute opened by mistake or resolved between the parties before review. Closed with no fault on either side.',
    'A misunderstanding rather than a breach — both sides acted in good faith. Closed with no ruling against either party.',
    'Insufficient evidence to rule either way, and no loss reported by either side. Closed without fault.',
  ],
}

const PAGE_SIZE = 20

export default function AdminCtmDisputesPage() {
  const [overview, setOverview] = useState<DisputeOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<DisputeFilter>('all')
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<DisputeOverviewRow | null>(null)
  const [detail, setDetail] = useState<any | null>(null)
  const [tradeMessages, setTradeMessages] = useState<any[]>([])
  const [detailLoading, setDetailLoading] = useState(false)
  const [winner, setWinner] = useState<'buyer' | 'seller' | 'split' | 'dismissed'>('buyer')
  const [resolution, setResolution] = useState('')
  const [ackSettled, setAckSettled] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [evidenceMsg, setEvidenceMsg] = useState('')
  const [sendingEvidence, setSendingEvidence] = useState(false)
  const [evidenceSent, setEvidenceSent] = useState(false)

  // Debounce the search box.
  useEffect(() => {
    const t = setTimeout(() => { setQuery(search.trim()); setPage(1) }, 350)
    return () => clearTimeout(t)
  }, [search])

  // Every dispute — open, escalated, resolved and closed — so completed cases stay reviewable.
  const fetchDisputes = useCallback(async () => {
    try {
      setOverview(await adminApi.getDisputeOverview({ market: 'ctm', filter, page, limit: PAGE_SIZE, ...(query ? { search: query } : {}) }))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load disputes')
    }
  }, [filter, page, query])

  usePolling(fetchDisputes, 30000)
  useEffect(() => { void fetchDisputes() }, [fetchDisputes])

  async function requestEvidence() {
    if (!selected || !evidenceMsg.trim()) return
    setSendingEvidence(true)
    try {
      await ctmApi.adminAddDisputeMessage(selected.tradeRef, evidenceMsg.trim())
      setEvidenceMsg('')
      setEvidenceSent(true)
      // refresh detail so the new message shows in the thread
      try {
        const full = await ctmApi.getTrade(selected.tradeRef)
        setDetail(full)
      } catch { /* ignore */ }
      setTimeout(() => setEvidenceSent(false), 3000)
    } catch (err) {
      alert((err as Error).message ?? 'Failed to send message')
    } finally {
      setSendingEvidence(false)
    }
  }

  async function openDispute(d: DisputeOverviewRow) {
    setSelected(d); setWinner('buyer'); setResolution(''); setAckSettled(false)
    setEvidenceMsg(''); setEvidenceSent(false)
    setDetail(null); setTradeMessages([]); setDetailLoading(true)
    try {
      const full = await ctmApi.getTrade(d.tradeRef)
      setDetail(full)
      try {
        const msgs = await ctmApi.getMessages(d.tradeRef)
        setTradeMessages(Array.isArray(msgs) ? msgs : [])
      } catch { setTradeMessages([]) }
    } catch {
      // fall back to the summary data we already have
    } finally {
      setDetailLoading(false)
    }
  }

  const handleResolve = async () => {
    if (!selected || !resolution.trim()) return
    if (winner !== 'dismissed' && !ackSettled) return
    setSubmitting(true)
    try {
      await ctmApi.adminResolveDispute(selected.tradeRef, { winner, resolution })
      setSelected(null); setResolution(''); setAckSettled(false)
      await fetchDisputes()
    } catch (err: unknown) {
      alert((err as Error).message ?? 'Failed to resolve dispute')
    } finally {
      setSubmitting(false)
    }
  }

  const t = detail
  const buyerName = t?.buyer?.username ?? selected?.buyer.username ?? 'Buyer'
  const sellerName = t?.seller?.username ?? selected?.seller.username ?? 'Seller'
  const proofs = detail?.proofs ?? []
  const messages = tradeMessages
  const disputeMessages = detail?.dispute?.messages ?? []

  const isClosed = selected?.disputeStatus === 'resolved'
  const rows = overview?.rows ?? []
  const totalPages = overview?.pagination.pages ?? 1

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">CTM Marketplace Disputes</h1>
          <p className="text-text-muted text-sm mt-0.5">Review evidence, rule on the outcome, then settle funds manually and record the decision. Completed cases stay in the history.</p>
        </div>
        <DisputeMarketTabs active="ctm" />
      </div>

      <div className="rounded-xl border border-border bg-surface p-4 shadow-card space-y-3">
        <DisputeFilterBar value={filter} counts={overview?.counts} onChange={(f) => { setFilter(f); setPage(1) }} />
        <label className="block">
          <span className="sr-only">Search disputes</span>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search trade ref or username…"
            className="w-full sm:max-w-sm rounded-lg border border-border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </label>
      </div>

      {error && !overview ? (
        <ErrorState title={error} onRetry={fetchDisputes} />
      ) : !overview ? (
        <div className="space-y-3">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="bg-surface shadow-card border border-border rounded-xl h-16 animate-pulse" />)}</div>
      ) : rows.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl py-16 text-center">
          <ShieldAlert className="w-8 h-8 text-text-muted mx-auto mb-2" />
          <p className="text-text-primary font-medium">{filter === 'all' && !query ? 'No CTM disputes yet' : 'No disputes match this filter'}</p>
          <p className="text-text-muted text-sm mt-1">CTM token trades that buyers or sellers escalate will appear here for review.</p>
        </div>
      ) : (
        <>
          <DisputeCasesTable rows={rows} onReview={(r) => void openDispute(r)} />
          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-text-muted">Page {page} of {totalPages} · {overview.pagination.total} cases</p>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Prev</Button>
                <Button size="sm" variant="secondary" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Resolve modal */}
      <Modal
        isOpen={!!selected}
        onClose={() => setSelected(null)}
        title={selected ? `Dispute — ${selected.tradeRef.slice(-12)}` : 'Dispute'}
        size="lg"
        footer={
          <div className="flex gap-3">
            <button onClick={() => setSelected(null)} className="flex-1 border border-border py-2.5 rounded-xl text-sm font-medium text-text-primary hover:bg-surface-alt">{isClosed ? 'Close' : 'Cancel'}</button>
            {/* A dismissal moves nothing and rules against nobody, so the manual-
                settlement acknowledgment doesn't apply and isn't required. */}
            {!isClosed && (
            <button onClick={handleResolve} disabled={submitting || !resolution.trim() || (winner !== 'dismissed' && !ackSettled)} className="flex-1 bg-primary text-white py-2.5 rounded-xl text-sm font-semibold disabled:opacity-50">
              {submitting ? 'Recording…' : winner === 'dismissed' ? 'Dismiss dispute (no fault)' : `Record ruling: ${winner}`}
            </button>
            )}
          </div>
        }
      >
        {selected && (
          <div className="space-y-5">
            {detailLoading && (
              <div className="flex items-center gap-2 text-xs text-text-muted"><Spinner size="sm" /> Loading full trade detail…</div>
            )}

            {/* Parties + amounts */}
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="bg-surface-alt/50 border border-border rounded-xl p-3">
                <p className="text-[11px] font-semibold text-text-muted uppercase tracking-wide">Buyer</p>
                {t?.buyer?.id
                  ? <Link href={`/admin/users/${t.buyer.id}`} className="font-semibold text-text-primary hover:text-primary hover:underline">{buyerName}</Link>
                  : selected ? <Link href={`/admin/users/${selected.buyer.id}`} className="font-semibold text-text-primary hover:text-primary hover:underline">{buyerName}</Link> : <p className="font-semibold text-text-primary">{buyerName}</p>}
              </div>
              <div className="bg-surface-alt/50 border border-border rounded-xl p-3">
                <p className="text-[11px] font-semibold text-text-muted uppercase tracking-wide">Seller</p>
                {t?.seller?.id
                  ? <Link href={`/admin/users/${t.seller.id}`} className="font-semibold text-text-primary hover:text-primary hover:underline">{sellerName}</Link>
                  : selected ? <Link href={`/admin/users/${selected.seller.id}`} className="font-semibold text-text-primary hover:text-primary hover:underline">{sellerName}</Link> : <p className="font-semibold text-text-primary">{sellerName}</p>}
              </div>
              <div className="bg-surface-alt/50 border border-border rounded-xl p-3">
                <p className="text-[11px] font-semibold text-text-muted uppercase tracking-wide">PKR Amount</p>
                <p className="font-bold text-text-primary">{t?.fiatAmount != null ? `PKR ${Number(t.fiatAmount).toLocaleString()}` : '—'}</p>
              </div>
              <div className="bg-surface-alt/50 border border-border rounded-xl p-3">
                <p className="text-[11px] font-semibold text-text-muted uppercase tracking-wide">Token</p>
                <p className="font-bold text-text-primary">
                  {t?.tokenAmount ? Number(t.tokenAmount).toLocaleString() : ''} {t?.token?.symbol ?? ''}
                </p>
                {(detail?.networkLabel || detail?.listing?.networkLabel) && (
                  <p className="text-xs text-text-muted">{detail?.listing?.networkLabel ?? detail?.networkLabel}</p>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge variant={disputeOutcomeVariant(selected.disputeStatus, selected.resolutionType)} size="sm">{disputeOutcomeLabel(selected.disputeStatus, selected.resolutionType, selected.winner)}</Badge>
              <span className="text-text-muted">Trade status: <strong className="text-text-primary">{selected.tradeStatus.replace(/_/g, ' ')}</strong></span>
            </div>

            {/* Reason + description */}
            <div className="bg-danger/5 border border-danger/30 rounded-xl p-4 text-sm space-y-1">
              <p className="font-medium text-danger">Reason: {selected.reason.replace(/_/g, ' ')}</p>
              <p className="text-text-secondary">{detail?.dispute?.description ?? ''}</p>
              <p className="text-xs text-text-muted">Opened by {selected.openedById === selected.buyer.id ? buyerName : selected.openedById === selected.seller.id ? sellerName : 'a party'} · {fmtDt(selected.createdAt)}</p>
            </div>

            {/* Payment method */}
            {(detail?.listing?.paymentMethods?.length || detail?.paymentMethod) && (
              <div className="text-sm">
                <p className="text-text-muted text-xs mb-1">Payment method</p>
                <p className="text-text-primary">{detail?.listing?.paymentMethods?.join(', ') ?? detail?.paymentMethod}</p>
              </div>
            )}

            {/* Evidence / proofs */}
            {proofs.length > 0 ? (
              <div className="space-y-2">
                <p className="text-sm font-medium text-text-primary">Evidence ({proofs.length})</p>
                <div className="grid grid-cols-2 gap-2">
                  {proofs.map((p: any, i: number) => (
                    p.fileUrl ? (
                      <a key={i} href={p.fileUrl} target="_blank" rel="noopener noreferrer">
                        <img loading="lazy" decoding="async" src={p.fileUrl} alt="proof" className="w-full h-32 object-cover rounded-xl border border-border" />
                        <p className="text-xs text-text-muted mt-1">{p.proofType} · {new Date(p.createdAt).toLocaleDateString()}</p>
                      </a>
                    ) : (
                      <div key={i} className="h-32 rounded-xl border border-border bg-surface-alt flex items-center justify-center text-xs text-text-muted">{p.proofType}</div>
                    )
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-xs text-text-muted">No proof files were attached to this trade.</p>
            )}

            {/* Trade chat */}
            {messages.length > 0 && (
              <div>
                <p className="text-sm font-medium text-text-primary mb-2">Trade chat ({messages.length})</p>
                <div className="bg-surface-alt/50 rounded-xl border border-border p-3 max-h-40 overflow-y-auto space-y-1.5">
                  {messages.map((m: any, i: number) => (
                    <p key={m.id ?? i} className="text-xs text-text-secondary">
                      <span className="font-semibold">{m.senderId === t?.buyer?.id ? buyerName : m.senderId === t?.seller?.id ? sellerName : 'Admin'}:</span> {m.message}
                      <span className="text-text-muted ml-1">{fmtDt(m.createdAt)}</span>
                    </p>
                  ))}
                </div>
              </div>
            )}

            {/* Dispute messages */}
            {disputeMessages.length > 0 && (
              <div>
                <p className="text-sm font-medium text-text-primary mb-2">Dispute messages ({disputeMessages.length})</p>
                <div className="bg-surface-alt/50 rounded-xl border border-border p-3 max-h-40 overflow-y-auto space-y-1.5">
                  {disputeMessages.map((m: any, i: number) => (
                    <p key={m.id ?? i} className="text-xs text-text-secondary">
                      <span className="text-text-muted">{fmtDt(m.createdAt)} · </span>{m.message}
                    </p>
                  ))}
                </div>
              </div>
            )}

            {/* Previous resolution if re-opened */}
            {selected.resolution && (
              <div className="text-sm bg-surface-alt/50 border border-border rounded-xl p-3">
                <p className="text-text-muted text-xs mb-0.5">Previous resolution note</p>
                <p className="text-text-secondary">{selected.resolution}</p>
              </div>
            )}

            {/* Participants' dispute history + full case timeline */}
            <div className="border-t border-border pt-4">
              <DisputeInsightsPanel market="ctm" disputeId={selected.id} />
            </div>

            {!isClosed && (<>
            {/* ── Request more evidence ── */}
            <div className="border-t border-border pt-4">
              <label className="block text-sm font-medium text-text-primary mb-1.5">Request more evidence</label>
              <p className="text-xs text-text-muted mb-2">Send a message to both buyer and seller asking for more information. This does not resolve the dispute.</p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={evidenceMsg}
                  onChange={(e) => setEvidenceMsg(e.target.value)}
                  placeholder="e.g. Please upload your bank transfer receipt with timestamp"
                  className="flex-1 border border-border rounded-xl px-3 py-2 text-sm bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-primary"
                />
                <button
                  onClick={requestEvidence}
                  disabled={sendingEvidence || !evidenceMsg.trim()}
                  className="px-4 py-2 rounded-xl bg-surface-alt border border-border text-sm font-medium text-text-primary hover:bg-surface disabled:opacity-50"
                >
                  {sendingEvidence ? 'Sending…' : 'Send'}
                </button>
              </div>
              {evidenceSent && <p className="text-xs text-success mt-1.5">Message sent to both parties.</p>}
            </div>

            {/* ── Ruling ── */}
            <div className="border-t border-border pt-4 space-y-3">
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1.5">Ruling</label>
                <div className="grid grid-cols-2 gap-2">
                  {(['buyer', 'seller', 'split', 'dismissed'] as const).map((w) => (
                    <button key={w} type="button" onClick={() => setWinner(w)}
                      className={`py-2 px-2 rounded-xl border text-sm font-medium transition-colors ${winner === w ? 'border-primary bg-primary text-white' : 'border-border text-text-primary hover:bg-surface-alt'}`}>
                      {w === 'buyer' ? `In favour of ${buyerName}` : w === 'seller' ? `In favour of ${sellerName}` : w === 'split' ? 'Split' : 'Dismiss (no fault)'}
                    </button>
                  ))}
                </div>
                {winner === 'dismissed' && (
                  <p className="mt-2 text-xs text-text-secondary bg-surface-alt border border-border rounded-xl p-2.5">
                    Closes the case with <strong>no ruling against either side</strong>. Neither party is penalised — no
                    bond is seized, no points are clawed back, and no dispute loss is recorded. The reduced trade limit
                    lifts for both users, and <strong>the trade reopens at the step it was on</strong> so they can finish
                    it normally. The dispute stays on record. Note: a trade can only be disputed once, so if it goes
                    wrong again they will need to contact support.
                  </p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-text-primary mb-1.5">Resolution note *</label>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {CTM_RESOLUTION_TEMPLATES[winner].map((tpl, i) => (
                    <button key={i} type="button" onClick={() => setResolution(tpl)} title={tpl}
                      className="px-2.5 py-1 rounded-full text-xs border border-border text-text-secondary hover:bg-primary/10 hover:border-primary/40 transition-colors text-left max-w-full truncate">
                      {tpl.length > 48 ? `${tpl.slice(0, 48)}…` : tpl}
                    </button>
                  ))}
                </div>
                <textarea rows={3} value={resolution} onChange={(e) => setResolution(e.target.value)}
                  placeholder="Explain the decision and what settlement was performed (min 10 chars)… or pick a template above"
                  className="w-full border border-border rounded-xl px-3 py-2.5 text-sm bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-primary resize-none" />
              </div>

              {/* Manual-settlement acknowledgment — escrow release is NOT automated.
                  Hidden for a dismissal: nothing is owed, so there is nothing to settle. */}
              {winner !== 'dismissed' && (
                <label className="flex items-start gap-2 text-xs text-text-secondary bg-warning/10 border border-warning/30 rounded-xl p-3 cursor-pointer">
                  <input type="checkbox" checked={ackSettled} onChange={(e) => setAckSettled(e.target.checked)} className="mt-0.5" />
                  <span>
                    I understand this records the ruling and updates the trade status only — it does <strong>not</strong> move
                    any tokens or funds. I confirm the agreed tokens/refund have been (or will be) settled manually.
                  </span>
                </label>
              )}
            </div>
            </>)}
          </div>
        )}
      </Modal>
    </div>
  )
}
