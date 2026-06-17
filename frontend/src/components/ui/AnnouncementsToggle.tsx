'use client'
// Settings toggle for the "Announcements & updates" broadcast lane. Independent
// of transactional alerts — turning this OFF never suppresses trade / money /
// security notifications.
import { useState, useEffect } from 'react'
import { announcementApi } from '@/lib/api'

export function AnnouncementsToggle() {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    announcementApi
      .getPreferences()
      .then((p) => { if (active) setEnabled(p.announcementsEnabled) })
      .catch(() => { if (active) setEnabled(true) })
    return () => { active = false }
  }, [])

  const toggle = async () => {
    if (enabled === null || busy) return
    const next = !enabled
    setBusy(true)
    setEnabled(next) // optimistic
    try {
      await announcementApi.setAnnouncementsEnabled(next)
    } catch {
      setEnabled(!next) // revert on failure
    } finally {
      setBusy(false)
    }
  }

  if (enabled === null) return null

  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      onClick={toggle}
      disabled={busy}
      className="flex items-center gap-3 disabled:opacity-60"
    >
      <span
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${enabled ? 'bg-primary' : 'bg-surface-alt'}`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-6' : 'translate-x-1'}`}
        />
      </span>
      <span className="text-sm text-text-secondary">{enabled ? 'On' : 'Off'}</span>
    </button>
  )
}
