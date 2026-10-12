'use client'
import { useCallback, useEffect, useRef, useState } from 'react'

export interface LiveData<T> {
  /** null until the first response for the CURRENT key (never a stand-in zero). */
  data: T | null
  /** True while there is no data yet for the current key. */
  loading: boolean
  /** True during a background/manual refetch that already has data. */
  refreshing: boolean
  error: string | null
  /** A refetch failed while older data for this key is still shown. */
  stale: boolean
  updatedAt: Date | null
  /** Refetch now; resolves when the response (or failure) has been applied. */
  refresh: () => Promise<void>
}

/**
 * Fetches `fetcher` whenever `key` changes, then polls while the tab is visible and
 * refetches on window focus. Responses that arrive after the key changed (or after a
 * newer request started) are discarded, so rapid filter switching can never restore
 * old results. Data from the previous key is cleared immediately.
 */
export function useLiveData<T>(fetcher: () => Promise<T>, key: string, intervalMs = 30_000): LiveData<T> {
  const [state, setState] = useState<{ key: string; data: T | null; error: string | null; stale: boolean; updatedAt: Date | null; refreshing: boolean }>({
    key, data: null, error: null, stale: false, updatedAt: null, refreshing: false,
  })
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher
  const seq = useRef(0)
  const keyRef = useRef(key)
  keyRef.current = key

  const run = useCallback(async () => {
    const id = ++seq.current
    const forKey = keyRef.current
    setState((s) => (s.key === forKey ? { ...s, refreshing: s.data !== null } : s))
    try {
      const data = await fetcherRef.current()
      if (id !== seq.current || forKey !== keyRef.current) return
      setState({ key: forKey, data, error: null, stale: false, updatedAt: new Date(), refreshing: false })
    } catch (err) {
      if (id !== seq.current || forKey !== keyRef.current) return
      const message = err instanceof Error ? err.message : 'Failed to load'
      setState((s) => (s.key === forKey
        ? { ...s, error: message, stale: s.data !== null, refreshing: false }
        : { key: forKey, data: null, error: message, stale: false, updatedAt: null, refreshing: false }))
    }
  }, [])

  useEffect(() => {
    setState((s) => (s.key === key ? s : { key, data: null, error: null, stale: false, updatedAt: null, refreshing: false }))
    void run()
    const tick = () => { if (document.visibilityState === 'visible') void run() }
    const interval = setInterval(tick, intervalMs)
    window.addEventListener('focus', tick)
    document.addEventListener('visibilitychange', tick)
    const counter = seq
    return () => {
      clearInterval(interval)
      window.removeEventListener('focus', tick)
      document.removeEventListener('visibilitychange', tick)
      counter.current++ // invalidate anything still in flight for the old key
    }
  }, [key, intervalMs, run])

  const current = state.key === key
  return {
    data: current ? state.data : null,
    loading: !current || (state.data === null && state.error === null),
    refreshing: current && state.refreshing,
    error: current ? state.error : null,
    stale: current && state.stale,
    updatedAt: current ? state.updatedAt : null,
    refresh: run,
  }
}
