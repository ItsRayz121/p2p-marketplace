import webpush from 'web-push'
import { db } from './prisma'
import { logger } from './logger'
import { env } from './env'

let pushConfigured = false

export function configurePush() {
  if (
    !env.VAPID_PUBLIC_KEY ||
    !env.VAPID_PRIVATE_KEY ||
    !env.VAPID_SUBJECT
  ) {
    logger.warn('Web Push not configured — VAPID keys missing. Push notifications disabled.')
    return
  }
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY)
  pushConfigured = true
  logger.info('Web Push VAPID configured.')
}

export interface PushPayload {
  title: string
  body: string
  url?: string
  icon?: string
}

export async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
  if (!pushConfigured) return

  const subs = await db.pushSubscription.findMany({ where: { userId } })
  if (subs.length === 0) return

  const message = JSON.stringify({
    title: payload.title,
    body: payload.body,
    url: payload.url ?? '/',
    // Use the current R+chain badge, not the retired white/green favicon.svg —
    // that old asset was what showed as the wrong logo on push notifications.
    icon: payload.icon ?? '/brand/icon-192.png',
  })

  const stale: string[] = []

  await Promise.allSettled(
    subs.map(async (sub) => {
      const keys = sub.keys as { p256dh: string; auth: string }
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys },
          message,
          { TTL: 86400 },
        )
      } catch (err: unknown) {
        const statusCode = (err as { statusCode?: number }).statusCode
        if (statusCode === 410 || statusCode === 404) {
          stale.push(sub.id)
        } else {
          logger.warn({ err, userId }, 'Push send failed')
        }
      }
    }),
  )

  if (stale.length > 0) {
    await db.pushSubscription.deleteMany({ where: { id: { in: stale } } }).catch(() => {})
  }
}
