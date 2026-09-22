// Shared number formatters for the /markets pages (list, detail, related-tokens
// rail). Pulled out of MarketsTable.tsx / RelatedTokens.tsx / markets/[slug]/page.tsx,
// which each defined byte-identical copies of these — kept here so a future
// precision/locale change only has to happen once.

/** PKR price display: 2dp normally, 4dp when the value is a small fraction (<1). */
export function fmtMarketPkr(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  const max = n !== 0 && Math.abs(n) < 1 ? 4 : 2
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: max })
}

/** USDT-equivalent price display: 2dp normally, 6dp when the value is a small fraction (<1). */
export function fmtMarketUsdt(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  const max = n !== 0 && Math.abs(n) < 1 ? 6 : 2
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: max })
}
