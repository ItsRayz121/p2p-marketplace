'use client'
import { useEffect, useState } from 'react'
import { messagingApi } from '@/lib/messaging'
import { dedupe, userKey } from '@/lib/swrCache'
import { useAuth } from '@/hooks/useAuth'

/**
 * Whether the admin has voice messages switched on (`voice_messages_enabled`).
 * Defaults to true so the mic never flickers away while the flag loads, and so a
 * failed fetch can't disable the feature — the server enforces the switch anyway.
 * Shares the 5s-deduped `msg-summary` request the navbar already makes.
 */
export function useVoiceEnabled(): boolean {
  const { user } = useAuth()
  const [enabled, setEnabled] = useState(true)
  useEffect(() => {
    if (!user) return
    let cancelled = false
    dedupe(userKey(user.id, 'msg-summary'), 5_000, () => messagingApi.getSummary())
      .then((s) => { if (!cancelled && s.voiceEnabled === false) setEnabled(false) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [user])
  return enabled
}
