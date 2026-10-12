'use client'
import { useCallback, useMemo } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  DEFAULT_GAS_RANGE, GAS_RANGE_OPTIONS, browserTimeZone, resolveGasRange, type GasRangeKey, type ResolvedRange,
} from '@/lib/gasInsights'

/** Replace-style URL query state, so filters survive refresh and back/forward navigation. */
export function useUrlParams() {
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()
  const get = useCallback((k: string) => sp.get(k), [sp])
  const set = useCallback((updates: Record<string, string | null>) => {
    const next = new URLSearchParams(sp.toString())
    for (const [k, v] of Object.entries(updates)) {
      if (v === null || v === '') next.delete(k)
      else next.set(k, v)
    }
    const qs = next.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }, [sp, router, pathname])
  return { get, set, searchParams: sp }
}

const VALID = new Set<string>(GAS_RANGE_OPTIONS.map((o) => o.key))

/**
 * The selected date range, kept in the URL (?range=7d, or ?range=custom&rangeFrom=…&rangeTo=…) so it
 * survives refresh and is reused when navigating to Analytics. Defaults to 7d.
 */
export function useGasRange() {
  const { get, set, searchParams } = useUrlParams()
  const tz = useMemo(() => browserTimeZone(), [])
  const raw = get('range')
  const customFrom = get('rangeFrom')
  const customTo = get('rangeTo')
  const range: GasRangeKey = raw && VALID.has(raw) ? (raw as GasRangeKey) : DEFAULT_GAS_RANGE
  // Incomplete custom ranges fall back to the default rather than querying nonsense.
  const effective: GasRangeKey = range === 'custom' && !(customFrom && customTo && customFrom <= customTo) ? DEFAULT_GAS_RANGE : range

  /** Resolve at call time so rolling windows (24h, "today") stay current while polling. */
  const resolve = useCallback((): ResolvedRange => resolveGasRange(effective, tz, { from: customFrom, to: customTo }), [effective, tz, customFrom, customTo])
  const key = `${effective}|${effective === 'custom' ? `${customFrom}|${customTo}` : ''}|${tz}`

  const setRange = useCallback((r: GasRangeKey, custom?: { from: string; to: string }) => {
    if (r === 'custom') set({ range: 'custom', rangeFrom: custom?.from ?? customFrom ?? null, rangeTo: custom?.to ?? customTo ?? null })
    else set({ range: r === DEFAULT_GAS_RANGE ? null : r, rangeFrom: null, rangeTo: null })
  }, [set, customFrom, customTo])

  /** Query string that carries this range to another page (e.g. Analytics). */
  const carryQuery = useMemo(() => {
    const p = new URLSearchParams()
    const r = searchParams.get('range')
    if (r) p.set('range', r)
    if (r === 'custom') { if (customFrom) p.set('rangeFrom', customFrom); if (customTo) p.set('rangeTo', customTo) }
    const s = p.toString()
    return s ? `?${s}` : ''
  }, [searchParams, customFrom, customTo])

  return { range: effective, customFrom, customTo, tz, key, resolve, setRange, carryQuery }
}
