import type { FastifyInstance } from 'fastify'
import { authenticate, requireRole } from '../middleware/auth.middleware'
import { db } from '../lib/prisma'
import { MANUAL_PROOF_WHERE, REJECTABLE_STATUS } from '../lib/gas/gas.orderStates'
import { AdminNotifCategory } from '@prisma/client'
import { z } from 'zod'
import { AppError } from '../lib/errors'
import { GROUP_META, NOTIF_GROUPS, type NotifGroup } from '../lib/adminNotifGroups'
import { getAdminPrefs, resetAdminPrefs, saveAdminPrefs, visibleNotifFilter } from '../services/adminNotificationPrefs.service'
import { sendPushToUser } from '../lib/push.service'
import { sendTelegramAdminAlert } from '../lib/telegram.notify'

const adminOrSuper = requireRole('admin', 'super_admin')
const VALID_CATEGORIES = new Set(Object.values(AdminNotifCategory))

const GROUP_SET = new Set<string>(NOTIF_GROUPS)
function parseGroup(raw: string | undefined): NotifGroup | undefined {
  return raw && GROUP_SET.has(raw) ? (raw as NotifGroup) : undefined
}

function parseCategory(raw: string | undefined): AdminNotifCategory | undefined {
  if (raw && VALID_CATEGORIES.has(raw as AdminNotifCategory)) return raw as AdminNotifCategory
  return undefined
}

export async function adminNotificationRoutes(app: FastifyInstance) {
  // GET /admin/notifications
  app.get('/admin/notifications', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const q = req.query as Record<string, string>
    const page     = Math.max(1, parseInt(q.page ?? '1', 10))
    const limit    = Math.min(parseInt(q.limit ?? '20', 10), 100)
    const skip     = (page - 1) * limit
    const unread   = q.unreadOnly === 'true'
    const category = parseCategory(q.category)
    const group    = parseGroup(q.group)
    // Records are shared; what THIS admin sees is filtered by THEIR own preferences.
    const visible  = await visibleNotifFilter(req.user!.id)

    const where = {
      ...visible,
      ...(unread    ? { isRead: false } : {}),
      ...(category  ? { category }      : {}),
      ...(group     ? { prefGroup: group } : {}),
    }

    const [notifications, total, unreadCount] = await Promise.all([
      db.adminNotification.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
      db.adminNotification.count({ where }),
      db.adminNotification.count({ where: { ...visible, isRead: false } }),
    ])

    return reply.send({
      success: true,
      data: {
        notifications,
        unreadCount,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      },
    })
  })

  // GET /admin/notifications/unread-count — bell badge
  app.get('/admin/notifications/unread-count', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const q        = req.query as Record<string, string>
    const category = parseCategory(q.category)
    const visible  = await visibleNotifFilter(req.user!.id)
    const count    = await db.adminNotification.count({
      where: { ...visible, isRead: false, ...(category ? { category } : {}), ...(parseGroup(q.group) ? { prefGroup: parseGroup(q.group)! } : {}) },
    })
    return reply.send({ success: true, data: { count } })
  })

  // GET /admin/nav-counts — live pending counts for sidebar queue badges.
  // kyc_reviewer is allowed so the KYC Queue badge shows for that role too.
  app.get(
    '/admin/nav-counts',
    { preHandler: [authenticate, requireRole('admin', 'super_admin', 'kyc_reviewer')] },
    async (_req, reply) => {
      const [kyc, appeals, disputes, ctmDisputes, withdrawals, gasRequests, makers, adReview, paymentProofs] = await Promise.all([
        db.kycSubmission.count({ where: { status: 'pending' } }),
        db.appeal.count({ where: { status: { in: ['pending', 'more_info_requested'] } } }),
        db.dispute.count({ where: { status: { in: ['open', 'escalated'] } } }),
        db.ctmDispute.count({ where: { status: { in: ['open', 'escalated'] } } }),
        db.withdrawal.count({ where: { status: { in: ['pending', 'first_approved'] } } }),
        db.gasCustomRequest.count({ where: { status: 'pending' } }),
        db.user.count({ where: { makerStatus: 'pending' } }),
        Promise.all([
          db.ad.count({ where: { status: 'pending_review' } }),
          db.ctmListing.count({ where: { status: 'pending_review' } }),
        ]).then(([a, l]) => a + l),
        db.gasFeeOrder.count({ where: { status: REJECTABLE_STATUS, ...MANUAL_PROOF_WHERE } }),
      ])
      return reply.send({
        success: true,
        data: { kyc, appeals, disputes, ctmDisputes, withdrawals, gasRequests, makers, adReview, paymentProofs },
      })
    },
  )

  // PATCH /admin/notifications/:id/read
  app.patch('/admin/notifications/:id/read', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    await db.adminNotification.update({ where: { id }, data: { isRead: true } })
    return reply.send({ success: true })
  })

  // PATCH /admin/notifications/read-all?category=
  app.patch('/admin/notifications/read-all', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const q        = req.query as Record<string, string>
    const category = parseCategory(q.category)
    // Only what this admin can see: marking "all" read must not silently clear groups they muted
    // (those stay unread for the other admins who still receive them).
    const visible  = await visibleNotifFilter(req.user!.id)
    await db.adminNotification.updateMany({
      where: { ...visible, isRead: false, ...(category ? { category } : {}), ...(parseGroup(q.group) ? { prefGroup: parseGroup(q.group)! } : {}) },
      data:  { isRead: true },
    })
    return reply.send({ success: true })
  })

  // DELETE /admin/notifications/old — prune notifications older than 30 days
  app.delete('/admin/notifications/old', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const { count } = await db.adminNotification.deleteMany({
      where: { createdAt: { lt: cutoff }, isRead: true },
    })
    return reply.send({ success: true, data: { deleted: count } })
  })

  // ── Personal preferences ────────────────────────────────────────────────────
  // Always scoped to the authenticated admin — there is no way to address another admin here.

  const channelSchema = z.object({
    inApp: z.boolean().optional(),
    push: z.boolean().optional(),
    telegram: z.boolean().optional(),
    sound: z.boolean().optional(),
  }).strict()
  const patchSchema = z.object({ groups: z.record(z.enum(NOTIF_GROUPS), channelSchema) }).strict()

  // GET /admin/notification-preferences
  app.get('/admin/notification-preferences', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    return reply.send({
      success: true,
      data: {
        prefs: await getAdminPrefs(req.user!.id),
        groups: NOTIF_GROUPS.map((g) => GROUP_META[g]),
        // Facts the UI explains to the admin, so the copy can't drift from the behaviour.
        rules: {
          mandatory: NOTIF_GROUPS.filter((g) => GROUP_META[g].mandatoryInApp),
          emailIsSharedInbox: true,
          externalDedupeSeconds: 90,
        },
      },
    })
  })

  // PUT /admin/notification-preferences — partial update (only the groups/channels sent)
  app.put('/admin/notification-preferences', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const parsed = patchSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid preferences', 400)
    return reply.send({ success: true, data: { prefs: await saveAdminPrefs(req.user!.id, parsed.data.groups) } })
  })

  // DELETE /admin/notification-preferences — back to the defaults
  app.delete('/admin/notification-preferences', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    return reply.send({ success: true, data: { prefs: await resetAdminPrefs(req.user!.id) } })
  })

  // POST /admin/notification-preferences/preview — sends a TEST to the calling admin only, over the channels
  // they currently have on for that group. Writes no shared notification, so no other admin ever sees it.
  app.post('/admin/notification-preferences/preview', { preHandler: [authenticate, adminOrSuper], config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = z.object({ group: z.enum(NOTIF_GROUPS) }).safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Unknown group', 400)
    const group = parsed.data.group
    const meta = GROUP_META[group]
    const prefs = (await getAdminPrefs(req.user!.id))[group]
    const title = `Preview: ${meta.label}`
    const body = 'This is a test. Real alerts in this group will reach you like this.'
    const sent = { push: false, telegram: false }
    if (prefs.push) { await sendPushToUser(req.user!.id, { title, body, url: '/admin/notifications' }); sent.push = true }
    if (prefs.telegram) {
      const me = await db.user.findUnique({ where: { id: req.user!.id }, select: { telegramId: true, telegramBlockedAt: true } })
      if (me?.telegramId && !me.telegramBlockedAt) {
        const r = await sendTelegramAdminAlert(me.telegramId, title, body, '/admin/notifications').catch(() => null)
        sent.telegram = !!r && !r.blocked
      }
    }
    return reply.send({ success: true, data: { group, title, body, channels: prefs, sent } })
  })
}
