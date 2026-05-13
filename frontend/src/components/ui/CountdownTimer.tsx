'use client'
import { useEffect } from 'react'
import { cn } from '@/lib/utils'
import { useCountdown } from '@/hooks/useCountdown'

interface CountdownTimerProps {
  expiresAt: string
  onExpire?: () => void
  showLabel?: boolean
}

export function CountdownTimer({ expiresAt, onExpire, showLabel }: CountdownTimerProps) {
  const { formatted, isExpired, minutes, seconds } = useCountdown(expiresAt)
  const isUrgent = !isExpired && minutes === 0 && seconds < 60

  useEffect(() => {
    if (isExpired && onExpire) onExpire()
  }, [isExpired, onExpire])

  if (isExpired) {
    return (
      <span className="text-danger font-medium text-sm">
        {showLabel && 'Time: '}Expired
      </span>
    )
  }

  return (
    <span
      className={cn(
        'font-mono font-semibold text-sm',
        isUrgent ? 'text-danger animate-pulse' : 'text-text-primary',
      )}
    >
      {showLabel && 'Expires in: '}
      {formatted}
    </span>
  )
}
