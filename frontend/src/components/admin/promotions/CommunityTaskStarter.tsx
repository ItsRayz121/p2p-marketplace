'use client'
import { useState } from 'react'
import { adminPlatformTaskApi, type AdminPlatformTask, type NewTaskInput, type VerifyMode } from '@/lib/platformTasks'
import { COMMUNITY_CHANNELS, type CommunityChannel } from '@/lib/contact'
import { toast } from '@/lib/toast'

/**
 * One-click creation of "join our official channel" tasks from the SAME configured links the
 * public Community page uses (lib/contact) — no URL is typed or invented here. Idempotent: a
 * channel that already has a task (matched by URL) is shown as existing and can't be duplicated,
 * so a reward can't be granted twice for the same channel.
 *
 * Opening a social link does not prove anyone joined. Each task therefore declares how it is
 * actually verified: Telegram bot check (only where the bot can verify), manual proof review, or
 * honour-based self-confirmation (points only).
 */

const norm = (u: string | null | undefined) => (u ?? '').trim().replace(/\/+$/, '').toLowerCase()

/** @handle for Telegram public links (t.me/<handle>); null for invite links and non-Telegram brands. */
function telegramHandle(c: CommunityChannel): string | null {
  if (c.brand !== 'telegram') return null
  const m = /^https:\/\/t\.me\/([A-Za-z][A-Za-z0-9_]{4,31})\/?$/.exec(c.href)
  return m ? `@${m[1]}` : null
}

const VERIFY_HELP: Record<VerifyMode, string> = {
  telegram_auto: 'Verified automatically by the RupChain bot. The bot must be an administrator of the chat, and the user must have linked Telegram.',
  manual_proof: 'An admin reviews the proof (username or screenshot link) the user submits before the reward is released.',
  self_claim: 'Honour-based: the user confirms they joined and the reward is granted instantly. Nothing proves it — keep the reward small.',
}

export function CommunityTaskStarter({ tasks, onCreated }: { tasks: AdminPlatformTask[]; onCreated: () => void | Promise<void> }) {
  const [draft, setDraft] = useState<Record<string, { points: string; mode: VerifyMode }>>({})
  const [busy, setBusy] = useState<string | null>(null)

  async function create(c: CommunityChannel) {
    const d = draft[c.id]
    const points = Number(d?.points)
    const mode = d?.mode ?? 'manual_proof'
    if (!(points > 0)) { toast.error('Enter the points reward first'); return }
    const handle = telegramHandle(c)
    if (mode === 'telegram_auto' && !handle) { toast.error('Automatic checking needs a public Telegram handle'); return }
    const body: NewTaskInput = {
      title: c.brand === 'whatsapp' ? `Follow RupChain on WhatsApp` : c.id === 'telegram-community' ? 'Join the RupChain Telegram community' : 'Follow RupChain Telegram announcements',
      description: c.purpose,
      url: c.href,
      telegramChat: mode === 'telegram_auto' ? handle : null,
      verifyMode: mode,
      rewardType: 'points',
      rewardPoints: points,
      rewardUsdt: null,
      payoutMode: 'auto',
      requireKyc: false,
    }
    setBusy(c.id)
    try {
      await adminPlatformTaskApi.create(body)
      toast.success(`Task created for ${c.label}`)
      await onCreated()
    } catch (e) {
      toast.error('Could not create task', e instanceof Error ? e.message : undefined)
    } finally { setBusy(null) }
  }

  return (
    <section className="rounded-xl border border-border bg-surface p-4 shadow-card space-y-3" aria-label="Official community tasks">
      <div>
        <h2 className="text-sm font-bold text-text-primary">Official community tasks</h2>
        <p className="text-xs text-text-muted">Create a points task for each official channel from the links configured for the Community page. Each channel can have one task, rewarded once per user.</p>
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        {COMMUNITY_CHANNELS.map((c) => {
          const existing = tasks.find((t) => norm(t.url) === norm(c.href))
          const handle = telegramHandle(c)
          const d = draft[c.id] ?? { points: '', mode: 'manual_proof' as VerifyMode }
          return (
            <div key={c.id} className="rounded-lg border border-border p-3 space-y-2">
              <p className="text-sm font-semibold text-text-primary">{c.label}</p>
              <a href={c.href} target="_blank" rel="noopener noreferrer" className="block truncate text-xs text-primary hover:underline">{c.href}</a>
              {existing ? (
                <p className="rounded-md bg-success/10 px-2 py-1.5 text-xs text-success">
                  Task exists — {existing.rewardPoints ?? 0} points · {existing.isActive ? 'active' : 'paused'} · {existing.verifyMode.replace('_', ' ')}
                </p>
              ) : (
                <>
                  <label className="block text-[11px] font-semibold text-text-muted">
                    How is it verified?
                    <select
                      value={d.mode}
                      onChange={(e) => setDraft((p) => ({ ...p, [c.id]: { ...d, mode: e.target.value as VerifyMode } }))}
                      className="mt-1 w-full rounded-lg border border-border bg-canvas px-2 py-1.5 text-xs font-normal text-text-primary"
                    >
                      <option value="manual_proof">Manual review (proof required)</option>
                      {handle && <option value="telegram_auto">Telegram bot check</option>}
                      <option value="self_claim">Self-confirmed (honour-based)</option>
                    </select>
                  </label>
                  <p className="text-[11px] leading-snug text-text-muted">{VERIFY_HELP[d.mode]}</p>
                  <label className="block text-[11px] font-semibold text-text-muted">
                    Points reward
                    <input
                      type="number" min="1" inputMode="numeric" value={d.points}
                      onChange={(e) => setDraft((p) => ({ ...p, [c.id]: { ...d, points: e.target.value } }))}
                      className="mt-1 w-full rounded-lg border border-border bg-canvas px-2 py-1.5 text-xs font-normal text-text-primary"
                    />
                  </label>
                  <button
                    type="button" onClick={() => void create(c)} disabled={busy === c.id}
                    className="w-full rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
                  >
                    {busy === c.id ? 'Creating…' : 'Create task'}
                  </button>
                </>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
