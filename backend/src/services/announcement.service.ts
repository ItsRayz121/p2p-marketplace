// Broadcast announcements — admin-composed product/feature/gas updates fanned
// out across the website banner (web), in-app bell, and Telegram bot.
//
// Channels are independent: "web" needs no fan-out (the banner is queried live
// per user, filtered by dismissals); "bell" writes a Notification row per
// opted-in user; "telegram" DMs every opted-in linked user, THROTTLED to stay
// under Telegram's ~30 msg/sec ceiling. The heavy fan-out runs in a background
// job (see queues) — createAnnouncement only writes the row + enqueues.
import { db } from '../lib/prisma'
import { Prisma } from '@prisma/client'
import { logger } from '../lib/logger'
import { sendTelegramAnnouncement } from '../lib/telegram.notify'

export type AnnouncementChannel = 'web' | 'bell' | 'telegram'
export const ANNOUNCEMENT_CHANNELS: readonly AnnouncementChannel[] = ['web', 'bell', 'telegram'] as const

export interface CreateAnnouncementInput {
  title: string
  body: string
  linkUrl?: string
  channels: AnnouncementChannel[]
  adminId: string
}

/**
 * Preflight reach estimate shown in the admin "Send?" confirmation. Counts the
 * users an announcement would actually touch given current opt-out state.
 */
export async function getAudienceCounts(): Promise<{ bell: number; telegram: number }> {
  const [bell, telegram] = await Promise.all([
    db.user.count({ where: { announcementsEnabled: true, isBanned: false } }),
    // Reachable on Telegram = linked AND not blocked (blocked users would 403).
    db.user.count({ where: { announcementsEnabled: true, isBanned: false, telegramId: { not: null }, telegramBlockedAt: null } }),
  ])
  return { bell, telegram }
}

/** Write the announcement row. The caller enqueues the broadcast job. */
export async function createAnnouncement(input: CreateAnnouncementInput) {
  return db.announcement.create({
    data: {
      title:    input.title,
      body:     input.body,
      linkUrl:  input.linkUrl ?? null,
      channels: input.channels,
      sentByAdminId: input.adminId,
    },
  })
}

const BELL_BATCH = 500          // Notification rows per createMany
// Telegram broadcast pacing. Sequential, one message every TG_SEND_INTERVAL_MS
// → ~20/sec, deliberately under the 30/sec free ceiling with headroom. We do NOT
// fire bursts in parallel: sequential pacing makes 429 back-off correct.
const TG_SEND_INTERVAL_MS = 50
// If Telegram ever asks us to wait longer than this, it's a shadow-ban / heavy
// throttle signal — we ABORT the whole broadcast rather than keep pushing
// ("better no leads than a banned bot"). Lower than the 300s spam-report
// threshold so we bail well before that territory.
const TG_ABORT_RETRY_AFTER_S = 60
// Circuit breaker: if this many recipients in a row reject us (403 / never
// started the bot), something is systemically wrong — abort before we rack up a
// pile of failed sends, which is itself an early shadow-ban signal.
const TG_MAX_CONSECUTIVE_BLOCKED = 25
// Max attempts per user when OUR OWN limiter keeps deferring the send (heavy
// concurrent transactional traffic). After this we skip the user, never the bot.
const TG_MAX_ATTEMPTS = 6

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Deliver an announcement to the bell + Telegram channels. Idempotency is
 * best-effort: the job runs once (attempts:1) and stamps delivery counts. The
 * "web" channel needs no work here — the banner endpoint reads it live.
 */
export async function runAnnouncementBroadcast(announcementId: string): Promise<void> {
  const ann = await db.announcement.findUnique({ where: { id: announcementId } })
  if (!ann) {
    logger.warn({ announcementId }, '[announcement] broadcast: row not found — skipping')
    return
  }
  const channels = ann.channels as AnnouncementChannel[]

  // ── Bell fan-out ──────────────────────────────────────────────────────────
  let bellRecipients = 0
  if (channels.includes('bell')) {
    const metadata = { announcementId: ann.id, ...(ann.linkUrl ? { linkUrl: ann.linkUrl } : {}) } as Prisma.InputJsonValue
    let cursor: string | undefined
    for (;;) {
      const users = await db.user.findMany({
        where: { announcementsEnabled: true, isBanned: false },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: BELL_BATCH,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      })
      if (users.length === 0) break
      await db.notification.createMany({
        data: users.map((u) => ({
          userId: u.id,
          type: 'announcement',
          title: ann.title,
          body: ann.body,
          metadata,
        })),
      })
      bellRecipients += users.length
      cursor = users[users.length - 1]!.id
      if (users.length < BELL_BATCH) break
    }
    logger.info({ announcementId, bellRecipients }, '[announcement] bell fan-out complete')
  }

  // ── Telegram throttled broadcast ──────────────────────────────────────────
  // Sequential + paced (~20/sec). Honors retry_after on 429, aborts on a
  // shadow-ban-grade back-off, and permanently flags users who 403 so neither
  // this nor any future broadcast/transactional send ever DMs them again.
  let telegramSent = 0
  let telegramFailed = 0
  let telegramBlocked = 0
  if (channels.includes('telegram')) {
    const recipients = await db.user.findMany({
      where: { announcementsEnabled: true, isBanned: false, telegramId: { not: null }, telegramBlockedAt: null },
      select: { telegramId: true },
    })

    const blockedIds: bigint[] = []
    let aborted = false
    let consecutiveBlocked = 0

    outer:
    for (const u of recipients) {
      const tgId = u.telegramId!
      let settled = false
      for (let attempt = 0; attempt < TG_MAX_ATTEMPTS && !settled; attempt++) {
        const r = await sendTelegramAnnouncement(tgId, ann.title, ann.body, ann.linkUrl ?? undefined)

        if (r.ok) { telegramSent++; consecutiveBlocked = 0; settled = true; break }

        if (r.blocked) {
          telegramBlocked++; blockedIds.push(tgId); settled = true
          if (++consecutiveBlocked >= TG_MAX_CONSECUTIVE_BLOCKED) {
            logger.error({ announcementId, consecutiveBlocked },
              '[announcement] too many recipients in a row reject the bot — ABORTING broadcast')
            aborted = true; break outer
          }
          break
        }

        if (r.retryAfter !== undefined) {
          if (r.retryAfter > TG_ABORT_RETRY_AFTER_S) {
            logger.error({ announcementId, retryAfter: r.retryAfter },
              '[announcement] Telegram asked for a long back-off — ABORTING broadcast to protect the bot')
            aborted = true; break outer
          }
          await sleep((r.retryAfter + 1) * 1000)
          continue // honor Telegram's back-off, then retry this user
        }

        if (r.throttledLocally) {
          await sleep(300) // our own global limiter is saturated — wait, then retry
          continue
        }

        // Other transient error — skip this user, don't penalise the bot.
        telegramFailed++; consecutiveBlocked = 0; settled = true
        break
      }
      if (!settled) telegramFailed++ // attempts exhausted (stayed throttled)
      await sleep(TG_SEND_INTERVAL_MS)
    }

    // Persist blocked users in one batch so we never message them again.
    if (blockedIds.length > 0) {
      await db.user.updateMany({
        where: { telegramId: { in: blockedIds } },
        data: { telegramBlockedAt: new Date() },
      }).catch((err) => logger.warn({ err }, '[announcement] failed to flag blocked Telegram users'))
    }

    logger.info(
      { announcementId, telegramSent, telegramFailed, telegramBlocked, aborted },
      '[announcement] telegram broadcast complete',
    )
  }

  await db.announcement.update({
    where: { id: announcementId },
    data: { bellRecipients, telegramSent, telegramFailed: telegramFailed + telegramBlocked },
  }).catch((err) => logger.warn({ err, announcementId }, '[announcement] failed to stamp delivery counts'))
}

/** Active website banners for a user — "web" channel, not yet dismissed. */
export async function getActiveBanners(userId: string) {
  // Respect the opt-out: a user who muted announcements sees no banner either.
  const pref = await db.user.findUnique({ where: { id: userId }, select: { announcementsEnabled: true } })
  if (pref && !pref.announcementsEnabled) return []

  const rows = await db.announcement.findMany({
    where: {
      isActive: true,
      channels: { has: 'web' },
      dismissals: { none: { userId } },
    },
    orderBy: { createdAt: 'desc' },
    take: 3,
    select: { id: true, title: true, body: true, linkUrl: true, createdAt: true },
  })
  return rows
}

/** Hide a banner for one user (idempotent). */
export async function dismissBanner(userId: string, announcementId: string): Promise<void> {
  await db.announcementDismissal.upsert({
    where: { announcementId_userId: { announcementId, userId } },
    create: { announcementId, userId },
    update: {},
  })
}
