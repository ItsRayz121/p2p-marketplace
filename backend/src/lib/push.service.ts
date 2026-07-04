import webpush from 'web-push'
import type { UserRole } from '@prisma/client'
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

/**
 * Fan a push out to every staff member holding one of the given roles who has a
 * push subscription. Used for role-scoped admin notifications so, e.g., a
 * kyc_reviewer only gets OS-level alerts for KYC events. Fire-and-forget.
 */
export async function sendPushToRoles(roles: UserRole[], payload: PushPayload): Promise<void> {
  if (!pushConfigured || roles.length === 0) return
  try {
    const staff = await db.user.findMany({
      where: { role: { in: roles } },
      select: { id: true },
    })
    await Promise.allSettled(staff.map((a) => sendPushToUser(a.id, payload)))
  } catch (err) {
    logger.warn({ err }, 'Role-scoped push fan-out failed')
  }
}

/**
 * Fan a push out to every staff member (admin / super_admin / kyc_reviewer /
 * support_agent) who has a push subscription. Fire-and-forget; never throws.
 */
export async function sendPushToAdmins(payload: PushPayload): Promise<void> {
  return sendPushToRoles(['admin', 'super_admin', 'kyc_reviewer', 'support_agent'], payload)
}
