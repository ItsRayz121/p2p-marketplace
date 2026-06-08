/**
 * SSE connection registry with Redis pub/sub fan-out.
 *
 * Each backend instance keeps its own in-process map of open EventSource
 * connections. Notifications are PUBLISHED to a shared Redis channel; every
 * instance subscribes and writes the event to whichever of its local
 * connections belong to the target user. This makes realtime correct on a
 * multi-instance deployment (Railway horizontal scale) — without it, a
 * notification only reached users who happened to be connected to the same
 * instance that produced it.
 *
 * If Redis publish fails we fall back to delivering locally so a single-instance
 * deployment still works when Redis is briefly unavailable.
 */

import type { ServerResponse } from 'node:http'
import type IORedis from 'ioredis'
import { redis } from './redis'
import { logger } from './logger'

interface SseClient {
  userId: string
  res: ServerResponse
}

const clients = new Map<string, SseClient>()

let _nextId = 1
function nextClientId() { return String(_nextId++) }

const SSE_CHANNEL = 'sse:events'
let subscriber: IORedis | null = null

/** Lazily create the Redis subscriber the first time this instance has a client. */
function ensureSubscriber(): void {
  if (subscriber) return
  const sub = redis.duplicate()
  subscriber = sub
  sub.on('error', (err) => logger.error({ err }, 'SSE subscriber error'))
  sub.subscribe(SSE_CHANNEL).catch((err) => logger.error({ err }, 'SSE subscribe failed'))
  sub.on('message', (channel, message) => {
    if (channel !== SSE_CHANNEL) return
    try {
      const { userId, data } = JSON.parse(message) as { userId: string; data: unknown }
      deliverLocal(userId, data)
    } catch {
      /* malformed pub/sub message — ignore */
    }
  })
}

/** Write an event to every local connection belonging to `userId`. */
function deliverLocal(userId: string, data: unknown): void {
  const payload = `data: ${JSON.stringify(data)}\n\n`
  for (const [, client] of clients) {
    if (client.userId === userId) {
      try {
        client.res.write(payload)
      } catch {
        // connection already closed; cleanup happens in the 'close' handler
      }
    }
  }
}

export function sseRegister(userId: string, res: ServerResponse): string {
  ensureSubscriber()
  const clientId = nextClientId()
  clients.set(clientId, { userId, res })
  return clientId
}

export function sseUnregister(clientId: string) {
  clients.delete(clientId)
}

/**
 * Emit an event to a user across ALL instances via Redis pub/sub. Local
 * connections receive it through the subscription handler (uniform path). If
 * publishing fails, deliver to this instance's local connections directly.
 */
export function sseEmit(userId: string, data: unknown) {
  redis
    .publish(SSE_CHANNEL, JSON.stringify({ userId, data }))
    .catch((err) => {
      logger.warn({ err, userId }, 'SSE publish failed — delivering locally only')
      deliverLocal(userId, data)
    })
}
