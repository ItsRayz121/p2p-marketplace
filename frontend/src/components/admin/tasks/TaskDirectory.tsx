'use client'
import { useMemo, useState } from 'react'
import { ChevronDown, Search } from 'lucide-react'
import { adminPlatformTaskApi, PLATFORMS, type AdminPlatformTask, type TaskLifecycle } from '@/lib/platformTasks'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { fmtDate } from '@/lib/fmt'
import { CommunityTaskStarter } from '@/components/admin/promotions/CommunityTaskStarter'
import { LifecyclePill, fmtReward, inputCls } from './shared'

const LIFE_FILTERS: Array<{ key: string; label: string }> = [
  { key: '', label: 'All' }, { key: 'active', label: 'Active' }, { key: 'draft', label: 'Drafts' }, { key: 'scheduled', label: 'Scheduled' },
  { key: 'paused', label: 'Paused' }, { key: 'ended', label: 'Ended' }, { key: 'archived', label: 'Archived' },
]

const VERIFY: Record<string, string> = { telegram_auto: 'Auto (Telegram)', manual_proof: 'Manual review', self_claim: 'Self-claim' }

export function TaskDirectory({ tasks, life, platform, q, setFilter, onEdit, onReload, onReviewTask }: {
  tasks: AdminPlatformTask[]
  life: string; platform: string; q: string
  setFilter: (patch: Record<string, string>) => void
  onEdit: (t: AdminPlatformTask) => void
  onReload: () => void | Promise<void>
  onReviewTask: (t: AdminPlatformTask) => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [official, setOfficial] = useState(false)

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return tasks.filter((t) => {
      // Archived tasks stay out of the default view but are one filter away (history is never deleted).
      if (!life && t.lifecycle === 'archived') return false
      if (life && t.lifecycle !== (life as TaskLifecycle)) return false
      if (platform && t.platform !== platform) return false
      if (needle && !t.title.toLowerCase().includes(needle)) return false
      return true
    })
  }, [tasks, life, platform, q])

  async function patch(t: AdminPlatformTask, body: Parameters<typeof adminPlatformTaskApi.update>[1], ok: string) {
    setBusy(t.id)
    try { await adminPlatformTaskApi.update(t.id, body); toast.success(ok); await onReload() }
    catch (e) { toast.error('Update failed', e instanceof Error ? e.message : undefined) }
    finally { setBusy(null) }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Lifecycle">
          {LIFE_FILTERS.map((s) => (
            <button key={s.key} type="button" aria-pressed={life === s.key} onClick={() => setFilter({ life: s.key })}
              className={cn('rounded-lg border px-3 py-1.5 text-sm font-medium', life === s.key ? 'border-primary bg-primary text-white' : 'border-border bg-surface text-text-secondary hover:bg-surface-alt')}>{s.label}</button>
          ))}
        </div>
        <label className="relative min-w-[180px] flex-1">
          <span className="sr-only">Search tasks</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" aria-hidden />
          <input value={q} onChange={(e) => setFilter({ tq: e.target.value })} placeholder="Search tasks…" className={cn(inputCls, 'pl-9')} />
        </label>
        <select aria-label="Platform" value={platform} onChange={(e) => setFilter({ tplat: e.target.value })} className={cn(inputCls, 'w-auto')}>
          <option value="">All platforms</option>{PLATFORMS.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-card">
        {rows.length === 0 ? (
          <p className="p-8 text-center text-sm text-text-muted">{tasks.length === 0 ? 'No tasks yet. Use “New task” to create the first one.' : 'No tasks match these filters.'}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs font-semibold text-text-secondary">
                <tr><th className="px-4 py-2.5">Task</th><th className="px-3 py-2.5">Verification</th><th className="px-3 py-2.5">Reward</th><th className="px-3 py-2.5">Status</th><th className="px-3 py-2.5 text-right">Pending</th><th className="px-3 py-2.5 text-right">Approved</th><th className="px-3 py-2.5">Dates</th><th className="px-3 py-2.5" /></tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((t) => {
                  const pending = (t.counts.pending_review ?? 0) + (t.counts.needs_changes ?? 0)
                  const approved = (t.counts.completed ?? 0) + (t.counts.awaiting_payout ?? 0)
                  return (
                    <tr key={t.id} className="align-top hover:bg-surface-alt/40">
                      <td className="px-4 py-3">
                        <p className="font-semibold text-text-primary">{t.title}</p>
                        <p className="text-xs text-text-muted">{t.platform ?? 'No platform'} · v{t.version}</p>
                      </td>
                      <td className="px-3 py-3 text-text-secondary">{VERIFY[t.verifyMode] ?? t.verifyMode}</td>
                      <td className="px-3 py-3 whitespace-nowrap font-medium text-text-primary">{fmtReward(t.rewardType, t.rewardPoints, t.rewardUsdt)}
                        {t.budgetUsdt != null && <span className="block text-[11px] font-normal text-text-muted">${t.spentUsdt.toFixed(2)} of ${t.budgetUsdt.toFixed(2)}</span>}
                        {t.maxClaims != null && <span className="block text-[11px] font-normal text-text-muted">{t.claimedCount} of {t.maxClaims} claims</span>}</td>
                      <td className="px-3 py-3"><LifecyclePill lifecycle={t.lifecycle} /></td>
                      <td className="px-3 py-3 text-right tabular-nums">{pending > 0 ? <button type="button" onClick={() => onReviewTask(t)} className="font-semibold text-warning hover:underline">{pending}</button> : <span className="text-text-muted">0</span>}</td>
                      <td className="px-3 py-3 text-right tabular-nums text-text-primary">{approved}</td>
                      <td className="px-3 py-3 whitespace-nowrap text-xs text-text-secondary">
                        {t.startsAt && <span className="block">From {fmtDate(t.startsAt)}</span>}
                        {t.endsAt ? <span className="block">Until {fmtDate(t.endsAt)}</span> : <span className="block text-text-muted">No end date</span>}
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex flex-wrap justify-end gap-1.5">
                          <button type="button" onClick={() => onEdit(t)} className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-text-primary hover:bg-surface-alt">Edit</button>
                          {t.lifecycle === 'archived' ? (
                            <button type="button" disabled={busy === t.id} onClick={() => void patch(t, { archived: false }, 'Task restored')} className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-text-primary hover:bg-surface-alt disabled:opacity-50">Restore</button>
                          ) : (
                            <>
                              {(t.lifecycle === 'active' || t.lifecycle === 'paused' || t.lifecycle === 'scheduled') && (
                                <button type="button" disabled={busy === t.id} onClick={() => void patch(t, { isActive: !t.isActive }, t.isActive ? 'Task paused' : 'Task resumed')} className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-text-primary hover:bg-surface-alt disabled:opacity-50">{t.isActive ? 'Pause' : 'Resume'}</button>
                              )}
                              <button type="button" disabled={busy === t.id} onClick={() => { if (window.confirm('Archive this task? It closes to new members; all submissions and history are kept.')) void patch(t, { archived: true }, 'Task archived') }} className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-text-secondary hover:bg-surface-alt disabled:opacity-50">Archive</button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p className="text-[11px] text-text-muted">Pausing stops new members from joining; existing submissions stay in the review queue. Archiving keeps all history.</p>

      <div className="rounded-xl border border-border bg-surface">
        <button type="button" aria-expanded={official} onClick={() => setOfficial((o) => !o)} className="flex w-full items-center justify-between px-4 py-3 text-left">
          <span><span className="text-sm font-semibold text-text-primary">Official community channels</span><span className="block text-xs text-text-secondary">One-click tasks for the channels configured on the Community page. Each channel can have one task.</span></span>
          <ChevronDown className={cn('h-4 w-4 text-text-muted transition-transform', official && 'rotate-180')} aria-hidden />
        </button>
        {official && <div className="border-t border-border p-4"><CommunityTaskStarter tasks={tasks} onCreated={onReload} /></div>}
      </div>
    </div>
  )
}
