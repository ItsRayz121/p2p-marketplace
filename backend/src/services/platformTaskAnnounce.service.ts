/**
 * "New task is live" alert for Community Tasks.
 *
 *  - Bell: every non-banned user gets an in-app notification, regardless of push/Telegram settings.
 *  - Push: only users who enabled device push (they hold a push subscription) and have not muted
 *    announcements. No Telegram DM on purpose — keeps bot volume low.
 *
 * Fire-and-forget; a Redis flag makes it once-per-task even if the task is paused/resumed or edited.
 */
import { Prisma } from '@prisma/client'
import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { logger } from '../lib/logger'
import { sendPushToUser } from '../lib/push.service'

const BATCH = 500
const PUSH_CONCURRENCY = 25

function rewardText(t: { rewardType: string; rewardPoints: Prisma.Decimal | null; rewardUsdt: Prisma.Decimal | null }): string {
  return t.rewardType === 'points' ? `${Number(t.rewardPoints ?? 0)} points` : `$${Number(t.rewardUsdt ?? 0).toFixed(2)} USDT`
}

export async function announceTaskLive(taskId: string): Promise<void> {
  try {
    const first = await redis.set(`task:live-notified:${taskId}`, '1', 'EX', 90 * 86_400, 'NX')
    if (!first) return

    const task = await db.platformTask.findUnique({ where: { id: taskId } })
    if (!task) return

    const title = 'New task is live'
    const body = `${task.title} · Earn ${rewardText(task)}`
    const metadata = { taskId: task.id, bucket: 'available' } as Prisma.InputJsonValue

    let cursor: string | undefined
    let bell = 0
    for (;;) {
      const users = await db.user.findMany({
        where: { isBanned: false },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: BATCH,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      })
      if (users.length === 0) break
      await db.notification.createMany({ data: users.map((u) => ({ userId: u.id, type: 'task_new', title, body, metadata })) })
      bell += users.length
      cursor = users[users.length - 1]!.id
      if (users.length < BATCH) break
    }

    const pushUsers = await db.user.findMany({
      where: { isBanned: false, announcementsEnabled: true, pushSubscriptions: { some: {} } },
      select: { id: true },
    })
    const url = '/points?tab=tasks&bucket=available'
    for (let i = 0; i < pushUsers.length; i += PUSH_CONCURRENCY) {
      await Promise.allSettled(pushUsers.slice(i, i + PUSH_CONCURRENCY).map((u) => sendPushToUser(u.id, { title, body, url })))
    }
    logger.info({ taskId, bell, push: pushUsers.length }, '[platform-task] live announcement sent')
  } catch (err) {
    logger.error({ err, taskId }, '[platform-task] live announcement failed')
  }
}
