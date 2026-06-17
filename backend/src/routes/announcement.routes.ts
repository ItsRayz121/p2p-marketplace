import type { FastifyInstance } from 'fastify'
import { authenticate, requireRole } from '../middleware/auth.middleware'
import { db } from '../lib/prisma'
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
