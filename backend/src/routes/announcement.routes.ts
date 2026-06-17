import type { FastifyInstance } from 'fastify'
import { authenticate, requireRole } from '../middleware/auth.middleware'
import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { Errors } from '../lib/errors'
import { queues } from '../queues/definitions'
import {
  createAnnouncement,
  getAudienceCounts,
  getActiveBanners,
  dismissBanner,
  ANNOUNCEMENT_CHANNELS,
  type AnnouncementChannel,
} from '../services/announcement.service'

const adminOrSuper = requireRole('admin', 'super_admin')

// Anti-spam guardrail: minimum gap between Telegram BROADCASTS. Frequent bulk
// DMs — even to opted-in users — raise block/report rates, which is Telegram's
// real spam signal and the path to a bot ban. Website/bell-only announcements
// carry no DM and are NOT cooled down. 4h ⇒ at most a handful of DMs/day.
const TG_BROADCAST_COOLDOWN_S = 4 * 60 * 60
const TG_BROADCAST_COOLDOWN_KEY = 'announcement:tg:cooldown'

function humanizeSeconds(s: number): string {
  if (s >= 3600) {
    const h = Math.floor(s / 3600)
    const m = Math.round((s % 3600) / 60)
    return m > 0 ? `${h}h ${m}m` : `${h}h`
  }
  return `${Math.max(1, Math.round(s / 60))}m`
}

function sanitizeChannels(raw: unknown): AnnouncementChannel[] {
  if (!Array.isArray(raw)) return []
  const set = new Set<AnnouncementChannel>()
  for (const c of raw) {
    if (typeof c === 'string' && (ANNOUNCEMENT_CHANNELS as readonly string[]).includes(c)) {
      set.add(c as AnnouncementChannel)
    }
  }
  return [...set]
}

export async function announcementRoutes(app: FastifyInstance) {
  // ── ADMIN ─────────────────────────────────────────────────────────────────

  // GET /admin/announcements/audience — preflight reach for the Send confirm
  app.get('/admin/announcements/audience', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const counts = await getAudienceCounts()
    return reply.send({ success: true, data: counts })
  })

  // GET /admin/announcements — history (most recent first)
  app.get('/admin/announcements', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const q = req.query as Record<string, string>
    const page  = Math.max(1, parseInt(q.page ?? '1', 10))
    const limit = Math.min(parseInt(q.limit ?? '20', 10), 100)
    const skip  = (page - 1) * limit

    const [announcements, total] = await Promise.all([
      db.announcement.findMany({
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { sentByAdmin: { select: { username: true } } },
      }),
      db.announcement.count(),
    ])

    return reply.send({
      success: true,
      data: { announcements, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
    })
  })

  // POST /admin/announcements — compose + broadcast
  app.post('/admin/announcements', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const b = req.body as { title?: unknown; body?: unknown; linkUrl?: unknown; channels?: unknown }

    const title = typeof b.title === 'string' ? b.title.trim() : ''
    const body  = typeof b.body  === 'string' ? b.body.trim()  : ''
    const linkUrlRaw = typeof b.linkUrl === 'string' ? b.linkUrl.trim() : ''
    const channels = sanitizeChannels(b.channels)

    if (title.length < 3 || title.length > 140) throw Errors.VALIDATION_ERROR('Title must be 3–140 characters')
    if (body.length < 3 || body.length > 2000)  throw Errors.VALIDATION_ERROR('Body must be 3–2000 characters')
    if (channels.length === 0) throw Errors.VALIDATION_ERROR('Select at least one channel')

    // linkUrl: allow an internal path (/...) or an absolute http(s) URL.
    let linkUrl: string | undefined
    if (linkUrlRaw) {
      const ok = linkUrlRaw.startsWith('/') ? !linkUrlRaw.startsWith('//') : /^https?:\/\/.+/i.test(linkUrlRaw)
      if (!ok) throw Errors.VALIDATION_ERROR('Link must be an internal path (/…) or an http(s) URL')
      linkUrl = linkUrlRaw
    }

    // Anti-spam cooldown — only gates the Telegram channel (the DM/ban-risk one).
    if (channels.includes('telegram')) {
      const ttl = await redis.ttl(TG_BROADCAST_COOLDOWN_KEY).catch(() => -2)
      if (ttl > 0) {
        throw Errors.VALIDATION_ERROR(
          `A Telegram broadcast was sent recently. To protect the bot from spam flags, ` +
          `please wait ${humanizeSeconds(ttl)} before the next one — or send this via Website/Bell only.`,
        )
      }
    }

    const announcement = await createAnnouncement({
      title, body, channels, adminId: req.user!.id,
      ...(linkUrl ? { linkUrl } : {}),
    })

    // Fan-out (bell + Telegram) runs in the background; web banner is live.
    if (channels.includes('bell') || channels.includes('telegram')) {
      await queues.announcementBroadcast
        .add('broadcast', { announcementId: announcement.id })
        .catch(() => { /* logged by queue; banner still works */ })
    }

    // Arm the Telegram cooldown only after a telegram broadcast is enqueued.
    if (channels.includes('telegram')) {
      await redis.set(TG_BROADCAST_COOLDOWN_KEY, '1', 'EX', TG_BROADCAST_COOLDOWN_S).catch(() => {})
    }

    return reply.code(201).send({ success: true, data: announcement })
  })

  // PATCH /admin/announcements/:id/deactivate — retire the website banner
  app.patch('/admin/announcements/:id/deactivate', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    await db.announcement.update({ where: { id }, data: { isActive: false } }).catch(() => {
      throw Errors.NOT_FOUND('Announcement')
    })
    return reply.send({ success: true })
  })

  // ── USER ──────────────────────────────────────────────────────────────────

  // GET /announcements/active — banners for the signed-in user
  app.get('/announcements/active', { preHandler: [authenticate] }, async (req, reply) => {
    const banners = await getActiveBanners(req.user!.id)
    return reply.send({ success: true, data: { banners } })
  })

  // POST /announcements/:id/dismiss — hide a banner for this user
  app.post('/announcements/:id/dismiss', { preHandler: [authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    await dismissBanner(req.user!.id, id)
    return reply.send({ success: true })
  })

  // GET /me/notification-preferences — current toggles
  app.get('/me/notification-preferences', { preHandler: [authenticate] }, async (req, reply) => {
    const user = await db.user.findUnique({
      where: { id: req.user!.id },
      select: { announcementsEnabled: true, marketingEmailsEnabled: true },
    })
    if (!user) throw Errors.NOT_FOUND('User')
    return reply.send({ success: true, data: user })
  })

  // PATCH /me/notification-preferences — update the announcements opt-out
  app.patch('/me/notification-preferences', { preHandler: [authenticate] }, async (req, reply) => {
    const b = req.body as { announcementsEnabled?: unknown }
    const data: { announcementsEnabled?: boolean } = {}
    if (typeof b.announcementsEnabled === 'boolean') data.announcementsEnabled = b.announcementsEnabled
    if (Object.keys(data).length === 0) throw Errors.VALIDATION_ERROR('No valid preference provided')

    const updated = await db.user.update({
      where: { id: req.user!.id },
      data,
      select: { announcementsEnabled: true },
    })
    return reply.send({ success: true, data: updated })
  })
}
