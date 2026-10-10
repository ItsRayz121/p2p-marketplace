/** Pure listing-boost rules (no DB access) so they can be unit tested. */

export interface BoostPlan { key: string; label: string; hours: number; cost: number }

/** Longest a boost can run into the future in total (stops unlimited stacking). */
export const MAX_BOOST_HOURS = 24 * 14

export const DEFAULT_BOOST_PLANS: BoostPlan[] = [
  { key: 'day', label: '24 hours', hours: 24, cost: 60 },
  { key: 'week', label: '7 days', hours: 24 * 7, cost: 300 },
]

export function validPlan(o: unknown): BoostPlan | null {
  const r = o as Record<string, unknown>
  const key = typeof r?.key === 'string' ? r.key.trim() : ''
  const hours = Number(r?.hours)
  const cost = Number(r?.cost)
  if (!/^[a-z0-9_]{2,20}$/.test(key) || !Number.isFinite(hours) || hours < 1 || hours > MAX_BOOST_HOURS) return null
  if (!Number.isFinite(cost) || cost <= 0) return null
  return { key, label: typeof r.label === 'string' && r.label ? r.label.slice(0, 40) : `${hours} hours`, hours: Math.floor(hours), cost }
}

/** Pure: the new boostedUntil, or null when it would exceed the stacking cap. */
export function nextBoostEnd(now: Date, current: Date | null, hours: number): Date | null {
  const start = current && current.getTime() > now.getTime() ? current : now
  const end = new Date(start.getTime() + hours * 3_600_000)
  return end.getTime() - now.getTime() > MAX_BOOST_HOURS * 3_600_000 ? null : end
}

