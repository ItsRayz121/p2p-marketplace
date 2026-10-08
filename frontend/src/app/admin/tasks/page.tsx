'use client'
import { useState, useEffect, useCallback } from 'react'
import { adminPlatformTaskApi, type AdminPlatformTask, type AdminSubmission, type NewTaskInput, type VerifyMode, type RewardType } from '@/lib/platformTasks'
import { LoadingState } from '@/components/ui/LoadingState'
import { toast } from '@/lib/toast'
import { copyText } from '@/components/chat/richText'
import { CommunityTaskStarter } from '@/components/admin/promotions/CommunityTaskStarter'
import { TaskLogoField } from '@/components/admin/promotions/TaskLogoField'

const inputCls = 'w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-primary'
const labelCls = 'block text-xs font-semibold text-text-muted mb-1'

const STATUS_CLS: Record<string, string> = {
  pending_review: 'text-warning bg-warning/10',
  awaiting_payout: 'text-warning bg-warning/10',
  completed: 'text-success bg-success/10',
  rejected: 'text-danger bg-danger/10',
}

const emptyForm = {
  title: '', description: '', url: '', logoUrl: '' as string, telegramChat: '',
  verifyMode: 'telegram_auto' as VerifyMode,
  rewardType: 'points' as RewardType,
  rewardPoints: '', rewardUsdt: '',
  payoutMode: 'auto' as 'auto' | 'manual',
  requireKyc: false,
  startsAt: '', endsAt: '', maxClaims: '', budgetUsdt: '',
}

const num = (s: string) => (s.trim() === '' ? null : Number(s))
const iso = (s: string) => (s ? new Date(s).toISOString() : null)

export default function AdminTasksPage() {
  const [tab, setTab] = useState<'tasks' | 'review' | 'payouts'>('review')
  const [tasks, setTasks] = useState<AdminPlatformTask[] | null>(null)
  const [subs, setSubs] = useState<AdminSubmission[] | null>(null)
  const [form, setForm] = useState(emptyForm)
  const [showForm, setShowForm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [txInputs, setTxInputs] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    try {
      const [t, s] = await Promise.all([adminPlatformTaskApi.list(), adminPlatformTaskApi.submissions()])
      setTasks(t)
      setSubs(s)
    } catch (e) {
      toast.error('Failed to load tasks', e instanceof Error ? e.message : undefined)
      setTasks([]); setSubs([])
    }
  }, [])
  useEffect(() => { void load() }, [load])

  const set = <K extends keyof typeof emptyForm>(k: K, v: (typeof emptyForm)[K]) => setForm((f) => ({ ...f, [k]: v }))

  async function create() {
    const body: NewTaskInput = {
      title: form.title,
      description: form.description || null,
      url: form.url || null,
      logoUrl: form.logoUrl || null,
      telegramChat: form.verifyMode === 'telegram_auto' ? form.telegramChat : null,
      verifyMode: form.verifyMode,
      rewardType: form.rewardType,
      rewardPoints: form.rewardType === 'points' ? num(form.rewardPoints) : null,
      rewardUsdt: form.rewardType === 'usdt' ? num(form.rewardUsdt) : null,
      payoutMode: form.payoutMode,
      requireKyc: form.requireKyc,
      startsAt: iso(form.startsAt),
      endsAt: iso(form.endsAt),
      maxClaims: num(form.maxClaims),
      budgetUsdt: form.rewardType === 'usdt' ? num(form.budgetUsdt) : null,
    }
    if (form.rewardType === 'usdt' && !window.confirm(`This task pays REAL USDT (${body.rewardUsdt} per claim${body.budgetUsdt ? `, budget ${body.budgetUsdt}` : ''}). Create it?`)) return
    setBusy(true)
    try {
      await adminPlatformTaskApi.create(body)
      toast.success('Task created')
      setForm(emptyForm); setShowForm(false)
      await load()
    } catch (e) {
      toast.error('Could not create task', e instanceof Error ? e.message : undefined)
    } finally { setBusy(false) }
  }

  async function toggle(t: AdminPlatformTask) {
    try {
      await adminPlatformTaskApi.update(t.id, { isActive: !t.isActive })
      await load()
    } catch (e) { toast.error('Update failed', e instanceof Error ? e.message : undefined) }
  }

  async function act(fn: () => Promise<unknown>, ok: string) {
    setBusy(true)
    try { await fn(); toast.success(ok); await load() }
    catch (e) { toast.error('Action failed', e instanceof Error ? e.message : undefined) }
    finally { setBusy(false) }
  }

  if (!tasks || !subs) return <LoadingState message="Loading tasks..." />

  const review = subs.filter((s) => s.status === 'pending_review')
  const payouts = subs.filter((s) => s.status === 'awaiting_payout')
  const reward = (s: { rewardType: string; rewardPoints: number | null; rewardUsdt: number | null }) =>
    s.rewardType === 'points' ? `${s.rewardPoints} pts` : `$${(s.rewardUsdt ?? 0).toFixed(2)} USDT`
  const who = (u: AdminSubmission['user']) => u.username || u.fullName || u.email

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
      <div>
          <h1 className="text-xl font-bold text-text-primary">Community Tasks</h1>
          <p className="text-xs text-text-muted mt-0.5">Create tasks (e.g. follow our Telegram) that reward Points or USDT.</p>
        </div>
        <button onClick={() => setShowForm((v) => !v)} className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-white hover:opacity-90">
          {showForm ? 'Close' : '+ New task'}
        </button>
      </div>

      {showForm && (
        <div className="rounded-2xl border border-border bg-surface p-5 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2"><label className={labelCls}>Title</label><input className={inputCls} value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="Follow our official Telegram" maxLength={120} /></div>
            <div className="sm:col-span-2"><label className={labelCls}>Description (optional)</label><input className={inputCls} value={form.description} onChange={(e) => set('description', e.target.value)} maxLength={500} /></div>
            <div className="sm:col-span-2"><TaskLogoField value={form.logoUrl} onChange={(u) => set('logoUrl', u ?? '')} /></div>
            <div><label className={labelCls}>Task link (https)</label><input className={inputCls} value={form.url} onChange={(e) => set('url', e.target.value)} placeholder="https://t.me/YourChannel" /></div>
            <div>
              <label className={labelCls}>Verification</label>
              <select className={inputCls} value={form.verifyMode} onChange={(e) => set('verifyMode', e.target.value as VerifyMode)}>
                <option value="telegram_auto">Telegram auto-check (bot)</option>
                <option value="manual_proof">Manual review (user submits proof)</option>
                <option value="self_claim" disabled={form.rewardType === 'usdt'}>Self-claim (points only)</option>
              </select>
            </div>
            {form.verifyMode === 'telegram_auto' && (
              <div className="sm:col-span-2">
                <label className={labelCls}>Telegram channel username</label>
                <input className={inputCls} value={form.telegramChat} onChange={(e) => set('telegramChat', e.target.value)} placeholder="@RupChainOfficial" />
                <p className="text-[11px] text-text-muted mt-1">The RupChain bot must be an administrator of this channel/group, and users must have linked Telegram.</p>
              </div>
            )}
            <div>
              <label className={labelCls}>Reward type</label>
              <select className={inputCls} value={form.rewardType} onChange={(e) => { const v = e.target.value as RewardType; set('rewardType', v); if (v === 'usdt' && form.verifyMode === 'self_claim') set('verifyMode', 'manual_proof') }}>
                <option value="points">RupChain Points</option>
                <option value="usdt">USDT</option>
              </select>
            </div>
            {form.rewardType === 'points' ? (
              <div><label className={labelCls}>Points per claim</label><input className={inputCls} type="number" min="0" value={form.rewardPoints} onChange={(e) => set('rewardPoints', e.target.value)} /></div>
            ) : (
              <>
                <div><label className={labelCls}>USDT per claim</label><input className={inputCls} type="number" min="0" step="0.01" value={form.rewardUsdt} onChange={(e) => set('rewardUsdt', e.target.value)} /></div>
                <div>
                  <label className={labelCls}>USDT delivery</label>
                  <select className={inputCls} value={form.payoutMode} onChange={(e) => set('payoutMode', e.target.value as 'auto' | 'manual')}>
                    <option value="auto">Automatic — credit the user&apos;s RupChain wallet</option>
                    <option value="manual">Manual — I send on-chain and record the tx hash</option>
                  </select>
                </div>
                <div><label className={labelCls}>Total USDT budget (hard cap)</label><input className={inputCls} type="number" min="0" step="0.01" value={form.budgetUsdt} onChange={(e) => set('budgetUsdt', e.target.value)} /></div>
              </>
            )}
            <div><label className={labelCls}>Starts (optional)</label><input className={inputCls} type="datetime-local" value={form.startsAt} onChange={(e) => set('startsAt', e.target.value)} /></div>
            <div><label className={labelCls}>Ends (optional)</label><input className={inputCls} type="datetime-local" value={form.endsAt} onChange={(e) => set('endsAt', e.target.value)} /></div>
            <div><label className={labelCls}>Max claims (optional{form.rewardType === 'usdt' ? ' — budget or this is required' : ''})</label><input className={inputCls} type="number" min="1" value={form.maxClaims} onChange={(e) => set('maxClaims', e.target.value)} /></div>
            <label className="flex items-center gap-2 text-sm text-text-primary sm:self-end pb-2">
              <input type="checkbox" checked={form.requireKyc} onChange={(e) => set('requireKyc', e.target.checked)} /> Require KYC
            </label>
          </div>
          <button onClick={create} disabled={busy || form.title.trim().length < 3} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
            {busy ? 'Creating…' : 'Create task'}
          </button>
        </div>
      )}

      <div className="grid grid-cols-3 gap-1.5 rounded-xl bg-surface p-1 border border-border" role="tablist">
        {([['review', `To review (${review.length})`], ['payouts', `USDT to pay (${payouts.length})`], ['tasks', `All tasks (${tasks.length})`]] as const).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
            className={`rounded-lg py-1.5 text-xs font-semibold transition-colors ${tab === id ? 'bg-primary text-white' : 'text-text-muted hover:text-text-primary'}`}>{label}</button>
        ))}
      </div>

      {tab === 'review' && (
        <div className="space-y-3">
          {review.length === 0 && <p className="text-sm text-text-muted text-center py-6">Nothing waiting for review.</p>}
          {review.map((s) => (
            <div key={s.id} className="rounded-xl border border-border bg-surface p-4 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-text-primary">{s.taskTitle}</p>
                  <p className="text-xs text-text-muted">{who(s.user)}{s.user.telegramUsername ? ` · @${s.user.telegramUsername}` : ''} · {new Date(s.createdAt).toLocaleString()}</p>
                </div>
                <span className="text-xs font-bold text-emerald-500 flex-shrink-0">{reward(s)}</span>
              </div>
              {s.proof && <p className="text-xs rounded-lg bg-canvas border border-border px-3 py-2 break-words">Proof: {s.proof}</p>}
              {s.payoutAddress && <p className="text-[11px] font-mono text-text-muted break-all">{s.payoutNetwork}: {s.payoutAddress}</p>}
              <div className="flex gap-2">
                <button disabled={busy} onClick={() => act(() => adminPlatformTaskApi.approve(s.id), 'Approved')} className="rounded-lg bg-success px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">Approve</button>
                <button disabled={busy} onClick={() => { const r = window.prompt('Reason for rejecting (shown to the user):'); if (r && r.trim().length >= 2) void act(() => adminPlatformTaskApi.reject(s.id, r.trim()), 'Rejected') }} className="rounded-lg border border-danger px-3 py-1.5 text-xs font-semibold text-danger disabled:opacity-50">Reject</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'payouts' && (
        <div className="space-y-3">
          <p className="text-xs text-text-muted">Send the USDT from your own wallet to the user&apos;s address, then paste the transaction hash to mark it paid. The hash can only be used once.</p>
          {payouts.length === 0 && <p className="text-sm text-text-muted text-center py-6">No payouts waiting.</p>}
          {payouts.map((s) => (
            <div key={s.id} className="rounded-xl border border-border bg-surface p-4 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-text-primary">{s.taskTitle}</p>
                  <p className="text-xs text-text-muted">{who(s.user)} · {new Date(s.createdAt).toLocaleString()}</p>
                </div>
                <span className="text-sm font-bold text-emerald-500 flex-shrink-0">${(s.rewardUsdt ?? 0).toFixed(2)} USDT</span>
              </div>
              <div className="flex items-center gap-2">
                <p className="text-[11px] font-mono text-text-primary break-all flex-1">{s.payoutNetwork}: {s.payoutAddress}</p>
                <button onClick={async () => { if (s.payoutAddress && await copyText(s.payoutAddress)) toast.success('Address copied') }} className="text-[11px] font-semibold text-primary flex-shrink-0">Copy</button>
              </div>
              <div className="flex gap-2">
                <input className={inputCls} placeholder="Transaction hash" value={txInputs[s.id] ?? ''} onChange={(e) => setTxInputs((m) => ({ ...m, [s.id]: e.target.value }))} />
                <button disabled={busy || !(txInputs[s.id] ?? '').trim()} onClick={() => act(() => adminPlatformTaskApi.pay(s.id, txInputs[s.id]!.trim()), 'Marked as paid')} className="rounded-lg bg-success px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50 flex-shrink-0">Mark paid</button>
                <button disabled={busy} onClick={() => { const r = window.prompt('Reason for cancelling this payout (shown to the user):'); if (r && r.trim().length >= 2) void act(() => adminPlatformTaskApi.reject(s.id, r.trim()), 'Cancelled') }} className="rounded-lg border border-danger px-3 py-1.5 text-xs font-semibold text-danger disabled:opacity-50 flex-shrink-0">Cancel</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'tasks' && <CommunityTaskStarter tasks={tasks} onCreated={load} />}

      {tab === 'tasks' && (
        <div className="space-y-3">
          {tasks.length === 0 && <p className="text-sm text-text-muted text-center py-6">No tasks yet. Create your first one above.</p>}
          {tasks.map((t) => {
            const done = (t.counts.completed ?? 0)
            return (
              <div key={t.id} className="rounded-xl border border-border bg-surface p-4 space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <TaskLogoField compact value={t.logoUrl} onChange={async (u) => { try { await adminPlatformTaskApi.update(t.id, { logoUrl: u }); toast.success(u ? 'Logo saved' : 'Logo removed'); await load() } catch (e) { toast.error('Could not save logo', e instanceof Error ? e.message : undefined) } }} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-text-primary">{t.title}</p>
                    <p className="text-xs text-text-muted">
                      {t.rewardType === 'points' ? `${t.rewardPoints} points` : `$${t.rewardUsdt} USDT (${t.payoutMode})`} · {t.verifyMode.replace('_', ' ')}
                      {t.endsAt ? ` · ends ${new Date(t.endsAt).toLocaleDateString()}` : ''}
                    </p>
                  </div>
                  <button onClick={() => toggle(t)} className={`flex-shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold ${t.isActive ? 'text-success bg-success/10' : 'text-text-muted bg-muted'}`}>
                    {t.isActive ? 'Active · tap to pause' : 'Paused · tap to resume'}
                  </button>
                </div>
                <div className="flex flex-wrap gap-2 text-[11px]">
                  <span className="rounded-full bg-canvas border border-border px-2 py-0.5">Claims {t.claimedCount}{t.maxClaims ? ` / ${t.maxClaims}` : ''}</span>
                  <span className="rounded-full bg-canvas border border-border px-2 py-0.5">Completed {done}</span>
                  {t.budgetUsdt != null && <span className="rounded-full bg-canvas border border-border px-2 py-0.5">Budget ${t.spentUsdt.toFixed(2)} / ${t.budgetUsdt.toFixed(2)}</span>}
                  {(Object.entries(t.counts) as [string, number][]).filter(([k]) => k !== 'completed').map(([k, v]) => (
                    <span key={k} className={`rounded-full px-2 py-0.5 ${STATUS_CLS[k] ?? ''}`}>{k.replace('_', ' ')} {v}</span>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
