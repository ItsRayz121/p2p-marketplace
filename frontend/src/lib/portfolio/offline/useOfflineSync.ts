'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { isNetworkError } from '@/lib/api'
import type { PortfolioApiLike } from '../apiTypes'
import type { PortfolioEventInput } from '../types'
import { claimCacheOwner, loadQueue, MAX_QUEUE, saveQueue, type QueuedEntry } from './cache'

interface Options {
  enabled: boolean
  userId?: string
  api: PortfolioApiLike
  /** Called after at least one queued entry reached the server. */
  onSynced: () => void
}

/**
 * Entries recorded while offline. Each keeps the request id the form generated, and the server
 * ignores a repeat of an id it already saw, so retrying (or a reply lost on a bad connection)
 * can never record an entry twice. Only recording an entry is queued: anything else (prices, tokens,
 * archiving, imports) needs a connection and says so.
 */
export function useOfflineSync({ enabled, userId, api, onSynced }: Options) {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine))
  const [queue, setQueue] = useState<QueuedEntry[]>([])
  const [syncing, setSyncing] = useState(false)
  const queueRef = useRef<QueuedEntry[]>([])
  const busy = useRef(false)
  const apiRef = useRef(api)
  apiRef.current = api
  const onSyncedRef = useRef(onSynced)
  onSyncedRef.current = onSynced

  const commit = useCallback(async (next: QueuedEntry[]) => {
    queueRef.current = next
    setQueue(next)
    if (userId) await saveQueue(userId, next)
  }, [userId])

  const syncNow = useCallback(async () => {
    if (!enabled || !userId || busy.current) return
    busy.current = true
    setSyncing(true)
    let anySynced = false
    try {
      let current = queueRef.current
      for (const item of current.filter((q) => q.status === 'pending')) {
        try {
          await apiRef.current.addEvent(item.assetId, item.input)
          current = current.filter((q) => q.id !== item.id)
          anySynced = true
          await commit(current)
        } catch (e) {
          if (isNetworkError(e)) break // still offline: keep everything, try again later
          current = current.map((q) => (q.id === item.id ? { ...q, status: 'failed' as const, error: e instanceof Error ? e.message : 'Could not be saved' } : q))
          await commit(current)
        }
      }
    } finally {
      busy.current = false
      setSyncing(false)
    }
    if (anySynced) onSyncedRef.current()
  }, [enabled, userId, commit])

  // Load whatever was queued earlier (after making sure the cache belongs to THIS user).
  useEffect(() => {
    if (!enabled || !userId) return
    let alive = true
    void (async () => {
      await claimCacheOwner(userId)
      const q = await loadQueue(userId)
      if (!alive) return
      queueRef.current = q
      setQueue(q)
      if (q.some((x) => x.status === 'pending') && navigator.onLine) void syncNow()
    })()
    return () => { alive = false }
  }, [enabled, userId, syncNow])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const up = () => { setOnline(true); void syncNow() }
    const down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down) }
  }, [syncNow])

  const enqueue = useCallback(async (assetId: string, assetName: string, input: PortfolioEventInput) => {
    if (queueRef.current.length >= MAX_QUEUE) throw new Error('Too many entries are waiting to sync. Reconnect to send them first.')
    if (input.clientRequestId && queueRef.current.some((q) => q.input.clientRequestId === input.clientRequestId)) return // same save pressed twice
    const entry: QueuedEntry = {
      id: input.clientRequestId ?? `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      assetId, assetName, input, queuedAt: new Date().toISOString(), status: 'pending',
    }
    await commit([...queueRef.current, entry])
  }, [commit])

  const discard = useCallback(async (id: string) => { await commit(queueRef.current.filter((q) => q.id !== id)) }, [commit])

  const retryFailed = useCallback(async () => {
    await commit(queueRef.current.map((q) => (q.status === 'failed' ? { ...q, status: 'pending' as const, error: undefined } : q)))
    void syncNow()
  }, [commit, syncNow])

  return { online, queue, syncing, enqueue, syncNow, discard, retryFailed }
}
