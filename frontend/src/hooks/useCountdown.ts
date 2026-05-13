'use client'
import { useState, useEffect } from 'react'

interface CountdownResult {
  minutes: number
  seconds: number
  isExpired: boolean
  formatted: string
}

export function useCountdown(expiresAt: string): CountdownResult {
  function getRemainingMs(): number {
    return Math.max(0, new Date(expiresAt).getTime() - Date.now())
  }

  const [remainingMs, setRemainingMs] = useState<number>(getRemainingMs)

  useEffect(() => {
    setRemainingMs(getRemainingMs())
    const interval = setInterval(() => {
      const ms = getRemainingMs()
      setRemainingMs(ms)
      if (ms === 0) clearInterval(interval)
    }, 1000)
    return () => clearInterval(interval)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiresAt])

  const totalSeconds = Math.floor(remainingMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  const isExpired = remainingMs === 0

  const formatted = isExpired
    ? '00:00'
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`

  return { minutes, seconds, isExpired, formatted }
}
