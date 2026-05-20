/**
 * In-process SSE connection registry.
 *
 * Each authenticated user may have one active EventSource connection.
 * When a notification fires we push a JSON event to the matching response.
 * Railway / any single-instance deployment works out of the box.
 * Multi-instance: migrate to Redis pub/sub.
 */

import type { ServerResponse } from 'node:http'

interface SseClient {
  userId: string
  res: ServerResponse
}

const clients = new Map<string, SseClient>()

let _nextId = 1
function nextClientId() { return String(_nextId++) }

export function sseRegister(userId: string, res: ServerResponse): string {
  const clientId = nextClientId()
  clients.set(clientId, { userId, res })
  return clientId
}

export function sseUnregister(clientId: string) {
  clients.delete(clientId)
}

export function sseEmit(userId: string, data: unknown) {
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
