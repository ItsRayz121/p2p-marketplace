'use client'
import { useState, useCallback, useEffect } from 'react'
import Link from 'next/link'
import { adminApi } from '@/lib/api'
import { fmtDateTime } from '@/lib/fmt'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
import { Button } from '@/components/ui/Button'
import { FileText } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'

interface AuditEntry {
  id: string
  userId: string
  user?: { email: string; username: string }
  action: string
  targetType?: string | null
  targetId?: string | null
  details: unknown
  ip?: string | null
  userAgent?: string | null
  createdAt: string
}

// Build a clickable link for an audit target where one makes sense.
function targetHref(type?: string | null, id?: string | null): string | null {
  if (!id) return null
  const t = (type ?? '').toLowerCase()
  if (t === 'user') return `/admin/users/${id}`
  if (t === 'trade') return `/admin/trades/${id}`
  if (t === 'withdrawal') return `/admin/withdrawals/${id}`
  return null
}

interface AuditLogResponse {
  entries: AuditEntry[]
  total: number
}

const actionColor = (action: string) => {
  if (action.includes('ban') || action.includes('seize') || action.includes('reject')) return 'text-danger'
  if (action.includes('approve') || action.includes('resolve') || action.includes('confirm')) return 'text-success'
  if (action.includes('suspend') || action.includes('cancel')) return 'text-warning'
  return 'text-text-secondary'
}

export default function AuditLogPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<AuditEntry | null>(null)

  const limit = 50

  const fetchLog = useCallback(async () => {
    try {
      const data = await adminApi.getAuditLog({ page, limit }) as AuditLogResponse
      setEntries(data.entries ?? [])
      setTotal(data.total ?? 0)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load audit log')
    } finally {
      setLoading(false)
    }
  }, [page])

  useEffect(() => {
    fetchLog()
  }, [fetchLog])

  const totalPages = Math.ceil(total / limit)

  if (loading) return <LoadingState message="Loading audit log..." />
  if (error && entries.length === 0) return <ErrorState title={error} onRetry={fetchLog} />

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Audit Log</h1>
        <p className="text-text-muted text-sm mt-0.5">{total.toLocaleString()} entries &mdash; immutable record of admin actions</p>
      </div>

      {entries.length === 0 ? (
        <EmptyState icon={FileText} title="No audit entries" description="No admin actions have been recorded yet." />
      ) : (
        <div className="bg-surface shadow-card rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface border-b border-border">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Timestamp</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Admin</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">Action</th>
                  <th className="text-left px-4 py-3 font-medium text-text-muted">IP</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {entries.map((entry) => (
                  <tr key={entry.id} className="hover:bg-surface/50 transition-colors">
                    <td className="px-4 py-3 text-text-muted text-xs whitespace-nowrap">
                      {fmtDateTime(entry.createdAt)}
                    </td>
                    <td className="px-4 py-3">
                      <Link href={`/admin/users/${entry.userId}`} className="text-text-primary font-medium hover:text-primary hover:underline">
                        {entry.user?.username || 'Unknown'}
                      </Link>
                      <p className="text-xs text-text-muted">{entry.user?.email}</p>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`font-mono text-xs font-medium ${actionColor(entry.action)}`}>
                        {entry.action}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-text-muted">{entry.ip ?? 'Not captured'}</td>
                    <td className="px-4 py-3 text-right">
                      <Button size="sm" variant="ghost" onClick={() => setSelected(entry)}>
                        Details
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-border">
              <p className="text-text-muted text-sm">Page {page} of {totalPages} ({total.toLocaleString()} entries)</p>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Prev</Button>
                <Button size="sm" variant="secondary" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next</Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Detail modal */}
      <Modal isOpen={!!selected} onClose={() => setSelected(null)} title="Audit Entry Details" size="lg">
        {selected && (() => {
          const tHref = targetHref(selected.targetType, selected.targetId)
          const hasDetails = selected.details && typeof selected.details === 'object' && Object.keys(selected.details as object).length > 0
          return (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-text-muted">Admin</p>
                  <Link href={`/admin/users/${selected.userId}`} className="font-medium text-text-primary hover:text-primary hover:underline">
                    {selected.user?.username || selected.userId}
                  </Link>
                  <p className="text-xs text-text-muted">{selected.user?.email}</p>
                </div>
                <div>
                  <p className="text-text-muted">Timestamp</p>
                  <p className="text-text-secondary">{fmtDateTime(selected.createdAt)}</p>
                </div>
                <div>
                  <p className="text-text-muted">Action</p>
                  <p className={`font-mono font-medium ${actionColor(selected.action)}`}>{selected.action}</p>
                </div>
                <div>
                  <p className="text-text-muted">Target</p>
                  {selected.targetId ? (
                    tHref ? (
                      <Link href={tHref} className="text-primary hover:underline">
                        {selected.targetType}: <span className="font-mono">{selected.targetId}</span>
                      </Link>
                    ) : (
                      <p className="text-text-secondary">
                        {selected.targetType ?? '—'}: <span className="font-mono text-xs">{selected.targetId}</span>
                      </p>
                    )
                  ) : (
                    <p className="text-text-muted">—</p>
                  )}
                </div>
                <div>
                  <p className="text-text-muted">IP Address</p>
                  <p className="font-mono text-text-secondary">{selected.ip ?? 'Not captured'}</p>
                </div>
                {selected.userAgent && (
                  <div className="col-span-2">
                    <p className="text-text-muted">User Agent</p>
                    <p className="text-xs text-text-secondary break-all">{selected.userAgent}</p>
                  </div>
                )}
              </div>

              <div>
                {hasDetails ? (
                  <details className="group" open>
                    <summary className="cursor-pointer text-text-muted mb-2 select-none hover:text-text-secondary">
                      Raw metadata
                    </summary>
                    <pre className="bg-surface-alt rounded-xl p-4 text-xs font-mono text-text-secondary overflow-auto max-h-60 whitespace-pre-wrap break-all">
                      {JSON.stringify(selected.details, null, 2)}
                    </pre>
                  </details>
                ) : (
                  <p className="text-text-muted text-xs">No additional metadata was recorded for this action.</p>
                )}
              </div>
            </div>
          )
        })()}
      </Modal>
    </div>
  )
}

