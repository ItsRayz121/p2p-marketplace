'use client'
import { useEffect, useRef, useState } from 'react'

interface UsePollingReturn {
  isPolling: boolean
}

export function usePolling(
  fn: () => Promise<void>,
  intervalMs: number,
  enabled: boolean = true,
): UsePollingReturn {
  const [isPolling, setIsPolling] = useState(false)
  const runningRef = useRef(false)
  const fnRef = useRef(fn)

  useEffect(() => {
    fnRef.current = fn
  }, [fn])

  useEffect(() => {
    if (!enabled) return

    async function run() {
      if (runningRef.current) return
      runningRef.current = true
      setIsPolling(true)
      try {
        await fnRef.current()
      } finally {
        runningRef.current = false
        setIsPolling(false)
      }
    }

    run()

    const interval = setInterval(run, intervalMs)
    return () => clearInterval(interval)
  }, [intervalMs, enabled])

  return { isPolling }
}
