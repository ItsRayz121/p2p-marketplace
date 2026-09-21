// Shared "Online now / Active Xm ago" label, derived purely from User.lastSeenAt (already
// bumped on every authenticated request — see backend/src/middleware/auth.middleware.ts).
// No extra cost to compute or fetch: any surface that already loads a user's lastSeenAt can
// render this for free. Originally lived only in the marketplace ad list; pulled out here so
// the messaging inbox/thread header can reuse the exact same thresholds and copy.
export function activeLabel(lastSeenAt: string | null): { text: string; cls: string } | null {
  if (!lastSeenAt) return null
  const diff = Date.now() - new Date(lastSeenAt).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 10)  return { text: 'Online now',    cls: 'text-success' }
  if (mins < 60)  return { text: `Active ${mins}m ago`, cls: 'text-success' }
  const hrs = Math.floor(mins / 60)
  if (hrs < 6)    return { text: `Active ${hrs}h ago`,  cls: 'text-text-muted' }
  if (hrs < 24)   return { text: 'Active today',        cls: 'text-text-muted' }
  const days = Math.floor(hrs / 24)
  if (days <= 3)  return { text: `Active ${days}d ago`,  cls: 'text-text-muted' }
  return null
}
