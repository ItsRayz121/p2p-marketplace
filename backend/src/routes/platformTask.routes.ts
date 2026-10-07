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
  adminListCompletions,
  listTasksForUser,
  claimTask,
  approveCompletion,
  rejectCompletion,
  markCompletionPaid,
  type TaskInput,
} from '../services/platformTask.service'

const optDate = z.preprocess((v) => (v === '' || v == null ? null : v), z.coerce.date().nullable()).optional()
const optPosInt = z.preprocess((v) => (v === '' || v == null ? null : v), z.number().int().positive().nullable()).optional()
const optPosNum = z.preprocess((v) => (v === '' || v == null ? null : v), z.number().positive().nullable()).optional()

const createSchema = z.object({
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  url: z.string().trim().url().max(300).nullable().optional(),
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
})

const updateSchema = z.object({
  title: z.string().trim().min(3).max(120).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  url: z.string().trim().url().max(300).nullable().optional(),
  isActive: z.boolean().optional(),
  requireKyc: z.boolean().optional(),
  startsAt: optDate,
  endsAt: optDate,
  maxClaims: optPosInt,
  budgetUsdt: optPosNum,
})

// Zod's optional-with-exactOptionalPropertyTypes friendly strip of undefined keys.
function clean<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}

export async function platformTaskRoutes(app: FastifyInstance) {
  // Money-moving + config surface: super_admin only (same as airdrop admin).
  const superAdmin = requireRole('super_admin')

  // ─── USER ────────────────────────────────────────────────────────────────
  app.get('/platform-tasks', { preHandler: [authenticate] }, async (req, reply) => {
    return reply.send({ success: true, data: await listTasksForUser(req.user!.id) })
  })

  app.post('/platform-tasks/:id/claim', { preHandler: [authenticate], config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = z.object({
      proof: z.string().max(500).optional(),
      payoutNetwork: z.string().max(10).optional(),
      payoutAddress: z.string().max(100).optional(),
    }).safeParse(req.body ?? {})
    if (!body.success) throw new AppError('VALIDATION_ERROR', 'Invalid input', 400)
    const data = await claimTask(req.user!.id, id, body.data)
    return reply.send({ success: true, data })
  })

  // ─── ADMIN ───────────────────────────────────────────────────────────────
  app.get('/admin/platform-tasks', { preHandler: [authenticate, superAdmin] }, async (_req, reply) => {
    return reply.send({ success: true, data: await adminListTasks() })
  })

  app.post('/admin/platform-tasks', { preHandler: [authenticate, superAdmin] }, async (req, reply) => {
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid task', 400)
    const task = await createTask(req.user!.id, clean(parsed.data) as unknown as TaskInput)
    await recordAuditLog(req.user!.id, 'PLATFORM_TASK_CREATE', 'PlatformTask', task.id, {
      title: task.title, rewardType: task.rewardType, rewardPoints: task.rewardPoints?.toString(), rewardUsdt: task.rewardUsdt?.toString(),
      payoutMode: task.payoutMode, verifyMode: task.verifyMode, budgetUsdt: task.budgetUsdt?.toString(), maxClaims: task.maxClaims,
    })
    return reply.code(201).send({ success: true, data: { id: task.id } })
  })

  app.patch('/admin/platform-tasks/:id', { preHandler: [authenticate, superAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = updateSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid update', 400)
    const patch = clean(parsed.data)
    await updateTask(id, patch as Parameters<typeof updateTask>[1])
    await recordAuditLog(req.user!.id, 'PLATFORM_TASK_UPDATE', 'PlatformTask', id, patch as Record<string, unknown>)
    return reply.send({ success: true })
  })

  app.get('/admin/platform-tasks/submissions', { preHandler: [authenticate, superAdmin] }, async (req, reply) => {
    const { status } = req.query as { status?: string }
    return reply.send({ success: true, data: await adminListCompletions(status || undefined) })
  })

  app.post('/admin/platform-tasks/submissions/:id/approve', { preHandler: [authenticate, superAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const data = await approveCompletion(req.user!.id, id)
    await recordAuditLog(req.user!.id, 'PLATFORM_TASK_APPROVE', 'PlatformTaskCompletion', id, { status: data.status })
    return reply.send({ success: true, data })
  })

  app.post('/admin/platform-tasks/submissions/:id/reject', { preHandler: [authenticate, superAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = z.object({ reason: z.string().trim().min(2).max(300) }).safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'A rejection reason is required.', 400)
    const data = await rejectCompletion(req.user!.id, id, parsed.data.reason)
    await recordAuditLog(req.user!.id, 'PLATFORM_TASK_REJECT', 'PlatformTaskCompletion', id, { reason: parsed.data.reason })
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
}
