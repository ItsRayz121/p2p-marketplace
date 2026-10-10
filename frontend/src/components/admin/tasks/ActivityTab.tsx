'use client'
import { useCallback, useEffect, useState } from 'react'
import { adminPlatformTaskApi, type ActivityPage } from '@/lib/platformTasks'
import { fmtDateTime } from '@/lib/fmt'
import { Pager } from './shared'

const LABELS: Record<string, string> = {
  PLATFORM_TASK_CREATE: 'created a task',
  PLATFORM_TASK_UPDATE: 'edited a task',
  PLATFORM_TASK_APPROVE: 'approved a submission',
  PLATFORM_TASK_REJECT: 'rejected a submission',
  PLATFORM_TASK_REQUEST_CHANGES: 'requested changes on a submission',
  PLATFORM_TASK_PAYOUT_RECORDED: 'recorded a USDT payment',
  PLATFORM_TASK_PAYOUT_CANCELLED: 'cancelled a USDT payout',
}

export function ActivityTab({ openSubmission }: { openSubmission: (id: string) => void }) {
  const [page, setPage] = useState(1)
  const [data, setData] = useState<ActivityPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async () => {
    try { setData(await adminPlatformTaskApi.activity(page)); setError(null) } catch (e) { setError(e instanceof Error ? e.message : 'Could not load activity') }
  }, [page])
  useEffect(() => { void load() }, [load])

  return (
    <div className="space-y-2">
      <p className="text-xs text-text-muted">Every change to tasks, reviews and payouts, recorded with who did it.</p>
      {error && <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
      <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-card">
        {!data ? <div className="h-32 animate-pulse" /> : data.items.length === 0 ? <p className="p-8 text-center text-sm text-text-muted">No activity recorded yet.</p> : (
          <ul className="divide-y divide-border">
            {data.items.map((a) => {
              const m = a.metadata as { title?: string; reason?: string; revisionNo?: number; txHash?: string }
              return (
                <li key={a.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-3 text-sm">
                  <span className="font-semibold text-text-primary">{a.actor}</span>
                  <span className="text-text-secondary">{LABELS[a.action] ?? a.action.replace(/^PLATFORM_TASK_/, '').toLowerCase().replace(/_/g, ' ')}</span>
                  {m.title && <span className="text-text-primary">“{m.title}”</span>}
                  {m.revisionNo && <span className="text-xs text-text-muted">revision {m.revisionNo}</span>}
                  {a.targetType === 'PlatformTaskCompletion' && a.targetId && (
                    <button type="button" onClick={() => openSubmission(a.targetId!)} className="text-xs font-semibold text-primary hover:underline">Open submission</button>
                  )}
                  <span className="ml-auto text-xs text-text-muted">{fmtDateTime(a.createdAt)}</span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
      {data && <Pager page={data.page} total={data.total} limit={data.limit} onPage={setPage} />}
    </div>
  )
}
