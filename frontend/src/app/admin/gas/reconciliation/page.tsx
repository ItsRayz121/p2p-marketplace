'use client'
import { useState, useCallback, useEffect } from 'react'
import { adminApi } from '@/lib/api'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { useAuthStore } from '@/store/auth.store'

type Run = {
  id: string
  ranAt: string
  chain: string | null
  totalOrders: number
  ordersChecked: number
  discrepancyCount: number
  status: string
  notes: string | null
}

type Discrepancy = {
  id: string
  orderId: string | null
  type: string
  description: string
  resolvedAt: string | null
  resolvedBy: string | null
  adminNote: string | null
  createdAt: string
}

type RunDetail = Run & { discrepancies: Discrepancy[] }

function statusVariant(s: string): 'success' | 'warning' | 'danger' | 'default' {
  if (s === 'complete') return 'success'
  if (s === 'running') return 'warning'
  if (s === 'failed') return 'danger'
  return 'default'
}

function fmt(iso: string) {
  return new Date(iso).toLocaleString()
}

export default function GasReconciliationPage() {
  const user = useAuthStore((s) => s.user)
  const isSuperAdmin = user?.role === 'super_admin'

  const [runs, setRuns] = useState<Run[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [selectedRun, setSelectedRun] = useState<RunDetail | null>(null)
  const [runLoading, setRunLoading] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)

  const [triggering, setTriggering] = useState(false)
  const [triggerChain, setTriggerChain] = useState('')
  const [successMsg, setSuccessMsg] = useState<string | null>(null)

  const [resolvingId, setResolvingId] = useState<string | null>(null)
  const [resolveNote, setResolveNote] = useState('')

  const LIMIT = 20

  const fetchRuns = useCallback(async (p = 1) => {
    setLoading(true)
    setError(null)
    try {
      const res = await adminApi.listReconciliationRuns(p, LIMIT)
      setRuns(res.runs)
      setTotal(res.total)
      setPage(p)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load reconciliation runs')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchRuns(1) }, [fetchRuns])

  function flash(msg: string) {
    setSuccessMsg(msg)
    setTimeout(() => setSuccessMsg(null), 3500)
  }

  async function openRun(id: string) {
    setRunLoading(true)
    setRunError(null)
    setSelectedRun(null)
    try {
      const res = await adminApi.getReconciliationRun(id)
      setSelectedRun(res as RunDetail)
    } catch (e: unknown) {
      setRunError(e instanceof Error ? e.message : 'Failed to load run details')
    } finally {
      setRunLoading(false)
    }
  }

  async function triggerRun() {
    setTriggering(true)
    try {
      const res = await adminApi.triggerReconciliation(triggerChain || undefined)
      flash(res.message)
      fetchRuns(1)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to trigger reconciliation')
    } finally {
      setTriggering(false)
    }
  }

  async function resolveDiscrepancy(id: string) {
    if (!resolveNote.trim()) {
      setError('Admin note is required to resolve a discrepancy.')
      return
    }
    try {
      await adminApi.resolveDiscrepancy(id, resolveNote.trim())
      setResolvingId(null)
      setResolveNote('')
      if (selectedRun) {
        const res = await adminApi.getReconciliationRun(selectedRun.id)
        setSelectedRun(res.run as RunDetail)
      }
      flash('Discrepancy resolved.')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to resolve discrepancy')
    }
  }

  const totalPages = Math.ceil(total / LIMIT)

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Reconciliation</h1>
          <p className="text-text-muted text-sm mt-0.5">Detect divergence between the ledger and on-chain reality.</p>
        </div>
        {isSuperAdmin && (
          <div className="flex items-center gap-2">
            <select
              className="border border-border rounded-lg px-3 py-2 text-sm"
              value={triggerChain}
              onChange={(e) => setTriggerChain(e.target.value)}
            >
              <option value="">All chains</option>
              {['TRON','BSC','ETH','BASE','ARB','OP','MATIC','AVAX'].map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <Button size="sm" onClick={triggerRun} disabled={triggering}>
              {triggering ? 'Triggering...' : 'Trigger Run'}
            </Button>
          </div>
        )}
      </div>

      {successMsg && (
        <div className="px-4 py-3 bg-success/10 border border-success/20 rounded-xl text-success text-sm">{successMsg}</div>
      )}
      {error && (
        <div className="px-4 py-3 bg-danger/10 border border-danger/20 rounded-xl text-danger text-sm">{error}</div>
      )}

      {/* Run list */}
      {loading && <LoadingState message="Loading runs..." />}
      {!loading && error && <ErrorState title={error} onRetry={() => fetchRuns(1)} />}
      {!loading && !error && runs.length === 0 && (
        <EmptyState title="No reconciliation runs yet" description="Trigger a run or wait for the daily job." />
      )}

      {!loading && runs.length > 0 && (
        <div className="bg-white rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface border-b border-border">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Run At</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Chain</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Orders</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Checked</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Issues</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Status</th>
                  <th className="px-4 py-3 text-right font-medium text-text-muted">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {runs.map((r) => (
                  <tr key={r.id} className="hover:bg-surface/50 transition-colors">
                    <td className="px-4 py-3 text-text-primary">{fmt(r.ranAt)}</td>
                    <td className="px-4 py-3">
                      {r.chain ? <Badge variant="default" size="sm">{r.chain}</Badge> : <span className="text-text-muted text-xs">All chains</span>}
                    </td>
                    <td className="px-4 py-3 text-text-muted">{r.totalOrders}</td>
                    <td className="px-4 py-3 text-text-muted">{r.ordersChecked}</td>
                    <td className="px-4 py-3">
                      {r.discrepancyCount > 0
                        ? <Badge variant="danger" size="sm">{r.discrepancyCount} issue{r.discrepancyCount !== 1 ? 's' : ''}</Badge>
                        : <Badge variant="success" size="sm">Clean</Badge>}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={statusVariant(r.status)} size="sm">{r.status}</Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button size="sm" variant="ghost" onClick={() => openRun(r.id)}>View</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => fetchRuns(page - 1)}>Prev</Button>
          <span className="text-sm text-text-muted">Page {page} / {totalPages}</span>
          <Button size="sm" variant="secondary" disabled={page >= totalPages} onClick={() => fetchRuns(page + 1)}>Next</Button>
        </div>
      )}

      {/* Run detail modal */}
      {(runLoading || selectedRun || runError) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[85vh] overflow-y-auto">
            <div className="p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold text-text-primary">Run Detail</h2>
                <button onClick={() => { setSelectedRun(null); setRunError(null) }} className="text-text-muted hover:text-text-primary text-xl leading-none">&times;</button>
              </div>

              {runLoading && <LoadingState message="Loading..." />}
              {runError && <p className="text-danger text-sm">{runError}</p>}

              {selectedRun && (
                <div className="space-y-4">
                  <div className="grid grid-cols-3 gap-3 text-sm">
                    <div className="bg-surface rounded-lg p-3">
                      <p className="text-text-muted text-xs">Chain</p>
                      <p className="font-medium">{selectedRun.chain ?? 'All'}</p>
                    </div>
                    <div className="bg-surface rounded-lg p-3">
                      <p className="text-text-muted text-xs">Orders Checked</p>
                      <p className="font-medium">{selectedRun.ordersChecked} / {selectedRun.totalOrders}</p>
                    </div>
                    <div className="bg-surface rounded-lg p-3">
                      <p className="text-text-muted text-xs">Discrepancies</p>
                      <p className={`font-medium ${selectedRun.discrepancyCount > 0 ? 'text-danger' : 'text-success'}`}>
                        {selectedRun.discrepancyCount}
                      </p>
                    </div>
                  </div>

                  {selectedRun.discrepancies.length === 0 ? (
                    <EmptyState title="No discrepancies" description="All checked orders matched on-chain state." />
                  ) : (
                    <div className="space-y-3">
                      <h3 className="font-semibold text-text-primary text-sm">Discrepancies</h3>
                      {selectedRun.discrepancies.map((d) => (
                        <div key={d.id} className="border border-border rounded-xl p-4 space-y-2">
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <Badge variant={d.resolvedAt ? 'success' : 'danger'} size="sm" className="mr-2">
                                {d.resolvedAt ? 'Resolved' : 'Open'}
                              </Badge>
                              <code className="text-xs bg-surface px-1.5 py-0.5 rounded">{d.type}</code>
                            </div>
                            {!d.resolvedAt && isSuperAdmin && (
                              <Button size="sm" variant="ghost" onClick={() => setResolvingId(d.id)}>Resolve</Button>
                            )}
                          </div>
                          <p className="text-sm text-text-primary">{d.description}</p>
                          {d.orderId && (
                            <p className="text-xs text-text-muted">Order: <code className="bg-surface px-1 py-0.5 rounded">{d.orderId}</code></p>
                          )}
                          {d.adminNote && (
                            <p className="text-xs text-text-muted italic">Note: {d.adminNote}</p>
                          )}
                          {d.resolvedAt && (
                            <p className="text-xs text-success">Resolved {fmt(d.resolvedAt)} by {d.resolvedBy}</p>
                          )}

                          {resolvingId === d.id && (
                            <div className="flex gap-2 pt-1">
                              <input
                                className="flex-1 border border-border rounded-lg px-3 py-1.5 text-sm"
                                placeholder="Admin note (required)"
                                value={resolveNote}
                                onChange={(e) => setResolveNote(e.target.value)}
                              />
                              <Button size="sm" onClick={() => resolveDiscrepancy(d.id)} disabled={!resolveNote.trim()}>Save</Button>
                              <Button size="sm" variant="secondary" onClick={() => setResolvingId(null)}>Cancel</Button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
