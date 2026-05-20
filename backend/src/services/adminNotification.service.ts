import { db } from '../lib/prisma'
import type { AdminNotifCategory } from '@prisma/client'
import { logger } from '../lib/logger'
import { Prisma } from '@prisma/client'

export interface AdminNotifPayload {
  category: AdminNotifCategory
  title: string
  body: string
  href?: string
  metadata?: Record<string, unknown>
}

/**
 * Fire-and-forget helper — writes an admin notification row.
 * Never throws; logs errors instead so callers don't need try/catch.
 */
export async function createAdminNotif(payload: AdminNotifPayload): Promise<void> {
  try {
    await db.adminNotification.create({
      data: {
        category: payload.category,
        title:    payload.title,
        body:     payload.body,
        href:     payload.href ?? null,
        metadata: (payload.metadata ?? {}) as Prisma.InputJsonValue,
      },
    })
  } catch (err) {
    logger.error({ err, category: payload.category, title: payload.title }, 'Failed to create admin notification')
  }
}
