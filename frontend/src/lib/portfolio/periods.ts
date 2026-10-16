export type PeriodPreset = 'month' | '7d' | '30d' | '90d' | 'all' | 'custom'

export const PERIOD_LABEL: Record<PeriodPreset, string> = {
  month: 'This month', '7d': '7D', '30d': '30D', '90d': '90D', all: 'All time', custom: 'Custom',
}

export interface PeriodRange {
  /** undefined = from the first recorded entry. */
  from: Date | undefined
  to: Date
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Resolve a period in the viewer's own time zone (the "month" starts at local midnight on the 1st).
 * Custom dates are `YYYY-MM-DD` strings from a date input; the end date includes its whole day but
 * never reaches into the future.
 */
export function resolvePeriod(
  preset: PeriodPreset,
  now: Date,
  custom?: { from: string; to: string },
): PeriodRange | { error: string } {
  switch (preset) {
    case 'month':
      return { from: new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0), to: now }
    case '7d':
      return { from: new Date(now.getTime() - 7 * DAY_MS), to: now }
    case '30d':
      return { from: new Date(now.getTime() - 30 * DAY_MS), to: now }
    case '90d':
      return { from: new Date(now.getTime() - 90 * DAY_MS), to: now }
    case 'all':
      return { from: undefined, to: now }
    case 'custom': {
      const f = parseLocalDate(custom?.from ?? '')
      const t = parseLocalDate(custom?.to ?? '')
      if (!f || !t) return { error: 'Choose a start and an end date.' }
      const end = new Date(t.getFullYear(), t.getMonth(), t.getDate(), 23, 59, 59, 999)
      if (f.getTime() > end.getTime()) return { error: 'The start date must be before the end date.' }
      if (f.getTime() > now.getTime()) return { error: 'The start date cannot be in the future.' }
      return { from: f, to: end.getTime() > now.getTime() ? now : end }
    }
  }
}

/** `YYYY-MM-DD` -> local midnight, or null if it is not a real calendar date. */
export function parseLocalDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3])
  const date = new Date(y, mo, d, 0, 0, 0, 0)
  return date.getFullYear() === y && date.getMonth() === mo && date.getDate() === d ? date : null
}
