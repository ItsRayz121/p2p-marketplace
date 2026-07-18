'use client'
import { useState, useCallback } from 'react'
import { adminApi } from '@/lib/api'
import { fmtDate, fmtDateTime } from '@/lib/fmt'
import { usePolling } from '@/hooks/usePolling'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Badge } from '@/components/ui/Badge'
import { ArrowDownToLine } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { ConfirmModal } from '@/components/ui/ConfirmModal'

// ─── Types ─────────────────────────────────────────────────────────────────────

type DepositStatus = 'detected' | 'credited' | 'rejected'

interface Deposit {
  id: string
  txHash: string
  chain: string
  asset: string
  symbol: string
  fromAddress: string
  toAddress: string
  amount: string
  confirmations: number
  userId: string | null
  user?: { id: string; username: string; email: string } | null
  status: DepositStatus
  rejectionReason?: string | null
  detectedAt: string
  creditedAt?: string | null
}

interface DepositsResponse {
  deposits: Deposit[]
  pagination: { page: number; limit: number; total: number; pages: number }
}

// ─── Display helpers ─────────────────────────────────────────────────────────────

type StatusFilter = 'all' | 'detected' | 'credited' | 'rejected'

const STATUS_TABS: { value: StatusFilter; label: string }[] = [
  { value: 'all',      label: 'All' },
  { value: 'credited', label: 'Credited' },
  { value: 'detected', label: 'Pending' },
  { value: 'rejected', label: 'Rejected' },
]

const statusVariant = (s: DepositStatus): 'default' | 'success' | 'warning' | 'danger' | 'outline' => {
  if (s === 'credited') return 'success'
  if (s === 'detected') return 'warning'
  if (s === 'rejected') return 'danger'
  return 'outline'
}

const statusLabel = (s: DepositStatus): string => {
  const labels: Record<DepositStatus, string> = {
    detected: 'Pending',
    credited: 'Credited',
    rejected: 'Rejected',
  }
  return labels[s] ?? s
}

// Deposit.chain is the ChainConfig id (ethereum, bsc, polygon, …), not a network label.
const EXPLORER_TX_BASE: Record<string, string> = {
  bsc:      'https://bscscan.com/tx',
  ethereum: 'https://etherscan.io/tx',
  polygon:  'https://polygonscan.com/tx',
  arbitrum: 'https://arbiscan.io/tx',
  optimism: 'https://optimistic.etherscan.io/tx',
  base:     'https://basescan.org/tx',
  aptos:    'https://explorer.aptoslabs.com/txn',
  tron:     'https://tronscan.org/#/transaction',
}

const explorerTxUrl = (chain: string, txHash: string): string => {
  const base = EXPLORER_TX_BASE[chain.toLowerCase()]
  return base ? `${base}/${txHash}` : '#'
}

// ─── Component ─────────────────────────────────────────────────────────────────

export default function DepositsPage() {
  const [deposits, setDeposits] = useState<Deposit[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('credited')

  const [selected, setSelected] = useState<Deposit | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [creditReason, setCreditReason] = useState('')
  const [rejectReason, setRejectReason] = useState('')
  const [confirmCredit, setConfirmCredit] = useState(false)
  const [confirmReject, setConfirmReject] = useState(false)

  const limit = 20

  // Detection-path liveness (Moralis webhook vs RPC poller backstop).
  const [health, setHealth] = useState<any | null>(null)
  const fetchHealth = useCallback(async () => {
    try { setHealth(await adminApi.getDepositDetectionHealth()) } catch { /* banner is best-effort */ }
  }, [])
  usePolling(fetchHealth, 60_000)

  const fetchDeposits = useCallback(async () => {
    try {
      const params: Record<string, string | number | undefined> = { page, limit }
      if (statusFilter !== 'all') params.status = statusFilter
      const data = await adminApi.getDeposits(params) as DepositsResponse
      setDeposits(data.deposits ?? [])
      setTotal(data.pagination?.total ?? 0)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load deposits')
    } finally {
      setLoading(false)
    }
  }, [page, statusFilter])

  usePolling(fetchDeposits, 30_000)

  function openModal(d: Deposit) {
    setSelected(d)
    setCreditReason('')
    setRejectReason('')
    setActionError(null)
    setModalOpen(true)
  }

  async function handleForceCredit() {
    if (!selected || !creditReason.trim()) return
    setBusy(true)
    setActionError(null)
    try {
      await adminApi.forceCreditDeposit(selected.id, { reason: creditReason.trim() })
      setConfirmCredit(false)
      setModalOpen(false)
      fetchDeposits()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to credit deposit')
    } finally {
      setBusy(false)
    }
  }

  async function handleReject() {
    if (!selected || !rejectReason.trim()) return
    setBusy(true)
    setActionError(null)
    try {
      await adminApi.rejectDeposit(selected.id, { reason: rejectReason.trim() })
      setConfirmReject(false)
      setModalOpen(false)
      fetchDeposits()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to reject deposit')
    } finally {
      setBusy(false)
    }
  }

  async function handleRefresh() {
    if (!selected) return
    setBusy(true)
    setActionError(null)
    try {
      await adminApi.refreshDepositConfirmations(selected.id)
      fetchDeposits()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to refresh confirmations')
    } finally {
      setBusy(false)
    }
  }

  const totalPages = Math.ceil(total / limit)

  if (loading) return <LoadingState message="Loading deposits..." />
  if (error && deposits.length === 0) return <ErrorState title={error} onRetry={fetchDeposits} />

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Deposits</h1>
        <p className="text-text-muted text-sm mt-0.5">
          On-chain crypto deposits credited to user balances — pending, credited, and rejected
        </p>
      </div>

      {/* Detection-path liveness: stale Moralis + healthy poller = stream broken,
          backstop carrying detection. */}
      {health && (() => {
        const moralisAt = health.moralisLastWebhookAt ? new Date(health.moralisLastWebhookAt) : null
        const moralisAgeH = moralisAt ? (Date.now() - moralisAt.getTime()) / 3_600_000 : null
        const pollerAt = health.evmPoller?.at ? new Date(health.evmPoller.at) : null
        const pollerAgeMin = pollerAt ? (Date.now() - pollerAt.getTime()) / 60_000 : null
        const pollerStale = pollerAgeMin === null || pollerAgeMin > 10
        const moralisStale = moralisAgeH === null || moralisAgeH > 24
        return (
          <div className={`rounded-xl border px-4 py-3 text-sm ${pollerStale ? 'border-danger/40 bg-danger/5' : moralisStale ? 'border-warning/40 bg-warning/5' : 'border-border bg-surface'}`}>
            <p className="font-medium text-text-primary">Deposit detection health</p>
            <p className="text-xs text-text-muted mt-1">
              Moralis webhook: {moralisAt ? `last delivery ${fmtDateTime(health.moralisLastWebhookAt)}` : 'no delivery recorded yet'}
              {moralisStale && ' — stale; the RPC poller is the active detection path'}
            </p>
            <p className="text-xs text-text-muted mt-0.5">
              RPC poller (backstop): {pollerAt ? `last tick ${fmtDateTime(health.evmPoller.at)}` : 'no heartbeat yet'}
              {pollerStale && ' — NOT RUNNING; deposits may go undetected, check workers'}
            </p>
          </div>
        )
      })()}

      {/* Status filter tabs */}
      <div className="admin-toolbar gap-1 p-1 bg-surface rounded-xl border border-border max-w-full">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => { setStatusFilter(tab.value); setPage(1); setLoading(true) }}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              statusFilter === tab.value
                ? 'bg-surface text-text-primary shadow-sm border border-border'
                : 'text-text-muted hover:text-text-primary'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {deposits.length === 0 ? (
        <EmptyState
          icon={ArrowDownToLine}
          title="No deposits"
          description={`No ${statusFilter === 'all' ? '' : STATUS_TABS.find((t) => t.value === statusFilter)?.label.toLowerCase() ?? ''} deposits found.`}
        />
      ) : (
        <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm stack-sm">
              <thead className="bg-surface border-b border-border">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">User</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Amount</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Chain</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Confirms</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Status</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Date</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {deposits.map((d) => (
                  <tr key={d.id} className="hover:bg-surface/50 transition-colors">
                    <td className="px-4 py-3" data-label="User">
                      <div className="min-w-0">
                        <p className="font-medium text-text-primary">{d.user?.username ?? '—'}</p>
                        <p className="text-xs text-text-muted">{d.user?.email ?? (d.userId ? d.userId.slice(-8) : 'unknown address')}</p>
                      </div>
                    </td>
                    <td className="px-4 py-3" data-label="Amount">
                      <p className="font-semibold text-text-primary">{d.amount} {d.symbol}</p>
                    </td>
                    <td className="px-4 py-3 text-sm text-text-secondary" data-label="Chain">
                      <div className="min-w-0">
                        <p className="uppercase">{d.chain}</p>
                        {d.txHash ? (
                          <a
                            href={explorerTxUrl(d.chain, d.txHash)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-primary hover:underline font-mono"
                          >
                            {d.txHash.slice(0, 10)}…
                          </a>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-text-secondary text-xs" data-label="Confirms">
                      {d.confirmations}
                    </td>
                    <td className="px-4 py-3" data-label="Status">
                      <Badge variant={statusVariant(d.status)} size="sm">
                        {statusLabel(d.status)}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-text-secondary text-xs" data-label="Date">
                      <div className="min-w-0">
                        <p>{fmtDate(d.detectedAt)}</p>
                        {d.creditedAt && (
                          <p className="text-text-muted">credited: {fmtDate(d.creditedAt)}</p>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button size="sm" variant="ghost" onClick={() => openModal(d)}>
                        {d.status === 'credited' ? 'View' : 'Review'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-border">
              <p className="text-text-muted text-sm">Page {page} of {totalPages} ({total} total)</p>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Prev</Button>
                <Button size="sm" variant="secondary" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next</Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Detail / Review Modal ───────────────────────────────────────────── */}
      <Modal isOpen={modalOpen} onClose={() => setModalOpen(false)} title="Deposit Details" size="lg">
        {selected && (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-4 p-4 bg-surface rounded-xl text-sm">
              <div>
                <p className="text-text-muted">User</p>
                <p className="font-medium text-text-primary">{selected.user?.username ?? '—'}</p>
                <p className="text-xs text-text-muted">{selected.user?.email}</p>
                <p className="text-xs text-text-muted font-mono">{selected.userId ?? 'no user'}</p>
              </div>
              <div>
                <p className="text-text-muted">Amount</p>
                <p className="font-semibold text-text-primary">{selected.amount} {selected.symbol}</p>
                <p className="text-text-muted mt-2">Chain</p>
                <p className="text-text-primary uppercase">{selected.chain}</p>
              </div>
              <div>
                <p className="text-text-muted">Status</p>
                <Badge variant={statusVariant(selected.status)}>{statusLabel(selected.status)}</Badge>
              </div>
              <div>
                <p className="text-text-muted">Confirmations</p>
                <p className="text-text-secondary">{selected.confirmations}</p>
              </div>
              <div className="col-span-2">
                <p className="text-text-muted">To Address</p>
                <p className="font-mono text-xs text-text-primary break-all mt-0.5">{selected.toAddress}</p>
              </div>
              <div className="col-span-2">
                <p className="text-text-muted">Transaction Hash</p>
                <a
                  href={explorerTxUrl(selected.chain, selected.txHash)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-xs text-primary break-all mt-0.5 hover:underline"
                >
                  {selected.txHash}
                </a>
              </div>
              <div>
                <p className="text-text-muted">Detected</p>
                <p className="text-text-secondary">{fmtDateTime(selected.detectedAt)}</p>
              </div>
              {selected.creditedAt && (
                <div>
                  <p className="text-text-muted">Credited</p>
                  <p className="text-text-secondary">{fmtDateTime(selected.creditedAt)}</p>
                </div>
              )}
            </div>

            {selected.rejectionReason && (
              <div className="px-4 py-3 bg-danger/5 border border-danger/20 rounded-xl text-sm text-danger">
                Rejection reason: {selected.rejectionReason}
              </div>
            )}

            {actionError && (
              <div className="px-3 py-2 bg-danger/10 border border-danger/20 rounded-lg text-danger text-sm">
                {actionError}
              </div>
            )}

            {selected.status === 'credited' ? (
              <p className="text-text-muted text-sm text-center">This deposit has been credited to the user&apos;s balance.</p>
            ) : (
              <div className="space-y-4">
                {selected.userId ? (
                  <div>
                    <label className="block text-sm font-medium text-text-primary mb-1.5">
                      Force-credit reason (10–500 chars)
                    </label>
                    <textarea
                      value={creditReason}
                      onChange={(e) => setCreditReason(e.target.value)}
                      rows={2}
                      placeholder="e.g. Verified on-chain via block explorer — RPC was down when detected"
                      className="w-full px-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-surface focus:outline-none focus:ring-2 focus:ring-primary resize-none"
                    />
                    <p className="text-xs text-text-muted mt-1">
                      Credits the deposit to the user&apos;s balance after on-chain verification. Use only for stuck/pending deposits.
                    </p>
                  </div>
                ) : (
                  <div className="px-4 py-3 bg-warning/5 border border-warning/20 rounded-xl text-sm text-warning">
                    This deposit has no associated user (unknown deposit address) — it cannot be credited.
                  </div>
                )}

                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1.5">
                    Reject reason (10–500 chars)
                  </label>
                  <textarea
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    rows={2}
                    placeholder="e.g. Duplicate / spam token / tx reverted"
                    className="w-full px-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-surface focus:outline-none focus:ring-2 focus:ring-danger resize-none"
                  />
                </div>

                <div className="flex gap-3 pt-1">
                  <Button
                    variant="secondary"
                    onClick={handleRefresh}
                    disabled={busy}
                    className="flex-1"
                  >
                    Refresh Confirms
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => { if (rejectReason.trim().length >= 10) setConfirmReject(true) }}
                    disabled={busy || rejectReason.trim().length < 10}
                    className="flex-1"
                  >
                    Reject
                  </Button>
                  {selected.userId && (
                    <Button
                      variant="primary"
                      onClick={() => { if (creditReason.trim().length >= 10) setConfirmCredit(true) }}
                      disabled={busy || creditReason.trim().length < 10}
                      className="flex-1"
                    >
                      Force Credit
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      <ConfirmModal
        isOpen={confirmCredit}
        onClose={() => setConfirmCredit(false)}
        onConfirm={handleForceCredit}
        title="Force-Credit Deposit"
        description={`Credit ${selected?.amount} ${selected?.symbol} to ${selected?.user?.username ?? 'the user'}? This verifies the tx on-chain and adds the balance. This cannot be undone.`}
        confirmLabel="Force Credit"
        confirmVariant="primary"
      />

      <ConfirmModal
        isOpen={confirmReject}
        onClose={() => setConfirmReject(false)}
        onConfirm={handleReject}
        title="Reject Deposit"
        description={`Reject this ${selected?.amount} ${selected?.symbol} deposit? It will not be credited.`}
        confirmLabel="Reject"
        confirmVariant="danger"
      />
    </div>
  )
}
