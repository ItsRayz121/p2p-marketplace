'use client'
import { useCallback, useEffect, useState } from 'react'
import { Info, Lock, RotateCcw } from 'lucide-react'
import { adminApi, type AdminNotifChannelPrefs, type AdminNotifGroup, type AdminNotifGroupMeta, type AdminNotifPrefs } from '@/lib/api'
import { GROUP_COLOR, GROUP_ORDER, PREFS_CHANGED_EVENT, playNotifChime } from '@/lib/adminNotifications'
import { toast } from '@/lib/toast'
import { LoadingState } from '@/components/ui/LoadingState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'

type Channel = keyof AdminNotifChannelPrefs

const CHANNELS: { key: Channel; label: string; effect: string }[] = [
  { key: 'inApp', label: 'In-app', effect: 'Shows in your bell, badge counts and the Notifications list. Turning it off hides this group from YOUR inbox only — the event is still recorded and other admins still see it.' },
  { key: 'push', label: 'Push', effect: 'Sends a browser/phone push to your subscribed devices. Off = no push for you; nothing else changes.' },
  { key: 'telegram', label: 'Telegram', effect: 'Sends a Telegram DM to your linked account (only for groups that DM by default). Off = no DM for you.' },
  { key: 'sound', label: 'Sound', effect: 'Plays a short chime in this admin panel when a new alert in this group arrives while the page is open.' },
]

const PRIORITY: Record<AdminNotifGroupMeta['priority'], { text: string; cls: string }> = {
  routine: { text: 'Routine', cls: 'bg-surface-alt text-text-secondary' },
  action: { text: 'Needs action', cls: 'bg-warning/10 text-warning' },
  critical: { text: 'Critical', cls: 'bg-danger/10 text-danger' },
}

/** One admin's personal delivery settings. Saved per account on the server, so they follow you across devices. */
export function NotificationPreferences() {
  const [data, setData] = useState<Awaited<ReturnType<typeof adminApi.getAdminNotificationPreferences>> | null>(null)
  const [prefs, setPrefs] = useState<AdminNotifPrefs | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState<AdminNotifGroup | null>(null)

  const load = useCallback(async () => {
    try {
      const d = await adminApi.getAdminNotificationPreferences()
      setData(d); setPrefs(d.prefs); setError(null)
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to load preferences') }
  }, [])
  useEffect(() => { void load() }, [load])

  const broadcast = () => window.dispatchEvent(new Event(PREFS_CHANGED_EVENT))

  async function toggle(group: AdminNotifGroup, ch: Channel) {
    if (!prefs) return
    const next = !prefs[group][ch]
    const before = prefs
    setPrefs({ ...prefs, [group]: { ...prefs[group], [ch]: next } }) // optimistic
    setSaving(`${group}:${ch}`)
    try {
      const res = await adminApi.saveAdminNotificationPreferences({ [group]: { [ch]: next } })
      setPrefs(res.prefs); broadcast()
    } catch (e) {
      setPrefs(before)
      toast.error('Could not save', e instanceof Error ? e.message : undefined)
    } finally { setSaving(null) }
  }

  async function bulk(patch: Partial<AdminNotifChannelPrefs>, groups: AdminNotifGroup[], okMsg: string) {
    setSaving('bulk')
    try {
      const res = await adminApi.saveAdminNotificationPreferences(Object.fromEntries(groups.map((g) => [g, patch])))
      setPrefs(res.prefs); broadcast(); toast.success(okMsg)
    } catch (e) { toast.error('Could not save', e instanceof Error ? e.message : undefined) }
    finally { setSaving(null) }
  }

  async function reset() {
    if (!window.confirm('Reset all your notification settings to the defaults?')) return
    setSaving('bulk')
    try { setPrefs((await adminApi.resetAdminNotificationPreferences()).prefs); broadcast(); toast.success('Back to defaults') }
    catch (e) { toast.error('Could not reset', e instanceof Error ? e.message : undefined) }
    finally { setSaving(null) }
  }

  async function preview(group: AdminNotifGroup) {
    if (!prefs) return
    setPreviewing(group)
    try {
      const r = await adminApi.previewAdminNotification(group)
      if (r.channels.sound) playNotifChime()
      const parts = [
        r.channels.inApp ? 'in-app: on' : 'in-app: off',
        r.sent.push ? 'push sent' : r.channels.push ? 'push: no device subscribed' : 'push: off',
        r.sent.telegram ? 'Telegram sent' : r.channels.telegram ? 'Telegram: not linked' : 'Telegram: off',
        r.channels.sound ? 'sound played' : 'sound: off',
      ]
      toast.success(`Preview — ${r.title}`, parts.join(' · '))
    } catch (e) { toast.error('Preview failed', e instanceof Error ? e.message : undefined) }
    finally { setPreviewing(null) }
  }

  if (error && !data) return <ErrorState title={error} onRetry={load} />
  if (!data || !prefs) return <LoadingState message="Loading preferences..." />

  const metaByKey = new Map(data.groups.map((g) => [g.key, g]))
  const groups = GROUP_ORDER.map((k) => metaByKey.get(k)).filter((g): g is AdminNotifGroupMeta => !!g)
  const routine = groups.filter((g) => g.priority === 'routine' && !g.mandatoryInApp).map((g) => g.key)
  const urgent = groups.filter((g) => g.priority !== 'routine').map((g) => g.key)

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-border bg-surface p-4 shadow-card">
        <h2 className="text-sm font-semibold text-text-primary">Your notification preferences</h2>
        <p className="mt-1 text-xs leading-relaxed text-text-muted">
          These settings belong to <strong className="text-text-secondary">your admin account only</strong> and sync across your devices. Every event is still recorded for the whole team — your choices only change what <em>you</em> are shown or alerted about. Identical alerts within {data.rules.externalDedupeSeconds}s are sent to devices once, and repeats are grouped in the list.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" disabled={saving === 'bulk'} onClick={() => void bulk({ inApp: false, sound: false, push: false }, routine, 'Routine alerts muted')}>Quiet routine trade &amp; campaign alerts</Button>
          <Button size="sm" variant="secondary" disabled={saving === 'bulk'} onClick={() => void bulk({ inApp: true, push: true, sound: true }, urgent, 'Urgent alerts fully on')}>Prioritise gas, payments &amp; disputes</Button>
          <Button size="sm" variant="ghost" disabled={saving === 'bulk'} onClick={() => void reset()}><RotateCcw className="mr-1 h-3.5 w-3.5" aria-hidden />Reset to defaults</Button>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-card">
        {/* Column headers (desktop) */}
        <div className="hidden grid-cols-[1fr_repeat(4,5.5rem)_5.5rem] items-center gap-2 border-b border-border px-4 py-2.5 text-xs font-medium text-text-muted md:grid">
          <span>Alert group</span>
          {CHANNELS.map((c) => <span key={c.key} className="text-center" title={c.effect}>{c.label}</span>)}
          <span className="text-center">Test</span>
        </div>
        <ul className="divide-y divide-border">
          {groups.map((g) => (
            <li key={g.key} className="grid gap-x-2 gap-y-2 px-4 py-3 md:grid-cols-[1fr_repeat(4,5.5rem)_5.5rem] md:items-center">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide', GROUP_COLOR[g.key])}>{g.label}</span>
                  <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-semibold', PRIORITY[g.priority].cls)}>{PRIORITY[g.priority].text}</span>
                  {g.mandatoryInApp && <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-text-muted"><Lock className="h-3 w-3" aria-hidden />Always shown in-app</span>}
                </div>
                <p className="mt-1 text-xs leading-snug text-text-muted">{g.description}</p>
              </div>
              {CHANNELS.map((c) => {
                const on = prefs[g.key][c.key]
                const locked = c.key === 'inApp' && g.mandatoryInApp
                const id = `np-${g.key}-${c.key}`
                return (
                  <div key={c.key} className="flex items-center justify-between gap-2 md:justify-center">
                    <label htmlFor={id} className="text-xs text-text-secondary md:sr-only" title={c.effect}>{c.label}</label>
                    <button
                      id={id}
                      type="button"
                      role="switch"
                      aria-checked={on}
                      aria-describedby={`${id}-d`}
                      disabled={locked || saving === `${g.key}:${c.key}`}
                      onClick={() => void toggle(g.key, c.key)}
                      className={cn(
                        'relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60',
                        on ? 'bg-primary' : 'bg-border-strong',
                      )}
                    >
                      <span className={cn('inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform', on ? 'translate-x-[22px]' : 'translate-x-0.5')} />
                    </button>
                    <span id={`${id}-d`} className="sr-only">{c.effect}{locked ? ' This one cannot be turned off.' : ''}</span>
                  </div>
                )
              })}
              <div className="md:text-center">
                <Button size="sm" variant="ghost" disabled={previewing === g.key} onClick={() => void preview(g.key)}>{previewing === g.key ? 'Sending…' : 'Preview'}</Button>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex gap-2 rounded-xl border border-border bg-surface p-3 text-xs leading-relaxed text-text-secondary">
        <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" aria-hidden />
        <ul className="list-disc space-y-1 pl-4">
          {CHANNELS.map((c) => <li key={c.key}><strong className="text-text-primary">{c.label}:</strong> {c.effect}</li>)}
          <li><strong className="text-text-primary">Always on:</strong> System &amp; security events always show in-app, so an outage or security alert can never be silenced by accident. You can still turn off their push, Telegram and sound.</li>
          <li><strong className="text-text-primary">Email:</strong> critical alerts email one shared team inbox when the platform email flag is on. That inbox is not per-admin, so it is not configurable here.</li>
          <li><strong className="text-text-primary">Preview</strong> sends a test only to you, over the channels you currently have on for that group. Nothing is posted to other admins.</li>
        </ul>
      </div>
    </div>
  )
}
