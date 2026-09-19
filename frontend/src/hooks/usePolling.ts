'use client'
import { useCallback, useEffect, useRef, useState } from 'react'

interface UsePollingReturn {
  isPolling: boolean
}

export function usePolling(
  fn: () => Promise<void>,
  intervalMs: number,
  enabled: boolean = true,
  // Optional: force an extra immediate fetch whenever these values change
  // (e.g. filters), on top of the mount fetch and the regular interval —
  // for callers whose fn identity changes for reasons other than a poll tick.
  refetchDeps: readonly unknown[] = [],
): UsePollingReturn {
  const [isPolling, setIsPolling] = useState(false)
  const runningRef = useRef(false)
  const fnRef = useRef(fn)
  const isFirstDepsRun = useRef(true)

  useEffect(() => {
    fnRef.current = fn
  }, [fn])

  const run = useCallback(async () => {
    if (runningRef.current) return
    runningRef.current = true
    setIsPolling(true)
    try {
      await fnRef.current()
    } finally {
      runningRef.current = false
      setIsPolling(false)
    }
  }, [])

  useEffect(() => {
    if (!enabled) return

    run()

    const interval = setInterval(run, intervalMs)
    return () => clearInterval(interval)
  }, [intervalMs, enabled, run])

  useEffect(() => {
    // The effect above already fetches once on mount; skip its first run so
    // this only fires for a genuine refetchDeps change afterward.
    if (isFirstDepsRun.current) {
      isFirstDepsRun.current = false
      return
    }
    if (!enabled) return
    run()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetchDeps is caller-supplied and intentionally dynamic
  }, refetchDeps)

  return { isPolling }
}
