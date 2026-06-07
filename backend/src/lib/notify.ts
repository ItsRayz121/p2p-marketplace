/**
 * Central notification helper.
 * Creates a DB notification then fires SSE + push side-effects — all fire-and-forget.
 */
import { db } from './prisma'
import { Prisma } from '@prisma/client'
import { sseEmit } from './sse'
import { sendPushToUser } from './push.service'

export function notify(
  userId: string,
  type: string,
  title: string,
  body: string,
  metadata: Record<string, unknown>,
  /** If provided, the push notification deep-links to /trade/<id> */
  tradeId?: string,
  /** Explicit push deep-link URL — overrides the tradeId-based default (e.g. CTM rooms). */
  pushUrl?: string,
) {
  db.notification
    .create({ data: { userId, type, title, body, metadata: metadata as Prisma.InputJsonValue } })
    .then((notif) => {
      sseEmit(userId, { type: 'notification', payload: notif })
      const url = pushUrl ?? (tradeId ? `/trade/${tradeId}` : '/notifications')
      sendPushToUser(userId, { title, body, url }).catch(() => {})
    })
    .catch(() => {})
}
