'use client'

import { useMemo } from 'react'
import { getTimezoneOptions, detectDeviceTimezone } from '@/lib/timezones'

interface Props {
  value: string
  onChange: (tz: string) => void
  /** Adds a first option meaning "no choice" (e.g. "Platform default (Asia/Karachi)"). Value ''. */
  emptyLabel?: string
  className?: string
  id?: string
}

const selectCls = 'w-full rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/40'

/** Native select with every timezone (works well with the mobile picker) + a "use my device" shortcut. */
export function TimezoneSelect({ value, onChange, emptyLabel, className, id }: Props) {
  const options = useMemo(() => {
    const all = getTimezoneOptions()
    return value && !all.some((o) => o.value === value) ? [{ value, label: value, offsetMin: 0 }, ...all] : all
  }, [value])
  const device = typeof window !== 'undefined' ? detectDeviceTimezone() : null

  return (
    <div className="space-y-1">
      <select id={id} className={className ?? selectCls} value={value} onChange={(e) => onChange(e.target.value)}>
        {emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {device && device !== value && (
        <button type="button" onClick={() => onChange(device)} className="text-xs text-primary hover:underline">
          Use my device timezone ({device.replace(/_/g, ' ')})
        </button>
      )}
    </div>
  )
}
