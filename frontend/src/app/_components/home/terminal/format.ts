// Number formatting shared by the Terminal homepage widgets.

/** Price with precision that suits its size: 943,505 · 282.38 · 0.9883 · 0.004211 */
export function fmtPrice(n: number | null | undefined): string {
  if (n === null || n === undefined || !isFinite(n)) return '—'
  const a = Math.abs(n)
  const max = a >= 1000 ? 0 : a >= 1 ? 2 : a >= 0.01 ? 4 : 6
  return n.toLocaleString('en-US', { maximumFractionDigits: max })
}

/** PKR amount with thousands separators, up to 2 decimals. */
export function fmtPkr(n: number | null | undefined): string {
  if (n === null || n === undefined || !isFinite(n)) return '—'
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

/** 1.2K · 3.21M · 4.5B */
export function fmtCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || !isFinite(n)) return '—'
  const a = Math.abs(n)
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 })
}

/** Colour class + arrow label for a percentage change; null → neutral dash. */
export function changeView(c: number | null | undefined): { cls: string; label: string } {
  if (c === null || c === undefined || !isFinite(c)) return { cls: 'text-text-muted', label: '—' }
  if (c > 0) return { cls: 'text-success', label: `▲ ${c.toFixed(2)}%` }
  if (c < 0) return { cls: 'text-danger', label: `▼ ${Math.abs(c).toFixed(2)}%` }
  return { cls: 'text-text-muted', label: '0.00%' }
}
