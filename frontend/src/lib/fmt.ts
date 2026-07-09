/**
 * Safe formatting helpers used across admin and platform pages.
 * These never throw — they return a safe fallback string instead.
 */

/** Format a date string as localised date. Returns '—' for null/undefined/invalid. */
export function fmtDate(value: string | Date | null | undefined): string {
  if (!value) return '—'
  const d = value instanceof Date ? value : new Date(value)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleDateString()
}

/** Format a date string as localised date + time. Returns '—' for null/undefined/invalid. */
export function fmtDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—'
  const d = value instanceof Date ? value : new Date(value)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleString()
}

/** Format a date string as localised time only. Returns '—' for null/undefined/invalid. */
export function fmtTime(value: string | Date | null | undefined): string {
  if (!value) return '—'
  const d = value instanceof Date ? value : new Date(value)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleTimeString()
}

/**
 * Safely convert a string|number|Decimal to a localised integer string.
 * Returns '0' for null/undefined/NaN.
 */
export function fmtNumber(value: string | number | null | undefined, fallback = '0'): string {
  if (value == null) return fallback
  const n = Number(value)
  if (isNaN(n)) return fallback
  return n.toLocaleString()
}

/**
 * Safely parse and format a crypto amount string to N decimal places.
 * Returns '0.000000' for null/undefined/NaN.
 */
export function fmtAmount(
  value: string | number | null | undefined,
  decimals = 6,
  fallback?: string,
): string {
  if (value == null) return fallback ?? (0).toFixed(decimals)
  const n = parseFloat(String(value))
  if (isNaN(n)) return fallback ?? (0).toFixed(decimals)
  return n.toFixed(decimals)
}

/**
 * Format an amount for DISPLAY at max 3 decimal places, trimming trailing
 * zeros and grouping the integer part with commas.
 *   0.947935 → "0.948"   5 → "5"   264 → "264"   1234.5 → "1,234.5"
 *
 * DISPLAY-ONLY. Never use this for an amount that must match on-chain / an
 * automated payment-matching check (e.g. gas unique-payment amounts) — rounding
 * those breaks detection. Safe for CTM/USDT manual/screenshot-confirmed amounts.
 * Returns '0' for null/undefined/NaN.
 */
export function fmt3(value: string | number | null | undefined): string {
  if (value == null) return '0'
  const n = Number(value)
  if (isNaN(n)) return '0'
  return n.toLocaleString(undefined, { maximumFractionDigits: 3 })
}

/** Format as PKR amount string with commas. Returns 'PKR 0' for null/undefined/NaN. */
export function fmtPkr(value: string | number | null | undefined): string {
  if (value == null) return 'PKR 0'
  const n = Number(value)
  if (isNaN(n)) return 'PKR 0'
  return `PKR ${n.toLocaleString()}`
}

/**
 * Format a date as Pakistan time (Asia/Karachi, "PKT" label). Used in
 * security-sensitive banners (withdrawal lock, deadlines) where ambiguity
 * about timezone changes the meaning. Falls back to '—' for invalid input.
 */
export function fmtPakDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—'
  const d = value instanceof Date ? value : new Date(value)
  if (isNaN(d.getTime())) return '—'
  return `${d.toLocaleString('en-PK', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })} PKT`
}

/** Truncate an address/hash for display. Returns '—' if falsy. */
export function fmtAddress(
  value: string | null | undefined,
  prefixLen = 8,
  suffixLen = 6,
): string {
  if (!value) return '—'
  if (value.length <= prefixLen + suffixLen + 3) return value
  return `${value.slice(0, prefixLen)}...${value.slice(-suffixLen)}`
}
