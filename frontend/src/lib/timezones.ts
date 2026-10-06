export interface TimezoneOption {
  value: string
  label: string
  offsetMin: number
}

function offsetMinutes(tz: string, at: Date): number {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT'
    const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(part)
    if (!m) return 0
    return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0))
  } catch {
    return 0
  }
}

function fmtOffset(min: number): string {
  const sign = min < 0 ? '-' : '+'
  const a = Math.abs(min)
  return `UTC${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`
}

let cache: TimezoneOption[] | null = null

/** Every IANA timezone the browser knows, labelled "(UTC+05:00) Asia/Karachi" and sorted by offset. */
export function getTimezoneOptions(): TimezoneOption[] {
  if (cache) return cache
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] }
  let zones: string[] = []
  try { zones = intl.supportedValuesOf?.('timeZone') ?? [] } catch { zones = [] }
  if (!zones.includes('UTC')) zones = [...zones, 'UTC']
  if (zones.length < 5) zones = ['Asia/Karachi', 'Asia/Dubai', 'Europe/London', 'America/New_York', 'UTC']
  const now = new Date()
  cache = zones
    .map((value) => {
      const offsetMin = offsetMinutes(value, now)
      return { value, offsetMin, label: `(${fmtOffset(offsetMin)}) ${value.replace(/_/g, ' ')}` }
    })
    .sort((a, b) => a.offsetMin - b.offsetMin || a.value.localeCompare(b.value))
  return cache
}

export function detectDeviceTimezone(): string | null {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null } catch { return null }
}
