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
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor(totalSeconds / 60)
  const dispMinutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const isExpired = remainingMs === 0

  // Show H:MM:SS once we cross an hour so a long window doesn't read as "239:08".
  const formatted = isExpired
    ? '00:00'
    : hours > 0
      ? `${hours}:${String(dispMinutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
      : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`

  return { minutes, seconds, isExpired, formatted }
}
