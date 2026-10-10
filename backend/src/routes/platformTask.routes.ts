import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate, requireRole } from '../middleware/auth.middleware'
import { recordAuditLog } from '../lib/audit'
import { AppError } from '../lib/errors'
import {
  VERIFY_MODES,
  REWARD_TYPES,
  PAYOUT_MODES,
  createTask,
  updateTask,
  adminListTasks,
  listTasksForUser,
  claimTask,
  resubmitClaim,
  decideSubmission,
  cancelPayout,
  markCompletionPaid,
  type TaskInput,
  type TaskPatch,
} from '../services/platformTask.service'
import { PLATFORMS } from '../services/platformTask.rules'
import {
  getActivity,
  getAnalytics,
  getInbox,
  getRewards,
  getSubmissionDetail,
  getSummary,
  parsePeriod,
} from '../services/platformTaskWorkspace.service'

const optDate = z.preprocess((v) => (v === '' || v == null ? null : v), z.coerce.date().nullable()).optional()
const optPosInt = z.preprocess((v) => (v === '' || v == null ? null : v), z.number().int().positive().nullable()).optional()
const optPosNum = z.preprocess((v) => (v === '' || v == null ? null : v), z.number().positive().nullable()).optional()
const optText = (max: number) => z.string().trim().max(max).nullable().optional()
const platformEnum = z.enum(PLATFORMS).nullable().optional()

const createSchema = z.object({
  title: z.string().trim().min(3).max(120),
  description: optText(500),
  url: z.string().trim().url().max(300).nullable().optional(),
  logoUrl: z.string().trim().url().max(500).nullable().optional(),
  telegramChat: z.string().trim().max(64).nullable().optional(),
  verifyMode: z.enum(VERIFY_MODES),
  rewardType: z.enum(REWARD_TYPES),
  rewardPoints: optPosNum,
  rewardUsdt: optPosNum,
  payoutMode: z.enum(PAYOUT_MODES).optional(),
  requireKyc: z.boolean().optional(),
  startsAt: optDate,
  endsAt: optDate,
  maxClaims: optPosInt,
  budgetUsdt: optPosNum,
  isActive: z.boolean().optional(),
  isDraft: z.boolean().optional(),
  platform: platformEnum,
  instructions: optText(2000),
  proofRequirements: optText(1000),
  proofFileRequired: z.boolean().optional(),
})

const updateSchema = z.object({
  title: z.string().trim().min(3).max(120).optional(),
  description: optText(500),
  url: z.string().trim().url().max(300).nullable().optional(),
  logoUrl: z.string().trim().url().max(500).nullable().optional(),
  isActive: z.boolean().optional(),
  isDraft: z.boolean().optional(),
  archived: z.boolean().optional(),
  requireKyc: z.boolean().optional(),
  startsAt: optDate,
  endsAt: optDate,
  maxClaims: optPosInt,
  budgetUsdt: optPosNum,
  platform: platformEnum,
  instructions: optText(2000),
  proofRequirements: optText(1000),
  proofFileRequired: z.boolean().optional(),
})

const evidenceSchema = z.object({
  proof: z.string().max(500).optional(),
  links: z.array(z.string().max(300)).max(5).optional(),
  attachments: z.array(z.object({ url: z.string().max(600), name: z.string().max(120), size: z.number(), mime: z.string().max(60) })).max(6).optional(),
})

const claimSchema = evidenceSchema.extend({
  payoutNetwork: z.string().max(10).optional(),
  payoutAddress: z.string().max(100).optional(),
})

// Zod's optional-with-exactOptionalPropertyTypes friendly strip of undefined keys.
function clean<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}

const pageNum = (v: unknown, fb: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : fb }

export async function platformTaskRoutes(app: FastifyInstance) {
  // Money-moving + config surface: super_admin only (same as airdrop admin).
  const superAdmin = requireRole('super_admin')

  // ─── USER ────────────────────────────────────────────────────────────────
  app.get('/platform-tasks', { preHandler: [authenticate] }, async (req, reply) => {
    return reply.send({ success: true, data: await listTasksForUser(req.user!.id) })
  })

  app.post('/platform-tasks/:id/claim', { preHandler: [authenticate], config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = claimSchema.safeParse(req.body ?? {})
    if (!body.success) throw new AppError('VALIDATION_ERROR', 'Invalid input', 400)
    const data = await claimTask(req.user!.id, id, clean(body.data))
    return reply.send({ success: true, data })
  })

  // The member corrects a claim that needs changes (a new revision of the SAME claim).
  app.post('/platform-tasks/:id/resubmit', { preHandler: [authenticate], config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = evidenceSchema.safeParse(req.body ?? {})
    if (!body.success) throw new AppError('VALIDATION_ERROR', 'Invalid input', 400)
    const data = await resubmitClaim(req.user!.id, id, clean(body.data))
    return reply.send({ success: true, data })
  })

  // ─── ADMIN: tasks ────────────────────────────────────────────────────────
  app.get('/admin/platform-tasks', { preHandler: [authenticate, superAdmin] }, async (_req, reply) => {
    return reply.send({ success: true, data: await adminListTasks() })
  })

  app.post('/admin/platform-tasks', { preHandler: [authenticate, superAdmin] }, async (req, reply) => {
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid task', 400)
    const task = await createTask(req.user!.id, clean(parsed.data) as unknown as TaskInput)
    await recordAuditLog(req.user!.id, 'PLATFORM_TASK_CREATE', 'PlatformTask', task.id, {
      title: task.title, rewardType: task.rewardType, rewardPoints: task.rewardPoints?.toString(), rewardUsdt: task.rewardUsdt?.toString(),
      payoutMode: task.payoutMode, verifyMode: task.verifyMode, budgetUsdt: task.budgetUsdt?.toString(), maxClaims: task.maxClaims, draft: task.isDraft,
    })
    return reply.code(201).send({ success: true, data: { id: task.id } })
  })

  app.patch('/admin/platform-tasks/:id', { preHandler: [authenticate, superAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = updateSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid update', 400)
    const patch = clean(parsed.data)
    await updateTask(id, patch as TaskPatch)
    await recordAuditLog(req.user!.id, 'PLATFORM_TASK_UPDATE', 'PlatformTask', id, patch as Record<string, unknown>)
    return reply.send({ success: true })
  })

  // ─── ADMIN: workspace read side ──────────────────────────────────────────
  app.get('/admin/platform-tasks/summary', { preHandler: [authenticate, superAdmin] }, async (req, reply) => {
    const q = req.query as { from?: string; to?: string }
    return reply.send({ success: true, data: await getSummary(parsePeriod(q.from, q.to)) })
  })

  app.get('/admin/platform-tasks/inbox', { preHandler: [authenticate, superAdmin] }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>
    return reply.send({
      success: true,
      data: await getInbox({
        status: q.status, taskId: q.taskId, platform: q.platform, rewardType: q.rewardType, from: q.from, to: q.to, q: q.q,
        sort: q.sort === 'newest' ? 'newest' : 'oldest', page: pageNum(q.page, 1), limit: pageNum(q.limit, 20),
      }),
    })
  })

  app.get('/admin/platform-tasks/submissions/:id', { preHandler: [authenticate, superAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    return reply.send({ success: true, data: await getSubmissionDetail(id) })
  })

  app.get('/admin/platform-tasks/rewards', { preHandler: [authenticate, superAdmin] }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>
    return reply.send({ success: true, data: await getRewards({ state: q.state, type: q.type, q: q.q, page: pageNum(q.page, 1), limit: pageNum(q.limit, 20) }) })
  })

  app.get('/admin/platform-tasks/analytics', { preHandler: [authenticate, superAdmin] }, async (req, reply) => {
    const q = req.query as { from?: string; to?: string }
    return reply.send({ success: true, data: await getAnalytics(parsePeriod(q.from, q.to)) })
  })

  app.get('/admin/platform-tasks/activity', { preHandler: [authenticate, superAdmin] }, async (req, reply) => {
    const q = req.query as { page?: string }
    return reply.send({ success: true, data: await getActivity(pageNum(q.page, 1)) })
  })

  // ─── ADMIN: review + payout ──────────────────────────────────────────────
  const decisionSchema = z.object({
    decision: z.enum(['approve', 'request_changes', 'reject']),
    revisionNo: z.number().int().positive(),
    feedback: z.string().trim().max(1000).nullable().optional(),
    internalNote: z.string().trim().max(1000).nullable().optional(),
    checks: z.record(z.boolean()).nullable().optional(),
  })

  app.post('/admin/platform-tasks/submissions/:id/decision', { preHandler: [authenticate, superAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = decisionSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid decision', 400)
    const data = await decideSubmission(req.user!.id, id, clean(parsed.data))
    await recordAuditLog(req.user!.id, `PLATFORM_TASK_${parsed.data.decision.toUpperCase()}`, 'PlatformTaskCompletion', id, {
      revisionNo: parsed.data.revisionNo, status: data.status, hasFeedback: !!parsed.data.feedback, checks: parsed.data.checks ?? null,
    })
    return reply.send({ success: true, data })
  })

  app.post('/admin/platform-tasks/submissions/:id/pay', { preHandler: [authenticate, superAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = z.object({ txHash: z.string().trim().min(10).max(100) }).safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Transaction hash is required.', 400)
    const data = await markCompletionPaid(req.user!.id, id, parsed.data.txHash)
    await recordAuditLog(req.user!.id, 'PLATFORM_TASK_PAYOUT_RECORDED', 'PlatformTaskCompletion', id, { txHash: parsed.data.txHash })
    return reply.send({ success: true, data })
  })

  app.post('/admin/platform-tasks/submissions/:id/cancel-payout', { preHandler: [authenticate, superAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = z.object({ reason: z.string().trim().min(5).max(300) }).safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'A reason for the member is required (at least 5 characters).', 400)
    const data = await cancelPayout(req.user!.id, id, parsed.data.reason)
    await recordAuditLog(req.user!.id, 'PLATFORM_TASK_PAYOUT_CANCELLED', 'PlatformTaskCompletion', id, { reason: parsed.data.reason })
    return reply.send({ success: true, data })
  })
}
