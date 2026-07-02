import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate, optionalAuth, requireRole } from '../middleware/auth.middleware'
import { db } from '../lib/prisma'
import { AppError, Errors } from '../lib/errors'
import { isFlagEnabled, FLAGS } from '../services/platformFlags.service'
import { createAdminNotif } from '../services/adminNotification.service'

// ─────────────────────────────────────────────────────────────────────────────
// Community / influencer giveaways: task-gated address collection. NO platform
// funds ever move here — the creator distributes the reward and exports entrant
// addresses as CSV. Platform-funded draws remain the exclusive, admin-only
// GasGiveawayCampaign (see gasFee.routes.ts).
// ─────────────────────────────────────────────────────────────────────────────

const STAFF = new Set(['admin', 'super_admin'])

const taskSchema = z.object({
  id: z.string().min(1).max(40),
  label: z.string().trim().min(1).max(120),
  url: z.string().trim().url().max(500).optional().or(z.literal('')),
  required: z.boolean().default(true),
})

const createSchema = z.object({
  title: z.string().trim().min(2).max(120),
  description: z.string().trim().max(2000).optional(),
  thumbnailUrl: z.string().trim().url().max(500).optional().or(z.literal('')),
  tasks: z.array(taskSchema).max(12).default([]),
  addressLabel: z.string().trim().max(120).optional(),
  winnerCount: z.number().int().min(0).max(100000).default(0),
  rewardAll: z.boolean().default(false),
  requireKyc: z.boolean().default(false),
  // Off-platform reward metadata (display-only).
  rewardAmount: z.string().trim().max(40).optional(),
  rewardToken: z.string().trim().max(40).optional(),
  rewardChain: z.string().trim().max(60).optional(),
  // Optional entrant-collection toggles.
  collectName: z.boolean().default(false),
  collectWhatsapp: z.boolean().default(false),
  entryDeadline: z.string().datetime().optional(),
  code: z.string().trim().min(3).max(24).regex(/^[A-Za-z0-9_-]+$/, 'Code may only contain letters, numbers, - and _').optional(),
})

const enterSchema = z.object({
  receivingAddress: z.string().trim().min(4).max(200),
  email: z.string().email().optional(),
  entrantName: z.string().trim().max(80).optional(),
  whatsapp: z.string().trim().max(40).optional(),
  ackTasks: z.array(z.string().min(1).max(40)).max(24).default([]),
})

interface PromoTask { id: string; label: string; url?: string; required: boolean }

function parseTasks(raw: unknown): PromoTask[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((t): t is PromoTask => !!t && typeof (t as PromoTask).id === 'string')
}

// A short, unambiguous code (no easily-confused chars) — retried on collision.
function randomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let out = ''
  for (let i = 0; i < 7; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)]
  return out
}

async function uniqueCode(preferred?: string): Promise<string> {
  if (preferred) {
    const code = preferred.toUpperCase()
    const existing = await db.promoGiveaway.findUnique({ where: { code } })
    if (existing) throw new AppError('CONFLICT', `Code '${code}' is already taken`, 409)
    return code
  }
  for (let i = 0; i < 6; i++) {
    const code = randomCode()
    const existing = await db.promoGiveaway.findUnique({ where: { code } })
    if (!existing) return code
  }
  throw new AppError('SERVER_ERROR', 'Could not allocate a giveaway code, please retry', 500)
}

// Creation is limited to staff + APPROVED affiliates (the reward is off-platform,
// but we still don't want any random user harvesting wallet addresses at scale).
async function assertCanCreate(userId: string, role: string): Promise<'admin' | 'super_admin' | 'affiliate'> {
  if (role === 'super_admin') return 'super_admin'
  if (role === 'admin') return 'admin'
  const affiliate = await db.gasAffiliate.findUnique({ where: { userId }, select: { status: true } })
  if (affiliate?.status === 'approved') return 'affiliate'
  throw new AppError('FORBIDDEN', 'Only approved affiliates can create giveaways. Apply on the Referral page.', 403)
}

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

// Fulfillment statuses the creator can set on an entry.
const ENTRY_STATUSES = ['entered', 'pending', 'sent', 'rejected'] as const

// Mask a wallet address for the PUBLIC winners list — proves a real payout target
// without exposing everyone's full address (e.g. 0x1234…ab9c).
function maskAddress(a: string): string {
  if (!a) return ''
  if (a.length <= 12) return a
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

export async function promoGiveawayRoutes(app: FastifyInstance) {
  // ─── CREATOR ENDPOINTS (affiliate / admin) ───────────────────────────────

  // POST /promo-giveaways — create a giveaway
  app.post('/promo-giveaways', { preHandler: [authenticate] }, async (req, reply) => {
    if (!(await isFlagEnabled(FLAGS.PROMO_GIVEAWAY))) {
      throw new AppError('GIVEAWAY_DISABLED', 'Giveaways are not available right now.', 400)
    }
    const roleSnapshot = await assertCanCreate(req.user!.id, req.user!.role)
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    const p = parsed.data

    if (!p.rewardAll && p.winnerCount < 1) {
      throw new AppError('VALIDATION_ERROR', 'Set a winner count or choose "everyone who enters wins".', 400)
    }
    if (p.entryDeadline && new Date(p.entryDeadline).getTime() < Date.now()) {
      throw new AppError('VALIDATION_ERROR', 'The entry deadline must be in the future.', 400)
    }

    const code = await uniqueCode(p.code)
    const creator = await db.user.findUnique({
      where: { id: req.user!.id },
      select: { fullName: true, username: true, email: true },
    })
    const createdByName = creator?.fullName?.trim() || creator?.username?.trim() || creator?.email?.split('@')[0] || null

    const created = await db.promoGiveaway.create({
      data: {
        code,
        title: p.title,
        description: p.description ?? null,
        thumbnailUrl: p.thumbnailUrl || null,
        tasks: p.tasks as object[],
        addressLabel: p.addressLabel ?? null,
        winnerCount: p.rewardAll ? 0 : p.winnerCount,
        rewardAll: p.rewardAll,
        requireKyc: p.requireKyc,
        rewardAmount: p.rewardAmount || null,
        rewardToken: p.rewardToken || null,
        rewardChain: p.rewardChain || null,
        collectName: p.collectName,
        collectWhatsapp: p.collectWhatsapp,
        createdById: req.user!.id,
        createdByRole: roleSnapshot,
        createdByName,
        ...(p.entryDeadline ? { entryDeadline: new Date(p.entryDeadline) } : {}),
      },
    })

    // Admin oversight: every giveaway (incl. affiliate-created) is surfaced so an
    // admin can review it and kill it if it looks wrong.
    void createAdminNotif({
      category: 'SYSTEM',
      title: 'New giveaway created',
      body: `${createdByName ?? 'A creator'} launched "${created.title}" (code ${created.code})`,
      href: '/admin/promo-giveaways',
      metadata: { giveawayId: created.id, code: created.code, createdById: req.user!.id },
    })

    return reply.code(201).send({ success: true, data: created })
  })

  // GET /promo-giveaways/mine — the caller's own giveaways
  app.get('/promo-giveaways/mine', { preHandler: [authenticate] }, async (req, reply) => {
    const rows = await db.promoGiveaway.findMany({
      where: { createdById: req.user!.id },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { entries: true } } },
    })
    return reply.send({ success: true, data: rows.map(serializeOwner) })
  })

  // GET /promo-giveaways/:id/entries — entrant list (owner or admin)
  app.get('/promo-giveaways/:id/entries', { preHandler: [authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const g = await requireOwnedOrAdmin(id, req.user!.id, req.user!.role)
    const entries = await db.promoGiveawayEntry.findMany({
      where: { giveawayId: g.id },
      orderBy: { createdAt: 'desc' },
      take: 2000,
    })
    return reply.send({
      success: true,
      data: entries.map((e) => ({
        id: e.id,
        username: e.username,
        email: e.email,
        entrantName: e.entrantName,
        whatsapp: e.whatsapp,
        receivingAddress: e.receivingAddress,
        status: e.status,
        note: e.note,
        createdAt: e.createdAt,
      })),
    })
  })

  // GET /promo-giveaways/:id/export — CSV of entrant addresses (owner or admin)
  app.get('/promo-giveaways/:id/export', { preHandler: [authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const g = await requireOwnedOrAdmin(id, req.user!.id, req.user!.role)
    const entries = await db.promoGiveawayEntry.findMany({ where: { giveawayId: g.id }, orderBy: { createdAt: 'asc' } })
    const header = ['Username', 'Name', 'WhatsApp', 'Email', 'Address', 'Status', 'Entered At']
    const lines = [header.join(',')]
    for (const e of entries) {
      lines.push([
        csvCell(e.username),
        csvCell(e.entrantName),
        csvCell(e.whatsapp),
        csvCell(e.email),
        csvCell(e.receivingAddress),
        csvCell(e.status),
        csvCell(e.createdAt.toISOString()),
      ].join(','))
    }
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="giveaway-${g.code}-entries.csv"`)
      .send(lines.join('\n'))
  })

  // POST /promo-giveaways/:id/close — stop accepting entries (owner or admin)
  app.post('/promo-giveaways/:id/close', { preHandler: [authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const g = await requireOwnedOrAdmin(id, req.user!.id, req.user!.role)
    await db.promoGiveaway.update({ where: { id: g.id }, data: { status: 'closed' } })
    return reply.send({ success: true })
  })

  // PATCH /promo-giveaways/:id/results — set/clear the public proof sheet (owner/admin)
  app.patch('/promo-giveaways/:id/results', { preHandler: [authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const g = await requireOwnedOrAdmin(id, req.user!.id, req.user!.role)
    const body = z.object({ resultsSheetUrl: z.string().trim().url().max(500).nullable() }).safeParse(req.body)
    if (!body.success) throw new AppError('VALIDATION_ERROR', 'A valid image URL is required', 400)
    await db.promoGiveaway.update({ where: { id: g.id }, data: { resultsSheetUrl: body.data.resultsSheetUrl } })
    return reply.send({ success: true })
  })

  // PATCH /promo-giveaways/:id/entries/:entryId — set fulfillment status (owner/admin).
  // "rejected" requires a justification note.
  app.patch('/promo-giveaways/:id/entries/:entryId', { preHandler: [authenticate] }, async (req, reply) => {
    const { id, entryId } = req.params as { id: string; entryId: string }
    const g = await requireOwnedOrAdmin(id, req.user!.id, req.user!.role)
    const body = z
      .object({ status: z.enum(ENTRY_STATUSES), note: z.string().trim().max(300).optional() })
      .safeParse(req.body)
    if (!body.success) throw new AppError('VALIDATION_ERROR', body.error.errors[0]?.message ?? 'Invalid input', 400)
    if (body.data.status === 'rejected' && !body.data.note?.trim()) {
      throw new AppError('VALIDATION_ERROR', 'Please add a reason when rejecting an entry.', 400)
    }
    const entry = await db.promoGiveawayEntry.findUnique({ where: { id: entryId } })
    if (!entry || entry.giveawayId !== g.id) throw Errors.NOT_FOUND('Entry')
    await db.promoGiveawayEntry.update({
      where: { id: entryId },
      // Clear the note unless we're rejecting, so a stale reason doesn't linger.
      data: { status: body.data.status, note: body.data.status === 'rejected' ? body.data.note!.trim() : null },
    })
    return reply.send({ success: true })
  })

  // ─── PUBLIC ENDPOINTS ────────────────────────────────────────────────────

  // GET /promo-giveaways/public/:code — entry page info
  app.get('/promo-giveaways/public/:code', { preHandler: [optionalAuth] }, async (req, reply) => {
    if (!(await isFlagEnabled(FLAGS.PROMO_GIVEAWAY))) throw new AppError('GIVEAWAY_DISABLED', 'Giveaways are not available right now.', 400)
    const { code } = req.params as { code: string }
    const g = await db.promoGiveaway.findUnique({ where: { code: code.trim().toUpperCase() } })
    if (!g || !g.isActive) throw Errors.NOT_FOUND('Giveaway')

    const entryCount = await db.promoGiveawayEntry.count({ where: { giveawayId: g.id } })
    const myEntry = req.user
      ? await db.promoGiveawayEntry.findUnique({ where: { giveawayId_userId: { giveawayId: g.id, userId: req.user.id } } })
      : null
    const open = g.status === 'open' && (!g.entryDeadline || g.entryDeadline.getTime() > Date.now())

    // Public winners list (transparency): entries the creator marked "sent",
    // with masked addresses so full wallets aren't published.
    const sent = await db.promoGiveawayEntry.findMany({
      where: { giveawayId: g.id, status: 'sent' },
      orderBy: { createdAt: 'asc' },
      take: 500,
      select: { username: true, receivingAddress: true },
    })
    const winners = sent.map((w) => ({ username: w.username, address: maskAddress(w.receivingAddress) }))

    return reply.send({
      success: true,
      data: {
        code: g.code,
        title: g.title,
        description: g.description,
        thumbnailUrl: g.thumbnailUrl,
        resultsSheetUrl: g.resultsSheetUrl,
        tasks: parseTasks(g.tasks),
        addressLabel: g.addressLabel,
        rewardAll: g.rewardAll,
        winnerCount: g.winnerCount,
        requireKyc: g.requireKyc,
        rewardAmount: g.rewardAmount,
        rewardToken: g.rewardToken,
        rewardChain: g.rewardChain,
        collectName: g.collectName,
        collectWhatsapp: g.collectWhatsapp,
        entryDeadline: g.entryDeadline?.toISOString() ?? null,
        status: g.status,
        open,
        entryCount,
        alreadyEntered: !!myEntry,
        myStatus: myEntry?.status ?? null,
        myNote: myEntry?.note ?? null,
        myAddress: myEntry?.receivingAddress ?? null,
        winners,
        createdByName: g.createdByName,
      },
    })
  })

  // GET /promo-giveaways/public/:code/participants — public entrant list (masked)
  app.get('/promo-giveaways/public/:code/participants', { preHandler: [optionalAuth] }, async (req, reply) => {
    if (!(await isFlagEnabled(FLAGS.PROMO_GIVEAWAY))) throw new AppError('GIVEAWAY_DISABLED', 'Giveaways are not available right now.', 400)
    const { code } = req.params as { code: string }
    const g = await db.promoGiveaway.findUnique({ where: { code: code.trim().toUpperCase() }, select: { id: true, isActive: true } })
    if (!g || !g.isActive) throw Errors.NOT_FOUND('Giveaway')
    const rows = await db.promoGiveawayEntry.findMany({
      where: { giveawayId: g.id },
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: { username: true, receivingAddress: true, status: true, createdAt: true },
    })
    return reply.send({
      success: true,
      data: rows.map((r) => ({
        username: r.username || 'Anonymous',
        address: maskAddress(r.receivingAddress),
        status: r.status,
        enteredAt: r.createdAt.toISOString(),
      })),
    })
  })

  // POST /promo-giveaways/public/:code/enter — submit an entry (login required)
  app.post(
    '/promo-giveaways/public/:code/enter',
    { preHandler: [authenticate], config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (!(await isFlagEnabled(FLAGS.PROMO_GIVEAWAY))) throw new AppError('GIVEAWAY_DISABLED', 'Giveaways are not available right now.', 400)
      const { code } = req.params as { code: string }
      const parsed = enterSchema.safeParse(req.body)
      if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
      const { receivingAddress, email, entrantName, whatsapp, ackTasks } = parsed.data

      const g = await db.promoGiveaway.findUnique({ where: { code: code.trim().toUpperCase() } })
      if (!g || !g.isActive) throw new AppError('GIVEAWAY_INVALID', 'This giveaway is not available.', 400)
      if (g.status !== 'open') throw new AppError('GIVEAWAY_CLOSED', 'This giveaway is no longer accepting entries.', 400)
      if (g.entryDeadline && g.entryDeadline.getTime() < Date.now()) throw new AppError('GIVEAWAY_CLOSED', 'This giveaway has closed.', 400)

      // Enforce the required-when-enabled entrant fields only on the FIRST entry.
      // A returning entrant updating their address keeps the name/WhatsApp they
      // already gave (the form doesn't re-show those fields), so re-requiring them
      // would wrongly block the address update.
      const existingEntry = await db.promoGiveawayEntry.findUnique({
        where: { giveawayId_userId: { giveawayId: g.id, userId: req.user!.id } },
        select: { id: true },
      })
      if (!existingEntry) {
        if (g.collectName && !entrantName?.trim()) throw new AppError('NAME_REQUIRED', 'Please enter your name to join this giveaway.', 400)
        if (g.collectWhatsapp && !whatsapp?.trim()) throw new AppError('WHATSAPP_REQUIRED', 'Please enter your WhatsApp number to join this giveaway.', 400)
      }

      // All REQUIRED tasks must be confirmed (self-attested).
      const required = parseTasks(g.tasks).filter((t) => t.required).map((t) => t.id)
      const acked = new Set(ackTasks)
      if (required.some((id) => !acked.has(id))) {
        throw new AppError('TASKS_INCOMPLETE', 'Please complete all required tasks before entering.', 400)
      }

      const u = await db.user.findUnique({ where: { id: req.user!.id }, select: { kycLevel: true, email: true, username: true } })
      if (!u || !u.username || !u.username.trim()) {
        throw new AppError('USERNAME_REQUIRED', 'Set a platform username to enter this giveaway.', 403)
      }
      if (g.requireKyc && u.kycLevel === 'none') {
        throw new AppError('KYC_REQUIRED', 'Complete identity verification (KYC) to enter this giveaway.', 403)
      }
      const contactEmail = email ?? u.email ?? null

      await db.promoGiveawayEntry.upsert({
        where: { giveawayId_userId: { giveawayId: g.id, userId: req.user!.id } },
        create: {
          giveawayId: g.id,
          userId: req.user!.id,
          username: u.username,
          receivingAddress,
          ackTasks: ackTasks as unknown as object[],
          ...(contactEmail ? { email: contactEmail } : {}),
          ...(entrantName?.trim() ? { entrantName: entrantName.trim() } : {}),
          ...(whatsapp?.trim() ? { whatsapp: whatsapp.trim() } : {}),
        },
        update: {
          receivingAddress,
          ackTasks: ackTasks as unknown as object[],
          ...(contactEmail ? { email: contactEmail } : {}),
          ...(entrantName?.trim() ? { entrantName: entrantName.trim() } : {}),
          ...(whatsapp?.trim() ? { whatsapp: whatsapp.trim() } : {}),
        },
      })
      return reply.send({ success: true, data: { entered: true } })
    },
  )

  // ─── ADMIN OVERSIGHT ─────────────────────────────────────────────────────

  // GET /admin/promo-giveaways — every giveaway with creator + counts
  app.get('/admin/promo-giveaways', { preHandler: [authenticate, requireRole('admin', 'super_admin')] }, async (_req, reply) => {
    const rows = await db.promoGiveaway.findMany({
      orderBy: { createdAt: 'desc' },
      take: 500,
      include: { _count: { select: { entries: true } } },
    })
    return reply.send({
      success: true,
      data: rows.map((g) => ({ ...serializeOwner(g), createdByName: g.createdByName, createdByRole: g.createdByRole, createdById: g.createdById })),
    })
  })

  // PATCH /admin/promo-giveaways/:id — kill switch / reactivate
  app.patch('/admin/promo-giveaways/:id', { preHandler: [authenticate, requireRole('admin', 'super_admin')] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = z.object({ isActive: z.boolean() }).safeParse(req.body)
    if (!body.success) throw new AppError('VALIDATION_ERROR', 'isActive is required', 400)
    const g = await db.promoGiveaway.findUnique({ where: { id } })
    if (!g) throw Errors.NOT_FOUND('Giveaway')
    await db.promoGiveaway.update({ where: { id }, data: { isActive: body.data.isActive } })
    await db.auditLog.create({
      data: {
        actorId: req.user!.id,
        action: body.data.isActive ? 'PROMO_GIVEAWAY_ENABLE' : 'PROMO_GIVEAWAY_DISABLE',
        targetType: 'PromoGiveaway',
        targetId: id,
        metadata: { code: g.code } as never,
        ipAddress: req.ip ?? null,
        userAgent: (req.headers['user-agent'] as string | undefined)?.slice(0, 500) ?? null,
      },
    })
    return reply.send({ success: true })
  })

  // ── helpers bound to the app scope ──
  async function requireOwnedOrAdmin(id: string, userId: string, role: string) {
    const g = await db.promoGiveaway.findUnique({ where: { id } })
    if (!g) throw Errors.NOT_FOUND('Giveaway')
    if (g.createdById !== userId && !STAFF.has(role)) throw Errors.FORBIDDEN()
    return g
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serializeOwner(g: any) {
  return {
    id: g.id,
    code: g.code,
    title: g.title,
    description: g.description,
    thumbnailUrl: g.thumbnailUrl,
    resultsSheetUrl: g.resultsSheetUrl,
    tasks: parseTasks(g.tasks),
    addressLabel: g.addressLabel,
    winnerCount: g.winnerCount,
    rewardAll: g.rewardAll,
    requireKyc: g.requireKyc,
    rewardAmount: g.rewardAmount ?? null,
    rewardToken: g.rewardToken ?? null,
    rewardChain: g.rewardChain ?? null,
    collectName: g.collectName ?? false,
    collectWhatsapp: g.collectWhatsapp ?? false,
    entryDeadline: g.entryDeadline ? new Date(g.entryDeadline).toISOString() : null,
    status: g.status,
    isActive: g.isActive,
    entryCount: g._count?.entries ?? 0,
    createdAt: g.createdAt,
  }
}
