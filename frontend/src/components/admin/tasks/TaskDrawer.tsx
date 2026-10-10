'use client'
import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { adminPlatformTaskApi, PLATFORMS, type AdminPlatformTask, type NewTaskInput, type Platform, type RewardType, type VerifyMode } from '@/lib/platformTasks'
import { toast } from '@/lib/toast'
import { TaskLogoField } from '@/components/admin/promotions/TaskLogoField'
import { inputCls, labelCls } from './shared'

interface Form {
  title: string; platform: Platform | ''; description: string; instructions: string; url: string; logoUrl: string; telegramChat: string
  verifyMode: VerifyMode; proofRequirements: string; proofFileRequired: boolean
  rewardType: RewardType; rewardPoints: string; rewardUsdt: string; payoutMode: 'auto' | 'manual'; budgetUsdt: string; maxClaims: string
  startsAt: string; endsAt: string; requireKyc: boolean
}

const EMPTY: Form = {
  title: '', platform: '', description: '', instructions: '', url: '', logoUrl: '', telegramChat: '',
  verifyMode: 'manual_proof', proofRequirements: '', proofFileRequired: false,
  rewardType: 'points', rewardPoints: '', rewardUsdt: '', payoutMode: 'auto', budgetUsdt: '', maxClaims: '',
  startsAt: '', endsAt: '', requireKyc: false,
}

const num = (s: string) => (s.trim() === '' ? null : Number(s))
const localInput = (iso: string | null) => {
  if (!iso) return ''
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}
const isoOrNull = (s: string) => (s ? new Date(s).toISOString() : null)

function fromTask(t: AdminPlatformTask): Form {
  return {
    title: t.title, platform: t.platform ?? '', description: t.description ?? '', instructions: t.instructions ?? '', url: t.url ?? '', logoUrl: t.logoUrl ?? '', telegramChat: t.telegramChat ?? '',
    verifyMode: t.verifyMode, proofRequirements: t.proofRequirements ?? '', proofFileRequired: t.proofFileRequired,
    rewardType: t.rewardType, rewardPoints: t.rewardPoints != null ? String(t.rewardPoints) : '', rewardUsdt: t.rewardUsdt != null ? String(t.rewardUsdt) : '',
    payoutMode: t.payoutMode, budgetUsdt: t.budgetUsdt != null ? String(t.budgetUsdt) : '', maxClaims: t.maxClaims != null ? String(t.maxClaims) : '',
    startsAt: localInput(t.startsAt), endsAt: localInput(t.endsAt), requireKyc: t.requireKyc,
  }
}

/** Client-side checks that mirror the server's, so mistakes surface before the round trip. */
function validate(f: Form): string | null {
  if (f.title.trim().length < 3) return 'Give the task a title (at least 3 characters).'
  if (f.url && !/^https:\/\//i.test(f.url)) return 'The task link must start with https://'
  if (f.verifyMode === 'telegram_auto' && !/^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(f.telegramChat)) return 'Auto-verify needs the channel username, like @RupChainOfficial.'
  if (f.startsAt && f.endsAt && new Date(f.endsAt) <= new Date(f.startsAt)) return 'The end time must be after the start time.'
  if (f.rewardType === 'points') {
    const p = Number(f.rewardPoints)
    if (!(p > 0)) return 'Enter the points reward.'
  } else {
    const u = Number(f.rewardUsdt)
    if (!(u > 0)) return 'Enter the USDT reward per claim.'
    if (f.verifyMode === 'self_claim') return 'USDT tasks cannot be self-claimed.'
    if (!f.budgetUsdt && !f.maxClaims) return 'USDT tasks need a total budget or a max-claims limit.'
    if (f.budgetUsdt && Number(f.budgetUsdt) < u) return 'The total budget must cover at least one reward.'
  }
  return null
}

export function TaskDrawer({ task, open, onClose, onSaved }: { task: AdminPlatformTask | null; open: boolean; onClose: () => void; onSaved: () => void | Promise<void> }) {
  const [f, setF] = useState<Form>(EMPTY)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const editing = !!task
  // Reward + verification terms are frozen once members have claimed, so nobody is re-priced.
  const frozen = !!task && task.claimedCount > 0

  useEffect(() => { if (open) { setF(task ? fromTask(task) : EMPTY); setError(null) } }, [open, task])
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }))

  async function save(publish: boolean) {
    const problem = validate(f)
    if (problem && (publish || editing)) { setError(problem); return }
    if (!publish && !editing && f.title.trim().length < 3) { setError('Give the draft a title first.'); return }
    if (f.rewardType === 'usdt' && !editing && publish && !window.confirm(`This task pays REAL USDT ($${f.rewardUsdt} per claim${f.budgetUsdt ? `, budget $${f.budgetUsdt}` : ''}). Publish it?`)) return
    setBusy(true); setError(null)
    try {
      if (editing) {
        await adminPlatformTaskApi.update(task!.id, {
          title: f.title.trim(), description: f.description.trim() || null, instructions: f.instructions.trim() || null,
          proofRequirements: f.proofRequirements.trim() || null, proofFileRequired: f.proofFileRequired,
          platform: f.platform || null, url: f.url.trim() || null, logoUrl: f.logoUrl || null,
          startsAt: isoOrNull(f.startsAt), endsAt: isoOrNull(f.endsAt), maxClaims: num(f.maxClaims), requireKyc: f.requireKyc,
          ...(f.rewardType === 'usdt' ? { budgetUsdt: num(f.budgetUsdt) } : {}),
          ...(task!.isDraft && publish ? { isDraft: false } : {}),
        })
      } else {
        const body: NewTaskInput = {
          title: f.title.trim(), description: f.description.trim() || null, instructions: f.instructions.trim() || null,
          proofRequirements: f.proofRequirements.trim() || null, proofFileRequired: f.proofFileRequired,
          platform: f.platform || null, url: f.url.trim() || null, logoUrl: f.logoUrl || null,
          telegramChat: f.verifyMode === 'telegram_auto' ? f.telegramChat.trim() : null,
          verifyMode: f.verifyMode, rewardType: f.rewardType,
          rewardPoints: f.rewardType === 'points' ? num(f.rewardPoints) : null,
          rewardUsdt: f.rewardType === 'usdt' ? num(f.rewardUsdt) : null,
          payoutMode: f.payoutMode, requireKyc: f.requireKyc,
          startsAt: isoOrNull(f.startsAt), endsAt: isoOrNull(f.endsAt), maxClaims: num(f.maxClaims),
          budgetUsdt: f.rewardType === 'usdt' ? num(f.budgetUsdt) : null,
          isDraft: !publish,
        }
        await adminPlatformTaskApi.create(body)
      }
      toast.success(editing ? 'Task updated' : publish ? 'Task published' : 'Draft saved')
      await onSaved()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the task')
    } finally { setBusy(false) }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o && !busy) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col bg-surface shadow-xl focus:outline-none">
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <div>
              <Dialog.Title className="text-base font-bold text-text-primary">{editing ? 'Edit task' : 'New task'}</Dialog.Title>
              <Dialog.Description className="text-xs text-text-secondary">
                {editing ? `Version ${task!.version}. Changing requirements does not affect members who already claimed.` : 'Save as a draft to prepare it, or publish to open it to members.'}
              </Dialog.Description>
            </div>
            <Dialog.Close className="rounded-md p-1.5 text-text-muted hover:bg-surface-alt" aria-label="Close"><X className="h-4 w-4" /></Dialog.Close>
          </div>

          <div className="flex-1 space-y-6 overflow-y-auto px-5 py-4">
            <section className="space-y-3">
              <h3 className="text-sm font-semibold text-text-primary">Basics</h3>
              <div><label className={labelCls} htmlFor="t-title">Title</label><input id="t-title" className={inputCls} maxLength={120} value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="Follow our official Telegram" /></div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div><label className={labelCls} htmlFor="t-plat">Platform</label>
                  <select id="t-plat" className={inputCls} value={f.platform} onChange={(e) => set('platform', e.target.value as Platform | '')}>
                    <option value="">Not specified</option>{PLATFORMS.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select></div>
                <div><label className={labelCls} htmlFor="t-url">Task link (https)</label><input id="t-url" className={inputCls} value={f.url} onChange={(e) => set('url', e.target.value)} placeholder="https://t.me/YourChannel" /></div>
              </div>
              <div><label className={labelCls} htmlFor="t-desc">Short description</label><input id="t-desc" className={inputCls} maxLength={500} value={f.description} onChange={(e) => set('description', e.target.value)} /></div>
              <div><label className={labelCls} htmlFor="t-inst">Instructions for members</label><textarea id="t-inst" rows={4} maxLength={2000} className={inputCls} value={f.instructions} onChange={(e) => set('instructions', e.target.value)} placeholder={'1. Open the link\n2. Follow the account\n3. Submit your username'} /></div>
              <TaskLogoField value={f.logoUrl} onChange={(u) => set('logoUrl', u ?? '')} />
            </section>

            <section className="space-y-3">
              <h3 className="text-sm font-semibold text-text-primary">Verification &amp; proof</h3>
              {frozen && <p className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">Members have already claimed this task, so the verification method and reward are locked.</p>}
              <div><label className={labelCls} htmlFor="t-ver">How is it verified?</label>
                <select id="t-ver" className={inputCls} disabled={editing} value={f.verifyMode} onChange={(e) => set('verifyMode', e.target.value as VerifyMode)}>
                  <option value="manual_proof">Manual review (member submits proof)</option>
                  <option value="telegram_auto">Telegram auto-check (bot)</option>
                  <option value="self_claim" disabled={f.rewardType === 'usdt'}>Self-claim (points only, not verified)</option>
                </select></div>
              {f.verifyMode === 'telegram_auto' && (
                <div><label className={labelCls} htmlFor="t-tg">Telegram channel username</label><input id="t-tg" disabled={editing} className={inputCls} value={f.telegramChat} onChange={(e) => set('telegramChat', e.target.value)} placeholder="@RupChainOfficial" />
                  <p className="mt-1 text-[11px] text-text-muted">The RupChain bot must be an administrator of that channel, and members must have linked Telegram.</p></div>
              )}
              {f.verifyMode === 'manual_proof' && (
                <>
                  <div><label className={labelCls} htmlFor="t-proof">What proof should members submit?</label><textarea id="t-proof" rows={2} maxLength={1000} className={inputCls} value={f.proofRequirements} onChange={(e) => set('proofRequirements', e.target.value)} placeholder="A screenshot showing your username following the account." /></div>
                  <label className="flex items-center gap-2 text-sm text-text-primary"><input type="checkbox" checked={f.proofFileRequired} onChange={(e) => set('proofFileRequired', e.target.checked)} />Require a screenshot upload</label>
                </>
              )}
            </section>

            <section className="space-y-3">
              <h3 className="text-sm font-semibold text-text-primary">Reward</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <div><label className={labelCls} htmlFor="t-rt">Reward type</label>
                  <select id="t-rt" className={inputCls} disabled={editing} value={f.rewardType} onChange={(e) => { const v = e.target.value as RewardType; set('rewardType', v); if (v === 'usdt' && f.verifyMode === 'self_claim') set('verifyMode', 'manual_proof') }}>
                    <option value="points">RupChain Points</option><option value="usdt">USDT</option>
                  </select></div>
                {f.rewardType === 'points'
                  ? <div><label className={labelCls} htmlFor="t-pts">Points per claim</label><input id="t-pts" type="number" min="0" disabled={editing} className={inputCls} value={f.rewardPoints} onChange={(e) => set('rewardPoints', e.target.value)} /></div>
                  : <div><label className={labelCls} htmlFor="t-usd">USDT per claim</label><input id="t-usd" type="number" min="0" step="0.01" disabled={editing} className={inputCls} value={f.rewardUsdt} onChange={(e) => set('rewardUsdt', e.target.value)} /></div>}
              </div>
              {f.rewardType === 'usdt' && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div><label className={labelCls} htmlFor="t-pm">USDT delivery</label>
                    <select id="t-pm" className={inputCls} disabled={editing} value={f.payoutMode} onChange={(e) => set('payoutMode', e.target.value as 'auto' | 'manual')}>
                      <option value="auto">Automatic: credit the member&apos;s RupChain wallet</option>
                      <option value="manual">Manual: I send on-chain and record the tx hash</option>
                    </select></div>
                  <div><label className={labelCls} htmlFor="t-bud">Total USDT budget (hard cap)</label><input id="t-bud" type="number" min="0" step="0.01" className={inputCls} value={f.budgetUsdt} onChange={(e) => set('budgetUsdt', e.target.value)} /></div>
                </div>
              )}
              <div><label className={labelCls} htmlFor="t-max">Max claims{f.rewardType === 'usdt' ? ' (a budget or this is required)' : ' (optional)'}</label><input id="t-max" type="number" min="1" className={inputCls} value={f.maxClaims} onChange={(e) => set('maxClaims', e.target.value)} /></div>
            </section>

            <section className="space-y-3">
              <h3 className="text-sm font-semibold text-text-primary">Availability</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <div><label className={labelCls} htmlFor="t-s">Starts (optional)</label><input id="t-s" type="datetime-local" className={inputCls} value={f.startsAt} onChange={(e) => set('startsAt', e.target.value)} /></div>
                <div><label className={labelCls} htmlFor="t-e">Ends (optional)</label><input id="t-e" type="datetime-local" className={inputCls} value={f.endsAt} onChange={(e) => set('endsAt', e.target.value)} /></div>
              </div>
              <label className="flex items-center gap-2 text-sm text-text-primary"><input type="checkbox" checked={f.requireKyc} onChange={(e) => set('requireKyc', e.target.checked)} />Require KYC</label>
            </section>
          </div>

          <div className="space-y-2 border-t border-border px-5 py-3">
            {error && <p className="text-sm text-danger" role="alert">{error}</p>}
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" onClick={onClose} disabled={busy} className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-text-secondary hover:bg-surface-alt disabled:opacity-50">Cancel</button>
              {!editing && <button type="button" onClick={() => void save(false)} disabled={busy} className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-text-primary hover:bg-surface-alt disabled:opacity-50">Save draft</button>}
              <button type="button" onClick={() => void save(true)} disabled={busy} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                {busy ? 'Saving…' : editing ? (task!.isDraft ? 'Save & publish' : 'Save changes') : 'Publish'}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
