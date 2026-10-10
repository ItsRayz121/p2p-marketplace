'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, CheckCircle2, ExternalLink, FileText, Link2, Search } from 'lucide-react'
import {
  adminPlatformTaskApi, PLATFORMS, type AdminPlatformTask, type Decision, type InboxItem, type InboxPage,
  type RevisionView, type SubmissionDetail,
} from '@/lib/platformTasks'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { fmtDateTime } from '@/lib/fmt'
import { Spinner } from '@/components/ui/Spinner'
import { ProofViewer } from './ProofViewer'
import { Avatar, Pager, StatusPill, ago, fmtReward, fmtWait, inputCls, labelCls, memberName } from './shared'

const STATUS_FILTERS = [
  { key: 'pending_review', label: 'Pending' },
  { key: 'needs_changes', label: 'Needs changes' },
  { key: 'completed', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'all', label: 'All' },
] as const

const CHECKS = [
  { key: 'accountMatches', label: 'The account matches the member’s handle' },
  { key: 'actionVisible', label: 'The required action is visible' },
] as const

type Filters = { status: string; task: string; platform: string; reward: string; from: string; to: string; q: string; page: number }

export function ReviewInbox({
  tasks, targetHours, filters, selectedId, setFilters, setSelected, onChanged,
}: {
  tasks: AdminPlatformTask[]
  targetHours: number
  filters: Filters
  selectedId: string
  setFilters: (patch: Partial<Record<keyof Filters, string>>) => void
  setSelected: (id: string) => void
  /** Called after any decision so summary numbers refresh. */
  onChanged: () => void
}) {
  const [list, setList] = useState<InboxPage | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [search, setSearch] = useState(filters.q)

  const load = useCallback(async () => {
    try {
      const page = await adminPlatformTaskApi.inbox({
        status: filters.status, taskId: filters.task || undefined, platform: filters.platform || undefined,
        rewardType: filters.reward || undefined, from: filters.from || undefined, to: filters.to || undefined,
        q: filters.q || undefined, sort: 'oldest', page: filters.page, limit: 20,
      })
      setList(page)
      setListError(null)
      return page
    } catch (e) {
      setListError(e instanceof Error ? e.message : 'Could not load the queue')
      return null
    }
  }, [filters.status, filters.task, filters.platform, filters.reward, filters.from, filters.to, filters.q, filters.page])

  useEffect(() => { void load() }, [load])

  // Debounce the search box into the URL filter.
  useEffect(() => {
    if (search === filters.q) return
    const t = setTimeout(() => setFilters({ q: search, page: '1' }), 350)
    return () => clearTimeout(t)
  }, [search, filters.q, setFilters])

  // Default selection: first queue item when nothing (valid) is selected.
  useEffect(() => {
    if (!list || list.items.length === 0) return
    if (!selectedId || !list.items.some((i) => i.id === selectedId)) {
      if (!selectedId) setSelected(list.items[0]!.id)
    }
  }, [list, selectedId, setSelected])

  const afterDecision = useCallback(async (decidedId: string) => {
    const before = list?.items ?? []
    const idx = before.findIndex((i) => i.id === decidedId)
    onChanged()
    const next = await load()
    if (!next) return
    // Same queue position: the item that now sits where the decided one was, else the previous one.
    const target = next.items[Math.min(Math.max(idx, 0), next.items.length - 1)]
    setSelected(target ? target.id : '')
  }, [list, load, onChanged, setSelected])

  return (
    <div className="space-y-3">
      {/* Filters */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Status">
          {STATUS_FILTERS.map((s) => (
            <button key={s.key} type="button" aria-pressed={filters.status === s.key} onClick={() => setFilters({ status: s.key, page: '1' })}
              className={cn('rounded-lg border px-3 py-1.5 text-sm font-medium', filters.status === s.key ? 'border-primary bg-primary text-white' : 'border-border bg-surface text-text-secondary hover:bg-surface-alt')}>{s.label}</button>
          ))}
        </div>
        <label className="relative min-w-[200px] flex-1">
          <span className="sr-only">Search submissions</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" aria-hidden />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Member, submission ID or task…" className={cn(inputCls, 'pl-9')} />
        </label>
        <select aria-label="Task" value={filters.task} onChange={(e) => setFilters({ task: e.target.value, page: '1' })} className={cn(inputCls, 'w-auto max-w-[200px]')}>
          <option value="">All tasks</option>
          {tasks.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
        </select>
        <select aria-label="Platform" value={filters.platform} onChange={(e) => setFilters({ platform: e.target.value, page: '1' })} className={cn(inputCls, 'w-auto')}>
          <option value="">All platforms</option>
          {PLATFORMS.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select aria-label="Reward type" value={filters.reward} onChange={(e) => setFilters({ reward: e.target.value, page: '1' })} className={cn(inputCls, 'w-auto')}>
          <option value="">Points &amp; USDT</option>
          <option value="points">Points</option>
          <option value="usdt">USDT</option>
        </select>
        <label className="text-xs text-text-secondary">From<input type="date" value={filters.from} onChange={(e) => setFilters({ from: e.target.value, page: '1' })} className={cn(inputCls, 'ml-1 inline-block w-auto')} /></label>
        <label className="text-xs text-text-secondary">To<input type="date" value={filters.to} onChange={(e) => setFilters({ to: e.target.value, page: '1' })} className={cn(inputCls, 'ml-1 inline-block w-auto')} /></label>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(300px,380px)_minmax(0,1fr)]">
        {/* Queue */}
        <div className={cn('space-y-2', selectedId && 'max-lg:hidden')}>
          {listError && <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{listError} <button type="button" className="font-semibold underline" onClick={() => void load()}>Retry</button></p>}
          {!list && !listError && <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-[84px] animate-pulse rounded-xl border border-border bg-surface" />)}</div>}
          {list && list.items.length === 0 && (
            <div className="rounded-xl border border-border bg-surface p-8 text-center">
              <CheckCircle2 className="mx-auto h-8 w-8 text-success" aria-hidden />
              <p className="mt-2 text-sm font-semibold text-text-primary">{filters.status === 'pending_review' && !filters.q ? 'You’re all caught up' : 'Nothing matches these filters'}</p>
              <p className="text-xs text-text-secondary">{filters.status === 'pending_review' && !filters.q ? 'No submissions are waiting for review.' : 'Try a different status or clear the search.'}</p>
            </div>
          )}
          {list?.items.map((i) => <QueueRow key={i.id} item={i} active={i.id === selectedId} targetHours={targetHours} onClick={() => setSelected(i.id)} />)}
          {list && <Pager page={list.page} total={list.total} limit={list.limit} onPage={(p) => setFilters({ page: String(p) })} />}
        </div>

        {/* Review panel */}
        <div className={cn(!selectedId && 'max-lg:hidden')}>
          {selectedId ? (
            <ReviewPanel key={selectedId} id={selectedId} onBack={() => setSelected('')} onDecided={afterDecision} onRefresh={() => { void load(); onChanged() }} />
          ) : list && list.items.length === 0 ? null : (
            <div className="rounded-xl border border-border bg-surface p-10 text-center text-sm text-text-muted">Select a submission to review it.</div>
          )}
        </div>
      </div>
    </div>
  )
}

function QueueRow({ item, active, targetHours, onClick }: { item: InboxItem; active: boolean; targetHours: number; onClick: () => void }) {
  const name = memberName(item.user)
  const late = item.waitingHours != null && item.waitingHours > targetHours
  return (
    <button type="button" onClick={onClick} aria-current={active ? 'true' : undefined}
      className={cn('w-full rounded-xl border bg-surface p-3 text-left transition-colors hover:bg-surface-alt focus:outline-none focus:ring-2 focus:ring-primary/40', active ? 'border-primary ring-1 ring-primary/30' : 'border-border')}>
      <div className="flex items-start gap-2.5">
        <Avatar name={name} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-semibold text-text-primary">{name}</p>
            <span className="ml-auto flex-shrink-0 text-xs font-bold text-success">{fmtReward(item.rewardType, item.rewardPoints, item.rewardUsdt)}</span>
          </div>
          <p className="truncate text-xs text-text-secondary">{item.task.title}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
            <span>{ago(item.submittedAt)}</span>
            {item.waitingHours != null && <span className={cn('font-semibold', late ? 'text-warning' : 'text-text-secondary')}>waiting {fmtWait(item.waitingHours)}</span>}
            {item.evidence.files > 0 && <span className="inline-flex items-center gap-0.5"><FileText className="h-3 w-3" aria-hidden />{item.evidence.files}</span>}
            {item.evidence.links > 0 && <span className="inline-flex items-center gap-0.5"><Link2 className="h-3 w-3" aria-hidden />{item.evidence.links}</span>}
            {item.isResubmission && <span className="rounded bg-info/10 px-1.5 py-0.5 font-semibold text-info">Resubmission #{item.revisionNo}</span>}
            {item.status !== 'pending_review' && <StatusPill status={item.status} />}
          </div>
        </div>
      </div>
    </button>
  )
}

function ReviewPanel({ id, onBack, onDecided, onRefresh }: {
  id: string
  onBack: () => void
  onDecided: (id: string) => Promise<void>
  onRefresh: () => void
}) {
  const [d, setD] = useState<SubmissionDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<Decision | null>(null)
  const [conflict, setConflict] = useState<string | null>(null)
  const [feedback, setFeedback] = useState('')
  const [note, setNote] = useState('')
  const [checks, setChecks] = useState<Record<string, boolean>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const loadedRev = useRef<number | null>(null)

  const load = useCallback(async () => {
    try {
      const detail = await adminPlatformTaskApi.detail(id)
      setD(detail)
      setError(null)
      loadedRev.current = detail.revisionNo
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load this submission') }
  }, [id])
  useEffect(() => { void load() }, [load])

  const reviewable = d?.status === 'pending_review'
  const withdrawable = d?.status === 'needs_changes'
  const latest = d?.revisions[d.revisions.length - 1]

  async function decide(decision: Decision) {
    if (!d) return
    setFormError(null)
    if (decision !== 'approve' && feedback.trim().length < 5) { setFormError('Write feedback the member will see (at least 5 characters).'); return }
    if (decision === 'reject' && !window.confirm('Reject this submission? The member will see your feedback and cannot resubmit.')) return
    setBusy(decision)
    try {
      await adminPlatformTaskApi.decide(d.id, {
        decision, revisionNo: d.revisionNo, feedback: decision === 'approve' ? null : feedback.trim(),
        internalNote: note.trim() || null, checks: Object.keys(checks).length ? checks : null,
      })
      toast.success(decision === 'approve' ? 'Approved' : decision === 'reject' ? 'Rejected' : 'Changes requested')
      setFeedback(''); setNote(''); setChecks({})
      await onDecided(d.id)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not save your decision'
      // Keep the draft feedback; only reload the record if it changed under us.
      if (/updated this submission|already reviewed|changed while/i.test(msg)) {
        setConflict(msg)
        await load()
        onRefresh()
      } else setFormError(msg)
    } finally { setBusy(null) }
  }

  if (error) return <p className="rounded-xl border border-border bg-surface p-6 text-sm text-danger">{error} <button type="button" onClick={() => void load()} className="font-semibold underline">Retry</button></p>
  if (!d) return <div className="flex h-48 items-center justify-center rounded-xl border border-border bg-surface"><Spinner size="sm" /></div>

  const name = memberName(d.user)
  const money = fmtReward(d.reward.type, d.reward.points, d.reward.usdt)

  return (
    <div className="space-y-3 rounded-xl border border-border bg-surface p-4 shadow-card">
      <button type="button" onClick={onBack} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline lg:hidden"><ArrowLeft className="h-3.5 w-3.5" />Back to queue</button>

      {conflict && <p className="rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning" role="alert">{conflict} The latest version is shown below; your draft feedback was kept.</p>}

      <div className="flex flex-wrap items-start gap-3">
        <Avatar name={name} />
        <div className="min-w-0 flex-1">
          <p className="text-base font-bold text-text-primary">{name}</p>
          <p className="text-xs text-text-secondary">
            {d.user.email}{d.user.telegramUsername ? ` · @${d.user.telegramUsername}` : ''}
          </p>
          <p className="mt-0.5 text-[11px] text-text-muted">
            Submission <span className="font-mono">{d.id}</span> · first submitted {fmtDateTime(d.createdAt)} · revision {d.revisionNo}
          </p>
        </div>
        <div className="text-right">
          <StatusPill status={d.status} />
          <p className="mt-1 text-sm font-bold text-success">{money}</p>
          <p className="text-[11px] text-text-muted">promised at claim time</p>
        </div>
      </div>

      {/* What the member was asked to do, as of when they claimed */}
      <section className="rounded-lg bg-surface-alt p-3 text-sm">
        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
          Task requirements
          {d.terms.taskHasChangedSince && <span className="rounded bg-warning/10 px-1.5 py-0.5 normal-case text-warning">Task edited since this claim. Judge by the terms below.</span>}
        </p>
        <p className="mt-1 font-semibold text-text-primary">{d.terms.title}</p>
        {d.terms.instructions && <p className="mt-1 whitespace-pre-wrap text-text-secondary">{d.terms.instructions}</p>}
        {d.terms.proofRequirements && <p className="mt-1 text-text-secondary"><span className="font-semibold">Proof needed:</span> {d.terms.proofRequirements}</p>}
        {d.terms.proofFileRequired && <p className="mt-1 text-xs font-semibold text-text-secondary">A screenshot is required.</p>}
        {d.task.url && <a href={d.task.url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline">Open the task page <ExternalLink className="h-3 w-3" /></a>}
      </section>

      {/* Verification: evidence is not verification */}
      <p className={cn('rounded-lg border px-3 py-2 text-xs', d.verification.automatic ? 'border-success/30 bg-success/5 text-text-secondary' : 'border-warning/30 bg-warning/5 text-text-secondary')}>
        <span className="font-semibold text-text-primary">{d.verification.automatic ? 'Checked automatically. ' : 'Not verified by the platform. '}</span>{d.verification.note}
      </p>

      {/* Revisions, newest first */}
      <section className="space-y-3">
        {[...d.revisions].reverse().map((r) => <RevisionBlock key={r.number} r={r} isLatest={r.number === latest?.number} />)}
      </section>

      {d.reward.payoutAddress && (
        <p className="break-all rounded-lg bg-surface-alt px-3 py-2 font-mono text-[11px] text-text-secondary">Payout {d.reward.payoutNetwork}: {d.reward.payoutAddress}</p>
      )}

      {d.otherSubmissions.length > 0 && (
        <details className="text-xs text-text-secondary">
          <summary className="cursor-pointer font-semibold">Member&apos;s other submissions ({d.otherSubmissions.length})</summary>
          <ul className="mt-1 space-y-1">{d.otherSubmissions.map((o) => <li key={o.id} className="flex items-center gap-2"><StatusPill status={o.status} /><span className="truncate">{o.taskTitle}</span><span className="ml-auto text-text-muted">{ago(o.createdAt)}</span></li>)}</ul>
        </details>
      )}

      {/* Decision */}
      {reviewable || withdrawable ? (
        <section className="space-y-3 border-t border-border pt-3">
          {withdrawable && <p className="text-sm text-text-secondary">Waiting for the member to resubmit. If they never respond you can close the claim, which frees its reward slot.</p>}
          {reviewable && <fieldset>
            <legend className={labelCls}>Checks (optional, saved with your decision)</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {CHECKS.map((c) => (
                <label key={c.key} className="flex items-center gap-2 text-sm text-text-primary">
                  <input type="checkbox" checked={!!checks[c.key]} onChange={(e) => setChecks((m) => ({ ...m, [c.key]: e.target.checked }))} />{c.label}
                </label>
              ))}
            </div>
          </fieldset>}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={labelCls} htmlFor="fb">Feedback to the member <span className="font-normal text-text-muted">(required to request changes or reject)</span></label>
              <textarea id="fb" rows={3} maxLength={1000} value={feedback} onChange={(e) => setFeedback(e.target.value)} className={inputCls} placeholder="e.g. Please show your @username in the screenshot." />
            </div>
            <div>
              <label className={labelCls} htmlFor="nt">Internal note <span className="font-normal text-text-muted">(admins only)</span></label>
              <textarea id="nt" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} className={inputCls} placeholder="Optional context for other admins." />
            </div>
          </div>
          {formError && <p className="text-sm text-danger" role="alert">{formError}</p>}
          <div className="flex flex-wrap gap-2">
            {reviewable && <button type="button" disabled={!!busy} onClick={() => void decide('approve')} className="rounded-lg bg-success px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy === 'approve' ? 'Approving…' : 'Approve & next'}</button>}
            {reviewable && <button type="button" disabled={!!busy} onClick={() => void decide('request_changes')} className="rounded-lg border border-info px-4 py-2 text-sm font-semibold text-info hover:bg-info/5 disabled:opacity-50">{busy === 'request_changes' ? 'Sending…' : 'Request changes'}</button>}
            <button type="button" disabled={!!busy} onClick={() => void decide('reject')} className="rounded-lg border border-danger px-4 py-2 text-sm font-semibold text-danger hover:bg-danger/5 disabled:opacity-50">{busy === 'reject' ? 'Rejecting…' : withdrawable ? 'Close claim' : 'Reject'}</button>
          </div>
          {d.reward.type === 'usdt' && <p className="text-[11px] text-text-muted">Approving a USDT task creates one payable claim. It does not send any money; payment is recorded in the Rewards tab.</p>}
        </section>
      ) : (
        <p className="border-t border-border pt-3 text-sm text-text-secondary">
          {d.status === 'awaiting_payout' ? 'Approved. The USDT payment is handled in the Rewards tab.' : 'This submission has already been decided.'}
        </p>
      )}
    </div>
  )
}

function RevisionBlock({ r, isLatest }: { r: RevisionView; isLatest: boolean }) {
  return (
    <div className={cn('rounded-lg border p-3', isLatest ? 'border-primary/40' : 'border-border opacity-90')}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-semibold text-text-primary">Revision {r.number}{isLatest ? ' (latest)' : ''}</span>
        <span className="text-text-muted">submitted {fmtDateTime(r.submittedAt)}</span>
        {r.decision && <span className={cn('rounded-full px-2 py-0.5 font-semibold', r.decision === 'approved' ? 'bg-success/10 text-success' : r.decision === 'rejected' ? 'bg-danger/10 text-danger' : 'bg-info/10 text-info')}>{r.decision === 'needs_changes' ? 'changes requested' : r.decision}{r.reviewer ? ` by ${r.reviewer}` : ''}</span>}
      </div>
      {r.proof && <p className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-surface-alt px-3 py-2 text-sm text-text-primary"><span className="text-xs font-semibold text-text-muted">Member&apos;s note: </span>{r.proof}</p>}
      {r.links.length > 0 && (
        <ul className="mt-2 space-y-1">
          {r.links.map((l) => (
            <li key={l.url} className="flex items-center gap-2 text-sm">
              <Link2 className="h-3.5 w-3.5 flex-shrink-0 text-text-muted" aria-hidden />
              <a href={l.url} target="_blank" rel="noopener noreferrer nofollow" className="min-w-0 truncate text-primary hover:underline">{l.url}</a>
              <span className="flex-shrink-0 rounded bg-surface-alt px-1.5 py-0.5 text-[11px] font-medium text-text-secondary">{l.domain ?? 'unknown domain'}</span>
            </li>
          ))}
        </ul>
      )}
      {(r.attachments.length > 0) && <div className="mt-2"><ProofViewer attachments={r.attachments} /></div>}
      {!r.proof && r.links.length === 0 && r.attachments.length === 0 && <p className="mt-2 text-xs text-text-muted">No evidence was submitted in this revision.</p>}
      {r.feedback && <p className="mt-2 rounded-lg bg-info/5 px-3 py-2 text-sm text-text-primary"><span className="text-xs font-semibold text-info">Feedback sent to member: </span>{r.feedback}</p>}
      {r.internalNote && <p className="mt-2 rounded-lg bg-warning/5 px-3 py-2 text-sm text-text-primary"><span className="text-xs font-semibold text-warning">Internal note: </span>{r.internalNote}</p>}
    </div>
  )
}

export function useAdminTasks() {
  const [tasks, setTasks] = useState<AdminPlatformTask[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async () => {
    try { setTasks(await adminPlatformTaskApi.list()); setError(null) }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed to load tasks') }
  }, [])
  useEffect(() => { void load() }, [load])
  return useMemo(() => ({ tasks, error, reload: load }), [tasks, error, load])
}
