/**
 * Platform tasks — admin-defined tasks (follow our Telegram, etc.) that pay Points or USDT.
 *
 * Money-safety rules (this module can move real USDT):
 *  - ONE claim per (task, user) — DB unique constraint, not just an app check.
 *  - The max-claims slot and the USDT budget are reserved with conditional increments INSIDE
 *    the claim transaction, so concurrent claims can never overshoot either cap. A rejection
 *    releases the reservation.
 *  - Every state change is a compare-and-set on `status`, so a double-click / retry / two admins
 *    can never settle or pay the same claim twice. Points use a unique ledger eventKey too.
 *  - Auto USDT credits the internal wallet in the same transaction that completes the claim.
 *    Manual USDT parks the claim in `awaiting_payout`; completing it requires a tx hash, which is
 *    unique across all claims.
 *  - Self-claim tasks can only pay points, and every USDT task must carry a budget or max-claims cap.
 */
import { Prisma } from '@prisma/client'
import { db } from '../lib/prisma'
import { AppError } from '../lib/errors'
import { logger } from '../lib/logger'
import { notify } from '../lib/notify'
import { telegramRequest } from '../lib/telegram.client'
import { awardTaskPointsTx } from './airdrop.service'

type Tx = Prisma.TransactionClient

export const VERIFY_MODES = ['telegram_auto', 'manual_proof', 'self_claim'] as const
export const REWARD_TYPES = ['points', 'usdt'] as const
export const PAYOUT_MODES = ['auto', 'manual'] as const
export const PAYOUT_NETWORKS = ['BEP20', 'ERC20', 'TRC20', 'APTOS'] as const

export interface TaskInput {
  title: string
  description?: string | null
  url?: string | null
  telegramChat?: string | null
  verifyMode: (typeof VERIFY_MODES)[number]
  rewardType: (typeof REWARD_TYPES)[number]
  rewardPoints?: number | null
  rewardUsdt?: number | null
  payoutMode?: (typeof PAYOUT_MODES)[number]
  requireKyc?: boolean
  startsAt?: Date | null
  endsAt?: Date | null
  maxClaims?: number | null
  budgetUsdt?: number | null
  isActive?: boolean
}

const MAX_POINTS = 100_000
const MAX_USDT_PER_CLAIM = 1_000

function dec4(n: number): Prisma.Decimal { return new Prisma.Decimal(n.toFixed(4)) }
function dec8(n: number): Prisma.Decimal { return new Prisma.Decimal(n.toFixed(8)) }

function validateAddress(network: string, address: string): boolean {
  const net = network.toUpperCase()
  const addr = address.trim()
  if (net === 'TRC20') return /^T[A-Za-z1-9]{33}$/.test(addr)
  if (net === 'BEP20' || net === 'ERC20') return /^0x[0-9a-fA-F]{40}$/.test(addr)
  if (net === 'APTOS') return /^0x[0-9a-fA-F]{64}$/.test(addr)
  return false
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'
}

/** Cross-field rules zod can't express. Throws a 400 with a readable message. */
export function assertTaskConfig(t: TaskInput): void {
  if (t.url && !/^https:\/\//i.test(t.url)) throw new AppError('VALIDATION_ERROR', 'Task link must start with https://', 400)
  if (t.verifyMode === 'telegram_auto' && !/^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(t.telegramChat ?? '')) {
    throw new AppError('VALIDATION_ERROR', 'Auto-verify needs the channel username, e.g. @RupChainOfficial (the bot must be an admin of that channel).', 400)
  }
  if (t.startsAt && t.endsAt && t.endsAt <= t.startsAt) throw new AppError('VALIDATION_ERROR', 'End time must be after the start time.', 400)

  if (t.rewardType === 'points') {
    if (!t.rewardPoints || t.rewardPoints <= 0 || t.rewardPoints > MAX_POINTS) {
      throw new AppError('VALIDATION_ERROR', `Points reward must be between 0 and ${MAX_POINTS}.`, 400)
    }
  } else {
    if (!t.rewardUsdt || t.rewardUsdt <= 0 || t.rewardUsdt > MAX_USDT_PER_CLAIM) {
      throw new AppError('VALIDATION_ERROR', `USDT reward must be between 0 and ${MAX_USDT_PER_CLAIM}.`, 400)
    }
    if (t.verifyMode === 'self_claim') {
      throw new AppError('VALIDATION_ERROR', 'USDT tasks cannot be self-claimed — use Telegram auto-verify or manual review.', 400)
    }
    if (t.budgetUsdt == null && t.maxClaims == null) {
      throw new AppError('VALIDATION_ERROR', 'USDT tasks need a total budget or a max-claims limit so spending is capped.', 400)
    }
    if (t.budgetUsdt != null && t.budgetUsdt < t.rewardUsdt) {
      throw new AppError('VALIDATION_ERROR', 'Total budget must cover at least one reward.', 400)
    }
  }
}

function outcomeStatus(task: { rewardType: string; payoutMode: string }): 'completed' | 'awaiting_payout' {
  return task.rewardType === 'usdt' && task.payoutMode === 'manual' ? 'awaiting_payout' : 'completed'
}

// ── Admin: CRUD ─────────────────────────────────────────────────────────────

export async function createTask(adminId: string, t: TaskInput) {
  assertTaskConfig(t)
  return db.platformTask.create({
    data: {
      title: t.title.trim(),
      description: t.description?.trim() || null,
      url: t.url?.trim() || null,
      telegramChat: t.verifyMode === 'telegram_auto' ? t.telegramChat!.trim() : null,
      verifyMode: t.verifyMode,
      rewardType: t.rewardType,
      rewardPoints: t.rewardType === 'points' ? dec4(t.rewardPoints!) : null,
      rewardUsdt: t.rewardType === 'usdt' ? dec8(t.rewardUsdt!) : null,
      payoutMode: t.rewardType === 'usdt' ? (t.payoutMode ?? 'auto') : 'auto',
      requireKyc: t.requireKyc ?? false,
      startsAt: t.startsAt ?? null,
      endsAt: t.endsAt ?? null,
      maxClaims: t.maxClaims ?? null,
      budgetUsdt: t.rewardType === 'usdt' && t.budgetUsdt != null ? dec8(t.budgetUsdt) : null,
      isActive: t.isActive ?? true,
      createdById: adminId,
    },
  })
}

/** Limited edit: reward + verification are frozen once anyone has claimed, so a task can't be
 *  re-priced under people who already completed it. Caps can only move to/above current usage. */
export async function updateTask(id: string, p: Partial<Pick<TaskInput, 'title' | 'description' | 'url' | 'isActive' | 'startsAt' | 'endsAt' | 'maxClaims' | 'budgetUsdt' | 'requireKyc'>>) {
  const task = await db.platformTask.findUnique({ where: { id } })
  if (!task) throw new AppError('NOT_FOUND', 'Task not found', 404)
  if (p.maxClaims != null && p.maxClaims < task.claimedCount) throw new AppError('VALIDATION_ERROR', 'Max claims cannot be below the claims already made.', 400)
  if (p.budgetUsdt != null && p.budgetUsdt < Number(task.spentUsdt)) throw new AppError('VALIDATION_ERROR', 'Budget cannot be below what is already reserved.', 400)
  if (task.rewardType === 'usdt') {
    const effMax = p.maxClaims !== undefined ? p.maxClaims : task.maxClaims
    const effBudget = p.budgetUsdt !== undefined ? p.budgetUsdt : task.budgetUsdt
    if (effMax == null && effBudget == null) throw new AppError('VALIDATION_ERROR', 'USDT tasks need a budget or max-claims limit.', 400)
    if (effBudget != null && Number(effBudget) < Number(task.rewardUsdt)) throw new AppError('VALIDATION_ERROR', 'Budget must cover at least one reward.', 400)
  }
  const startsAt = p.startsAt !== undefined ? p.startsAt : task.startsAt
  const endsAt = p.endsAt !== undefined ? p.endsAt : task.endsAt
  if (startsAt && endsAt && endsAt <= startsAt) throw new AppError('VALIDATION_ERROR', 'End time must be after the start time.', 400)
  if (p.url && !/^https:\/\//i.test(p.url)) throw new AppError('VALIDATION_ERROR', 'Task link must start with https://', 400)

  return db.platformTask.update({
    where: { id },
    data: {
      ...(p.title !== undefined ? { title: p.title.trim() } : {}),
      ...(p.description !== undefined ? { description: p.description?.trim() || null } : {}),
      ...(p.url !== undefined ? { url: p.url?.trim() || null } : {}),
      ...(p.isActive !== undefined ? { isActive: p.isActive } : {}),
      ...(p.requireKyc !== undefined ? { requireKyc: p.requireKyc } : {}),
      ...(p.startsAt !== undefined ? { startsAt: p.startsAt } : {}),
      ...(p.endsAt !== undefined ? { endsAt: p.endsAt } : {}),
      ...(p.maxClaims !== undefined ? { maxClaims: p.maxClaims } : {}),
      ...(p.budgetUsdt !== undefined && task.rewardType === 'usdt' ? { budgetUsdt: p.budgetUsdt == null ? null : dec8(p.budgetUsdt) } : {}),
    },
  })
}

export async function adminListTasks() {
  const [tasks, counts] = await Promise.all([
    db.platformTask.findMany({ orderBy: { createdAt: 'desc' }, take: 200 }),
    db.platformTaskCompletion.groupBy({ by: ['taskId', 'status'], _count: { _all: true } }),
  ])
  const byTask = new Map<string, Record<string, number>>()
  for (const c of counts) {
    const m = byTask.get(c.taskId) ?? {}
    m[c.status] = c._count._all
    byTask.set(c.taskId, m)
  }
  return tasks.map((t) => ({
    ...t,
    rewardPoints: t.rewardPoints != null ? Number(t.rewardPoints) : null,
    rewardUsdt: t.rewardUsdt != null ? Number(t.rewardUsdt) : null,
    budgetUsdt: t.budgetUsdt != null ? Number(t.budgetUsdt) : null,
    spentUsdt: Number(t.spentUsdt),
    counts: byTask.get(t.id) ?? {},
  }))
}

export async function adminListCompletions(status: string | undefined) {
  const rows = await db.platformTaskCompletion.findMany({
    where: status ? { status } : {},
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: { task: { select: { title: true, verifyMode: true } } },
  })
  const users = await db.user.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.userId))] } },
    select: { id: true, email: true, username: true, fullName: true, telegramUsername: true },
  })
  const uMap = new Map(users.map((u) => [u.id, u]))
  return rows.map((r) => ({
    id: r.id,
    taskId: r.taskId,
    taskTitle: r.task.title,
    status: r.status,
    proof: r.proof,
    rewardType: r.rewardType,
    rewardPoints: r.rewardPoints != null ? Number(r.rewardPoints) : null,
    rewardUsdt: r.rewardUsdt != null ? Number(r.rewardUsdt) : null,
    payoutMode: r.payoutMode,
    payoutNetwork: r.payoutNetwork,
    payoutAddress: r.payoutAddress,
    txHash: r.txHash,
    rejectionReason: r.rejectionReason,
    createdAt: r.createdAt,
    completedAt: r.completedAt,
    user: uMap.get(r.userId) ?? { id: r.userId, email: '—', username: null, fullName: null, telegramUsername: null },
  }))
}

// ── User: list + claim ──────────────────────────────────────────────────────

export async function listTasksForUser(userId: string) {
  const now = new Date()
  const [open, mine, user] = await Promise.all([
    db.platformTask.findMany({
      where: {
        isActive: true,
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
    db.platformTaskCompletion.findMany({ where: { userId }, include: { task: true }, orderBy: { createdAt: 'desc' }, take: 200 }),
    db.user.findUnique({ where: { id: userId }, select: { telegramId: true, kycLevel: true } }),
  ])
  const mineByTask = new Map(mine.map((m) => [m.taskId, m]))

  const shape = (t: (typeof open)[number], claim: (typeof mine)[number] | undefined) => {
    const rewardUsdt = t.rewardUsdt != null ? Number(t.rewardUsdt) : null
    const spotsLeft = t.maxClaims != null ? Math.max(0, t.maxClaims - t.claimedCount) : null
    return {
      id: t.id,
      title: t.title,
      description: t.description,
      url: t.url,
      verifyMode: t.verifyMode,
      rewardType: t.rewardType,
      rewardPoints: t.rewardPoints != null ? Number(t.rewardPoints) : null,
      rewardUsdt,
      payoutMode: t.payoutMode,
      requireKyc: t.requireKyc,
      endsAt: t.endsAt,
      spotsLeft,
      claim: claim
        ? { status: claim.status, rejectionReason: claim.rejectionReason, txHash: claim.txHash, createdAt: claim.createdAt, completedAt: claim.completedAt }
        : null,
    }
  }

  const available = open
    .filter((t) => !mineByTask.has(t.id))
    .filter((t) => (t.maxClaims == null || t.claimedCount < t.maxClaims))
    .filter((t) => t.budgetUsdt == null || t.rewardUsdt == null || Number(t.spentUsdt) + Number(t.rewardUsdt) <= Number(t.budgetUsdt))
    .map((t) => shape(t, undefined))
  const claimed = mine.map((m) => shape(m.task, m))

  return {
    telegramLinked: !!user?.telegramId,
    kycOk: !!user?.kycLevel && user.kycLevel !== 'none',
    tasks: [...available, ...claimed],
  }
}

type TgCheck = 'member' | 'not_member' | 'unavailable'
async function checkTelegramMembership(chat: string, telegramId: bigint): Promise<TgCheck> {
  const r = await telegramRequest('getChatMember', { chat_id: chat, user_id: Number(telegramId) })
  if (r.ok) {
    const res = r.result as { status?: string; is_member?: boolean } | undefined
    const s = res?.status
    if (s === 'creator' || s === 'administrator' || s === 'member') return 'member'
    if (s === 'restricted' && res?.is_member) return 'member'
    return 'not_member'
  }
  // 400 = Telegram says this user isn't a participant of the chat.
  if (r.status === 400) return 'not_member'
  logger.warn({ chat, status: r.status }, 'platform task: telegram membership check unavailable')
  return 'unavailable'
}

/** Side effects that actually pay out. Runs inside the settle transaction. */
async function applyGrantTx(
  tx: Tx,
  c: { id: string; userId: string; rewardType: string; rewardPoints: Prisma.Decimal | null; rewardUsdt: Prisma.Decimal | null },
  task: { id: string; title: string },
  status: 'completed' | 'awaiting_payout',
): Promise<void> {
  if (c.rewardType === 'points') {
    await awardTaskPointsTx(tx, {
      userId: c.userId,
      points: Number(c.rewardPoints),
      eventKey: `task:${c.id}`,
      metadata: { taskId: task.id, title: task.title },
    })
    return
  }
  if (status !== 'completed') return // manual payout: nothing moves until the admin records the tx hash
  const amount = c.rewardUsdt as Prisma.Decimal
  const existing = await tx.wallet.findFirst({ where: { userId: c.userId, coin: 'USDT' }, select: { network: true } })
  const network = existing?.network ?? 'BEP20'
  const wallet = await tx.wallet.upsert({
    where: { userId_coin_network: { userId: c.userId, coin: 'USDT', network } },
    create: { userId: c.userId, coin: 'USDT', network, balance: amount, lockedBalance: new Prisma.Decimal(0) },
    update: { balance: { increment: amount } },
  })
  await tx.transaction.create({
    data: {
      walletId: wallet.id,
      type: 'task_reward',
      amount,
      fee: new Prisma.Decimal(0),
      status: 'completed',
      metadata: { source: 'platform_task', taskId: task.id, completionId: c.id },
    },
  })
}

function notifyReward(userId: string, task: { title: string }, c: { rewardType: string; rewardPoints: Prisma.Decimal | null; rewardUsdt: Prisma.Decimal | null }, status: 'completed' | 'awaiting_payout') {
  const reward = c.rewardType === 'points' ? `${Number(c.rewardPoints)} points` : `$${Number(c.rewardUsdt).toFixed(2)} USDT`
  if (status === 'awaiting_payout') {
    notify(userId, 'task_reward', 'Task approved ✅', `"${task.title}" was approved. Your ${reward} will be sent to your address shortly.`, {}, undefined, '/points')
  } else {
    notify(userId, 'task_reward', 'Task reward received 🎉', `You earned ${reward} for "${task.title}".`, {}, undefined, '/points')
  }
}

export async function claimTask(userId: string, taskId: string, input: { proof?: string | undefined; payoutNetwork?: string | undefined; payoutAddress?: string | undefined }) {
  const task = await db.platformTask.findUnique({ where: { id: taskId } })
  const now = new Date()
  if (!task || !task.isActive) throw new AppError('NOT_FOUND', 'This task is not available.', 404)
  if (task.startsAt && task.startsAt > now) throw new AppError('TASK_NOT_STARTED', 'This task has not started yet.', 400)
  if (task.endsAt && task.endsAt <= now) throw new AppError('TASK_ENDED', 'This task has ended.', 400)

  const [user, existing] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { kycLevel: true, telegramId: true } }),
    db.platformTaskCompletion.findUnique({ where: { taskId_userId: { taskId, userId } }, select: { id: true } }),
  ])
  if (!user) throw new AppError('NOT_FOUND', 'User not found', 404)
  if (existing) throw new AppError('ALREADY_CLAIMED', 'You have already submitted this task.', 409)
  if (task.requireKyc && (!user.kycLevel || user.kycLevel === 'none')) {
    throw new AppError('KYC_REQUIRED', 'Complete identity verification (KYC) to do this task.', 403)
  }

  // Input checks that never touch the DB cap counters.
  let payoutNetwork: string | null = null
  let payoutAddress: string | null = null
  if (task.rewardType === 'usdt' && task.payoutMode === 'manual') {
    const net = (input.payoutNetwork ?? '').toUpperCase()
    const addr = (input.payoutAddress ?? '').trim()
    if (!(PAYOUT_NETWORKS as readonly string[]).includes(net) || !validateAddress(net, addr)) {
      throw new AppError('VALIDATION_ERROR', 'Enter a valid USDT address for the selected network.', 400)
    }
    payoutNetwork = net
    payoutAddress = addr
  }
  const proof = (input.proof ?? '').trim()
  if (task.verifyMode === 'manual_proof' && (proof.length < 3 || proof.length > 500)) {
    throw new AppError('VALIDATION_ERROR', 'Add your proof (username, link or short note).', 400)
  }
  if (task.verifyMode === 'telegram_auto') {
    if (!user.telegramId) throw new AppError('TELEGRAM_NOT_LINKED', 'Link your Telegram account first, then try again.', 400)
    const res = await checkTelegramMembership(task.telegramChat!, user.telegramId)
    if (res === 'not_member') throw new AppError('TELEGRAM_NOT_JOINED', 'We could not see you in the channel yet. Join it, then tap Verify again.', 400)
    if (res === 'unavailable') throw new AppError('TELEGRAM_UNAVAILABLE', 'Telegram verification is unavailable right now. Please try again in a minute.', 503)
  }

  const instant = task.verifyMode !== 'manual_proof'
  const finalStatus = outcomeStatus(task)
  const status = instant ? finalStatus : 'pending_review'

  try {
    const completion = await db.$transaction(async (tx) => {
      // Reserve a claim slot (max-claims cap).
      if (task.maxClaims != null) {
        const slot = await tx.platformTask.updateMany({
          where: { id: task.id, isActive: true, claimedCount: { lt: task.maxClaims } },
          data: { claimedCount: { increment: 1 } },
        })
        if (slot.count !== 1) throw new AppError('TASK_FULL', 'This task has reached its claim limit.', 400)
      } else {
        await tx.platformTask.update({ where: { id: task.id }, data: { claimedCount: { increment: 1 } } })
      }
      // Reserve USDT budget.
      if (task.rewardType === 'usdt' && task.budgetUsdt != null) {
        const threshold = task.budgetUsdt.minus(task.rewardUsdt as Prisma.Decimal)
        const b = await tx.platformTask.updateMany({
          where: { id: task.id, spentUsdt: { lte: threshold } },
          data: { spentUsdt: { increment: task.rewardUsdt as Prisma.Decimal } },
        })
        if (b.count !== 1) throw new AppError('TASK_FULL', 'This task’s reward budget is fully claimed.', 400)
      } else if (task.rewardType === 'usdt') {
        await tx.platformTask.update({ where: { id: task.id }, data: { spentUsdt: { increment: task.rewardUsdt as Prisma.Decimal } } })
      }

      const created = await tx.platformTaskCompletion.create({
        data: {
          taskId: task.id,
          userId,
          status,
          proof: proof || null,
          rewardType: task.rewardType,
          rewardPoints: task.rewardPoints,
          rewardUsdt: task.rewardUsdt,
          payoutMode: task.rewardType === 'usdt' ? task.payoutMode : null,
          payoutNetwork,
          payoutAddress,
          ...(status === 'completed' ? { completedAt: new Date() } : {}),
        },
      })
      if (instant) await applyGrantTx(tx, created, task, finalStatus)
      return created
    })

    if (instant) notifyReward(userId, task, completion, finalStatus)
    return { status: completion.status }
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError('ALREADY_CLAIMED', 'You have already submitted this task.', 409)
    throw e
  }
}

// ── Admin: review + payout ──────────────────────────────────────────────────

export async function approveCompletion(adminId: string, completionId: string) {
  const c = await db.platformTaskCompletion.findUnique({ where: { id: completionId }, include: { task: true } })
  if (!c) throw new AppError('NOT_FOUND', 'Submission not found', 404)
  const finalStatus = outcomeStatus(c.task)
  await db.$transaction(async (tx) => {
    const flip = await tx.platformTaskCompletion.updateMany({
      where: { id: c.id, status: 'pending_review' },
      data: { status: finalStatus, reviewedById: adminId, reviewedAt: new Date(), ...(finalStatus === 'completed' ? { completedAt: new Date() } : {}) },
    })
    if (flip.count !== 1) throw new AppError('INVALID_STATE', 'This submission was already reviewed.', 409)
    await applyGrantTx(tx, c, c.task, finalStatus)
  })
  notifyReward(c.userId, c.task, c, finalStatus)
  return { status: finalStatus }
}

export async function rejectCompletion(adminId: string, completionId: string, reason: string) {
  const c = await db.platformTaskCompletion.findUnique({ where: { id: completionId }, include: { task: true } })
  if (!c) throw new AppError('NOT_FOUND', 'Submission not found', 404)
  await db.$transaction(async (tx) => {
    const flip = await tx.platformTaskCompletion.updateMany({
      where: { id: c.id, status: { in: ['pending_review', 'awaiting_payout'] } },
      data: { status: 'rejected', rejectionReason: reason, reviewedById: adminId, reviewedAt: new Date() },
    })
    if (flip.count !== 1) throw new AppError('INVALID_STATE', 'This submission can no longer be rejected.', 409)
    // Release the reservation so the slot / budget is available again.
    await tx.platformTask.update({
      where: { id: c.taskId },
      data: {
        claimedCount: { decrement: 1 },
        ...(c.rewardType === 'usdt' && c.rewardUsdt ? { spentUsdt: { decrement: c.rewardUsdt } } : {}),
      },
    })
  })
  notify(c.userId, 'task_reward', 'Task not approved', `"${c.task.title}" was not approved: ${reason}`, {}, undefined, '/points')
  return { status: 'rejected' as const }
}

/** Manual USDT: admin paid off-platform and records the transfer hash. */
export async function markCompletionPaid(adminId: string, completionId: string, txHash: string) {
  const hash = txHash.trim()
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(hash)) throw new AppError('VALIDATION_ERROR', 'Enter a valid transaction hash (64 hex characters).', 400)
  const c = await db.platformTaskCompletion.findUnique({ where: { id: completionId }, include: { task: true } })
  if (!c) throw new AppError('NOT_FOUND', 'Submission not found', 404)
  try {
    const flip = await db.platformTaskCompletion.updateMany({
      where: { id: c.id, status: 'awaiting_payout' },
      data: { status: 'completed', txHash: hash, completedAt: new Date(), reviewedById: adminId, reviewedAt: new Date() },
    })
    if (flip.count !== 1) throw new AppError('INVALID_STATE', 'This payout was already recorded or is not awaiting payment.', 409)
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError('DUPLICATE_TX', 'That transaction hash is already recorded on another payout.', 409)
    throw e
  }
  notify(
    c.userId,
    'task_reward',
    'USDT sent 💸',
    `Your $${Number(c.rewardUsdt).toFixed(2)} USDT reward for "${c.task.title}" was sent. Tx: ${hash.slice(0, 12)}…`,
    { txHash: hash },
    undefined,
    '/points',
  )
  return { status: 'completed' as const }
}
