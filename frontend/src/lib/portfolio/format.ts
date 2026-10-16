/**
 * Display formatting for decimal STRINGS from the API. Uses string/BigInt arithmetic only, so a
 * cost basis or P&L is never routed through a floating-point Number.
 */
const DEC_RE = /^(-?)(\d+)(?:\.(\d+))?$/

/** Round half-up to `dp` places and group thousands. Non-numeric input is returned unchanged. */
export function formatDecimal(value: string, dp = 2): string {
  const m = DEC_RE.exec(value)
  if (!m) return value
  const [, sign, int, frac = ''] = m
  let n = BigInt(int + frac.slice(0, dp).padEnd(dp, '0'))
  if (frac.length > dp && frac.charAt(dp) >= '5') n += BigInt(1)
  const digits = n.toString().padStart(dp + 1, '0')
  const intPart = dp === 0 ? digits : digits.slice(0, -dp)
  const fracPart = dp === 0 ? '' : digits.slice(-dp)
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return (n === BigInt(0) ? '' : sign) + grouped + (dp ? '.' + fracPart : '')
}

/** Quantities: up to 8 places, trailing zeros trimmed. */
export function formatQuantity(value: string): string {
  const s = formatDecimal(value, 8)
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s
}

/** Signed amount with an explicit +/- so profit and loss never rely on colour alone. */
export function formatSigned(value: string, dp = 2): string {
  const s = formatDecimal(value, dp)
  return s.startsWith('-') || /^0(\.0+)?$/.test(s) ? s : '+' + s
}

export const isNegative = (value: string) => value.startsWith('-') && /[1-9]/.test(value)

/** Same shape the server enforces for amounts: plain decimal string, bounded digits. */
export const AMOUNT_RE = /^\d{1,28}(\.\d{1,18})?$/
export const isZeroAmount = (s: string) => /^0+(\.0+)?$/.test(s)
