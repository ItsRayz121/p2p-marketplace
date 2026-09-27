/** Relative-time formatting shared by the recent-activity tickers (CTM, USDT, Gas, Home). */
export function tradeTimeAgo(iso: string, opts?: { collapseAfter24h?: boolean }): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  if (opts?.collapseAfter24h) return 'Recently'
  return `${Math.floor(hrs / 24)}d ago`
}
