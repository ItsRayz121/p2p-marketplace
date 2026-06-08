'use client'
import { useState } from 'react'
import { adminApi } from '@/lib/api'
import { fmtDateTime } from '@/lib/fmt'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { ConfirmModal } from '@/components/ui/ConfirmModal'
import { ShieldAlert, ShieldCheck, ShieldX, Clock, Eye, RotateCcw } from 'lucide-react'

export type ModerationStatus = 'active' | 'suspended' | 'temporarily_banned' | 'permanently_banned' | 'under_review'

export interface ModerationState {
  status: ModerationStatus
  isBanned?: boolean
  isSuspended?: boolean
  bannedUntil?: string | null
  suspendedUntil?: string | null
  underReview?: boolean
  banType?: string | null
  moderationReason?: string | null
}

const STATUS_META: Record<ModerationStatus, { label: string; variant: 'success' | 'warning' | 'danger' | 'default' }> = {
  active: { label: 'Active', variant: 'success' },
  suspended: { label: 'Suspended', variant: 'warning' },
  temporarily_banned: { label: 'Temporarily Banned', variant: 'danger' },
  permanently_banned: { label: 'Permanently Banned', variant: 'danger' },
  under_review: { label: 'Under Review', variant: 'default' },
}

const PRESETS: Array<{ label: string; hours: number }> = [
  { label: '24 Hours', hours: 24 },
  { label: '3 Days', hours: 72 },
  { label: '7 Days', hours: 168 },
  { label: '14 Days', hours: 336 },
  { label: '30 Days', hours: 720 },
]

function isoFromHours(hours: number): string {
  return new Date(Date.now() + hours * 3600 * 1000).toISOString()
}

// datetime-local value → ISO (treats the input as local time)
function isoFromLocal(local: string): string | null {
  if (!local) return null
  const d = new Date(local)
  return isNaN(d.getTime()) ? null : d.toISOString()
}

type Mode = 'none' | 'suspend' | 'ban'

export function ModerationPanel({
  userId,
  state,
  onChange,
}: {
  userId: string
  state: ModerationState
  onChange?: () => void
}) {
  const [mode, setMode] = useState<Mode>('none')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  // suspend / ban duration
  const [presetHours, setPresetHours] = useState<number | null>(null)
  const [customDate, setCustomDate] = useState('')
  const [banType, setBanType] = useState<'permanent' | 'temporary'>('permanent')

  const [confirm, setConfirm] = useState<null | { title: string; description: string; action: () => Promise<void>; danger?: boolean }>(null)

  const meta = STATUS_META[state.status]

  function resetForms() {
    setMode('none'); setReason(''); setPresetHours(null); setCustomDate(''); setBanType('permanent')
  }

  async function run(label: string, fn: () => Promise<void>, successMsg: string) {
    setBusy(label); setError(null); setSuccess(null)
    try {
      await fn()
      setSuccess(successMsg)
      resetForms()
      onChange?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setBusy(null)
    }
  }

  // Resolve the chosen duration into { until, durationLabel } or null (indefinite/permanent).
  function resolveDuration(): { until?: string; durationLabel?: string } | { error: string } {
    if (presetHours != null) {
      const preset = PRESETS.find((p) => p.hours === presetHours)
      return { until: isoFromHours(presetHours), durationLabel: preset?.label }
    }
    if (customDate) {
      const iso = isoFromLocal(customDate)
      if (!iso) return { error: 'Invalid custom date' }
      if (new Date(iso).getTime() <= Date.now()) return { error: 'End date must be in the future' }
      return { until: iso, durationLabel: 'Custom' }
    }
    return {}
  }

  function doSuspend() {
    if (reason.trim().length < 1) { setError('A reason is required'); return }
    const dur = resolveDuration()
    if ('error' in dur) { setError(dur.error); return }
    setConfirm({
      title: 'Suspend user',
      description: dur.until ? `Suspend until ${fmtDateTime(dur.until)}? They cannot sign in until then.` : 'Suspend indefinitely? They cannot sign in until lifted.',
      danger: true,
      action: () => run('suspend', () => adminApi.suspendUser(userId, { reason: reason.trim(), ...(dur.until ? { until: dur.until } : {}), ...(dur.durationLabel ? { durationLabel: dur.durationLabel } : {}) }), 'User suspended.'),
    })
  }

  function doBan() {
    if (reason.trim().length < 1) { setError('A reason is required'); return }
    let until: string | undefined; let durationLabel: string | undefined
    if (banType === 'temporary') {
      const dur = resolveDuration()
      if ('error' in dur) { setError(dur.error); return }
      if (!dur.until) { setError('A temporary ban requires a duration or end date'); return }
      until = dur.until; durationLabel = dur.durationLabel
    }
    setConfirm({
      title: banType === 'temporary' ? 'Temporarily ban user' : 'Permanently ban user',
      description: banType === 'temporary' && until ? `Ban until ${fmtDateTime(until)}? They lose all access until then.` : 'Permanently ban this user? They lose all platform access.',
      danger: true,
      action: () => run('ban', () => adminApi.banUser(userId, { reason: reason.trim(), type: banType, ...(until ? { until } : {}), ...(durationLabel ? { durationLabel } : {}) }), banType === 'temporary' ? 'User temporarily banned.' : 'User permanently banned.'),
    })
  }

  const durationPicker = (
    <div className="space-y-2">
      <p className="text-xs text-text-muted">Duration</p>
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p.hours}
            type="button"
            onClick={() => { setPresetHours(p.hours); setCustomDate('') }}
            className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${presetHours === p.hours ? 'border-primary bg-primary/10 text-primary' : 'border-border text-text-secondary hover:bg-surface-alt'}`}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-text-muted">or custom:</span>
        <input
          type="datetime-local"
          value={customDate}
          onChange={(e) => { setCustomDate(e.target.value); setPresetHours(null) }}
          className="px-2 py-1 border border-border rounded-md text-sm bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-primary"
        />
      </div>
    </div>
  )

  return (
    <div className="space-y-4">
      {/* Current status */}
      <div className="bg-surface border border-border rounded-xl p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-text-primary">Current status</span>
          <Badge variant={meta.variant} size="sm">{meta.label}</Badge>
          {state.underReview && state.status !== 'under_review' && <Badge variant="default" size="sm">Under Review</Badge>}
        </div>
        <div className="mt-2 grid sm:grid-cols-2 gap-1.5 text-xs text-text-muted">
          {state.suspendedUntil && <p className="flex items-center gap-1"><Clock size={12} /> Suspension lifts: {fmtDateTime(state.suspendedUntil)}</p>}
          {state.bannedUntil && <p className="flex items-center gap-1"><Clock size={12} /> Ban lifts: {fmtDateTime(state.bannedUntil)}</p>}
          {state.moderationReason && <p className="sm:col-span-2">Reason: <span className="text-text-secondary">{state.moderationReason}</span></p>}
        </div>
      </div>

      {error && <div className="px-3 py-2 bg-danger/10 border border-danger/20 rounded-lg text-danger text-sm">{error}</div>}
      {success && <div className="px-3 py-2 bg-success/10 border border-success/20 rounded-lg text-success text-sm">{success}</div>}

      {/* Action launcher */}
      <div className="flex flex-wrap gap-2">
        {!state.isSuspended && !state.isBanned && (
          <Button size="sm" variant="secondary" onClick={() => { resetForms(); setMode(mode === 'suspend' ? 'none' : 'suspend') }}>
            <Clock size={14} /> Suspend
          </Button>
        )}
        {!state.isBanned && (
          <Button size="sm" variant="danger" onClick={() => { resetForms(); setMode(mode === 'ban' ? 'none' : 'ban') }}>
            <ShieldX size={14} /> Ban
          </Button>
        )}
        {state.isSuspended && (
          <Button size="sm" variant="secondary" loading={busy === 'unsuspend'} onClick={() => setConfirm({ title: 'Lift suspension', description: 'Restore this user’s access?', action: () => run('unsuspend', () => adminApi.unsuspendUser(userId), 'Suspension lifted.') })}>
            <ShieldCheck size={14} /> Unsuspend
          </Button>
        )}
        {state.isBanned && (
          <Button size="sm" variant="secondary" loading={busy === 'unban'} onClick={() => setConfirm({ title: 'Lift ban', description: 'Restore this user’s access?', action: () => run('unban', () => adminApi.unbanUser(userId), 'Ban lifted.') })}>
            <ShieldCheck size={14} /> Unban
          </Button>
        )}
        {state.status !== 'active' && (
          <Button size="sm" variant="ghost" loading={busy === 'restore'} onClick={() => setConfirm({ title: 'Restore full access', description: 'Clear ALL restrictions (ban, suspension, review)?', action: () => run('restore', () => adminApi.restoreAccess(userId), 'Access restored.') })}>
            <ShieldCheck size={14} /> Restore Access
          </Button>
        )}
        <Button size="sm" variant="ghost" loading={busy === 'review'} onClick={() => run('review', () => adminApi.setUserReview(userId, { active: !state.underReview, reason: state.underReview ? 'Review closed' : 'Flagged for review' }), state.underReview ? 'Review flag cleared.' : 'User flagged for review.')}>
          <Eye size={14} /> {state.underReview ? 'End Review' : 'Mark Under Review'}
        </Button>
        <Button size="sm" variant="ghost" loading={busy === 'reset-trust'} onClick={() => setConfirm({ title: 'Reset trust score', description: 'Clear any manual badge override and recalculate this user’s trust score from real trade data?', action: () => run('reset-trust', () => adminApi.resetTrustScore(userId, { reason: 'Manual trust reset' }), 'Trust score recalculation queued.') })}>
          <RotateCcw size={14} /> Reset Trust
        </Button>
      </div>

      {/* Suspend form */}
      {mode === 'suspend' && (
        <div className="border border-border rounded-xl p-4 space-y-3">
          <p className="text-sm font-semibold text-text-primary flex items-center gap-1.5"><Clock size={15} /> Suspend user</p>
          {durationPicker}
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Reason (required) — shown to the user" className="w-full px-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-surface focus:outline-none focus:ring-2 focus:ring-primary resize-none" />
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" loading={busy === 'suspend'} disabled={!reason.trim()} onClick={doSuspend}>Apply Suspension</Button>
            <Button size="sm" variant="ghost" onClick={resetForms}>Cancel</Button>
          </div>
        </div>
      )}

      {/* Ban form */}
      {mode === 'ban' && (
        <div className="border border-danger/30 rounded-xl p-4 space-y-3">
          <p className="text-sm font-semibold text-danger flex items-center gap-1.5"><ShieldAlert size={15} /> Ban user</p>
          <div className="flex gap-1.5">
            {(['permanent', 'temporary'] as const).map((t) => (
              <button key={t} type="button" onClick={() => setBanType(t)} className={`px-3 py-1 text-xs rounded-md border capitalize transition-colors ${banType === t ? 'border-danger bg-danger/10 text-danger' : 'border-border text-text-secondary hover:bg-surface-alt'}`}>{t}</button>
            ))}
          </div>
          {banType === 'temporary' && durationPicker}
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Reason (required) — shown to the user" className="w-full px-3 py-2 border border-border rounded-lg text-sm text-text-primary bg-surface focus:outline-none focus:ring-2 focus:ring-primary resize-none" />
          <div className="flex gap-2">
            <Button size="sm" variant="danger" loading={busy === 'ban'} disabled={!reason.trim()} onClick={doBan}>Apply Ban</Button>
            <Button size="sm" variant="ghost" onClick={resetForms}>Cancel</Button>
          </div>
        </div>
      )}

      <ConfirmModal
        isOpen={!!confirm}
        onClose={() => setConfirm(null)}
        onConfirm={async () => { const c = confirm; setConfirm(null); if (c) await c.action() }}
        title={confirm?.title ?? ''}
        description={confirm?.description ?? ''}
        confirmLabel={confirm?.title ?? 'Confirm'}
        confirmVariant={confirm?.danger ? 'danger' : 'primary'}
      />
    </div>
  )
}
