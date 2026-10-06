'use client'

import { useEffect, useState } from 'react'
import { availabilityApi } from '@/lib/api'
import type { ActiveHoursSettings } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { toast } from '@/lib/toast'
import { TimezoneSelect } from '@/components/ui/TimezoneSelect'

const inputCls = 'w-full rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/40'

/**
 * One availability window per person. Applies to ALL of the user's P2P ads (outside it the
 * ads stay visible but show "Offline — back at …" and can't be taken) and doubles as the
 * affiliate's active hours.
 */
export function ActiveHoursCard() {
  const [cfg, setCfg] = useState<ActiveHoursSettings | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [start, setStart] = useState('10:00')
  const [end, setEnd] = useState('22:00')
  const [tz, setTz] = useState('') // '' = platform default
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    availabilityApi.getActiveHours().then((c) => {
      setCfg(c)
      setEnabled(c.enabled)
      setStart(c.start)
      setEnd(c.end)
      setTz(c.timezone ?? '')
    }).catch(() => { /* card simply stays hidden */ })
  }, [])

  if (!cfg || !cfg.featureEnabled) return null

  async function save() {
    setSaving(true)
    try {
      await availabilityApi.saveActiveHours({ enabled, start, end, timezone: tz || null })
      toast.success(enabled ? 'Active hours saved' : 'Active hours turned off — you are always available')
      const fresh = await availabilityApi.getActiveHours()
      setCfg(fresh)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save active hours')
    } finally {
      setSaving(false)
    }
  }

  const effectiveTz = tz || cfg.platformTimezone

  return (
    <div className="bg-surface shadow-card border border-border rounded-xl p-5 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-text-primary">Active hours</h3>
          <p className="text-sm text-text-muted mt-1">
            Set the hours you are available. Outside them your ads stay visible but show you as offline and nobody can start a trade.
            The same hours apply to your affiliate activity.
          </p>
        </div>
        <label className="relative inline-flex flex-shrink-0 cursor-pointer items-center">
          <input type="checkbox" className="peer sr-only" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} aria-label="Enable active hours" />
          <span className="h-6 w-11 rounded-full bg-border transition-colors peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-primary/40" />
          <span className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform peer-checked:translate-x-5" />
        </label>
      </div>

      {enabled && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label className="block text-sm text-text-secondary">
            From
            <input type="time" className={`${inputCls} mt-1`} value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label className="block text-sm text-text-secondary">
            To
            <input type="time" className={`${inputCls} mt-1`} value={end} onChange={(e) => setEnd(e.target.value)} />
          </label>
          <label className="block text-sm text-text-secondary">
            Timezone
            <div className="mt-1"><TimezoneSelect value={tz} onChange={setTz} emptyLabel={`Platform default (${cfg.platformTimezone})`} /></div>
          </label>
        </div>
      )}

      <p className="text-xs text-text-muted">
        {enabled
          ? `Available ${start} – ${end} (${effectiveTz}). ${start > end ? 'This window runs overnight. ' : ''}You are currently ${cfg.online ? 'online' : 'offline'}.`
          : 'Off: your ads are available 24/7.'}
      </p>

      <div className="flex justify-end">
        <Button size="sm" loading={saving} onClick={save}>Save active hours</Button>
      </div>
    </div>
  )
}
