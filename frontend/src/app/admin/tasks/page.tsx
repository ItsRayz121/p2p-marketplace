'use client'
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { adminPlatformTaskApi, type AdminPlatformTask, type Summary } from '@/lib/platformTasks'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { cn } from '@/lib/utils'
import { SummaryRow } from '@/components/admin/tasks/SummaryRow'
import { ReviewInbox, useAdminTasks } from '@/components/admin/tasks/ReviewInbox'
import { TaskDirectory } from '@/components/admin/tasks/TaskDirectory'
import { TaskDrawer } from '@/components/admin/tasks/TaskDrawer'
import { RewardsTab } from '@/components/admin/tasks/RewardsTab'
import { AnalyticsTab } from '@/components/admin/tasks/AnalyticsTab'
import { ActivityTab } from '@/components/admin/tasks/ActivityTab'
import { RANGES, rangeOf, useUrlState } from '@/components/admin/tasks/shared'

const TABS = [
  { key: 'review', label: 'Review inbox' },
  { key: 'tasks', label: 'All tasks' },
  { key: 'rewards', label: 'Rewards' },
  { key: 'analytics', label: 'Analytics' },
  { key: 'activity', label: 'Activity' },
] as const
type TabKey = (typeof TABS)[number]['key']

export default function AdminTasksPage() {
  return (
    <Suspense fallback={<LoadingState message="Loading tasks..." />}>
      <Workspace />
    </Suspense>
  )
}

function Workspace() {
  const url = useUrlState()
  const tabParam = url.get('tab') as TabKey
  const tab: TabKey = TABS.some((t) => t.key === tabParam) ? tabParam : 'review'
  const range = RANGES.some((r) => r.key === url.get('range')) ? url.get('range') : '30'
  const rangeLabel = RANGES.find((r) => r.key === range)!.label

  const { tasks, error, reload } = useAdminTasks()
  const [summary, setSummary] = useState<Summary | null>(null)
  const [editing, setEditing] = useState<AdminPlatformTask | null>(null)
  const [drawer, setDrawer] = useState(false)

  const period = useMemo(() => rangeOf(range), [range])
  const loadSummary = useCallback(async () => {
    try { setSummary(await adminPlatformTaskApi.summary(period)) } catch { /* the summary is secondary; each tab reports its own errors */ }
  }, [period])
  useEffect(() => { void loadSummary() }, [loadSummary])

  const go = (nextTab: string, extra: Record<string, string> = {}) =>
    url.set({ tab: nextTab === 'review' ? null : nextTab, status: null, task: null, plat: null, rw: null, from: null, to: null, q: null, page: null, sub: null, life: null, tplat: null, tq: null, state: null, type: null, rq: null, ...extra }, { push: true })

  const refreshAll = useCallback(() => { void loadSummary(); void reload() }, [loadSummary, reload])

  if (error && !tasks) return <ErrorState title={error} onRetry={reload} />
  if (!tasks) return <LoadingState message="Loading tasks..." />

  const openNew = () => { setEditing(null); setDrawer(true) }
  const openEdit = (t: AdminPlatformTask) => { setEditing(t); setDrawer(true) }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold text-text-primary">Community Tasks</h1>
          <p className="mt-0.5 text-sm text-text-secondary">Create tasks, review member submissions and proof, and track rewards.</p>
        </div>
        <label className="flex items-center gap-2 text-xs text-text-secondary">
          Period
          <select value={range} onChange={(e) => url.set({ range: e.target.value === '30' ? null : e.target.value })} className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-text-primary">
            {RANGES.map((r) => <option key={r.key} value={r.key}>Last {r.label}</option>)}
          </select>
        </label>
        <button type="button" onClick={openNew} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:opacity-90">+ New task</button>
      </div>

      <SummaryRow s={summary} rangeLabel={rangeLabel} go={go} />

      <nav aria-label="Task sections" className="flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map((t) => (
          <button key={t.key} type="button" aria-current={tab === t.key ? 'page' : undefined} onClick={() => go(t.key)}
            className={cn('-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition-colors', tab === t.key ? 'border-primary text-primary' : 'border-transparent text-text-secondary hover:text-text-primary')}>
            {t.label}
            {t.key === 'review' && summary && summary.pendingReview.count > 0 && <span className="ml-1.5 rounded-full bg-warning px-1.5 text-[11px] font-bold leading-[18px] text-white">{summary.pendingReview.count}</span>}
          </button>
        ))}
      </nav>

      {tab === 'review' && (
        <ReviewInbox
          tasks={tasks}
          targetHours={summary?.reviewTargetHours ?? 24}
          filters={{ status: url.get('status', 'pending_review'), task: url.get('task'), platform: url.get('plat'), reward: url.get('rw'), from: url.get('from'), to: url.get('to'), q: url.get('q'), page: Number(url.get('page', '1')) || 1 }}
          selectedId={url.get('sub')}
          setFilters={(p) => url.set({ status: p.status === 'pending_review' ? null : p.status, task: p.task, plat: p.platform, rw: p.reward, from: p.from, to: p.to, q: p.q, page: p.page === '1' ? null : p.page })}
          setSelected={(id) => url.set({ sub: id || null })}
          onChanged={refreshAll}
        />
      )}

      {tab === 'tasks' && (
        <TaskDirectory
          tasks={tasks}
          life={url.get('life')}
          platform={url.get('tplat')}
          q={url.get('tq')}
          setFilter={(p) => url.set(p)}
          onEdit={openEdit}
          onReload={refreshAll}
          onReviewTask={(t) => go('review', { task: t.id })}
        />
      )}

      {tab === 'rewards' && <RewardsTab state={url.get('state')} type={url.get('type')} q={url.get('rq')} setFilter={(p) => url.set(p)} onChanged={refreshAll} />}

      {tab === 'analytics' && <AnalyticsTab range={range} setRange={(r) => url.set({ range: r === '30' ? null : r })} />}

      {tab === 'activity' && <ActivityTab openSubmission={(id) => go('review', { status: 'all', sub: id })} />}

      <TaskDrawer task={editing} open={drawer} onClose={() => setDrawer(false)} onSaved={refreshAll} />
    </div>
  )
}
