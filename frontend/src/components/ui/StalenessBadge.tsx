'use client'
import { useState, useEffect } from 'react'
import { Badge } from './Badge'

interface StalenessBadgeProps {
  updatedAt: string
  thresholdMinutes?: number
}

export function StalenessBadge({ updatedAt, thresholdMinutes = 6 }: StalenessBadgeProps) {
  const [isStale, setIsStale] = useState(false)

  useEffect(() => {
    function check() {
      const diffMs = Date.now() - new Date(updatedAt).getTime()
      setIsStale(diffMs > thresholdMinutes * 60 * 1000)
    }
    check()
    const interval = setInterval(check, 30_000)
    return () => clearInterval(interval)
  }, [updatedAt, thresholdMinutes])

  if (!isStale) return null

  return (
    <Badge variant="warning" size="sm">
      Rate may be stale
    </Badge>
  )
}
