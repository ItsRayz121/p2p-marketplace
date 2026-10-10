/**
 * Read side of the Community Tasks workspace: summary, review inbox, submission detail,
 * rewards, analytics and activity. Every number comes from real records; nothing is
 * estimated. Points and USDT are always reported separately and never summed.
 */
import { Prisma } from '@prisma/client'
import { db } from '../lib/prisma'
import { AppError } from '../lib/errors'
import { signCloudinaryDeliveryUrl } from '../lib/cloudinary'
import { getNumberConfig } from './platformFlags.service'
import { dayBuckets, median, paymentState, taskLifecycle, waitingHours, type Attachment, type Period } from './platformTask.rules'
export { parsePeriod, paymentState } from './platformTask.rules'
export type { Period, PaymentState } from './platformTask.rules'

export const REVIEW_TARGET_KEY = 'task_review_target_hours'
export const DEFAULT_REVIEW_TARGET_HOURS = 24

/** Saves the review target and returns the previous value. */
export async function setReviewTargetHours(hours: number): Promise<number> {
  const before = await getNumberConfig(REVIEW_TARGET_KEY, DEFAULT_REVIEW_TARGET_HOURS)
  await db.platformConfig.upsert({
    where: { key: REVIEW_TARGET_KEY },
    update: { value: String(hours) },
    create: { key: REVIEW_TARGET_KEY, value: String(hours) },
  })
  return before
}

const num = (d: Prisma.Decimal | null | undefined) => (d == null ? null : Number(d))

// ── Summary ─────────────────────────────────────────────────────────────────

export async function getSummary(period: Period) {
  const now = new Date()
  const targetHours = await getNumberConfig(REVIEW_TARGET_KEY, DEFAULT_REVIEW_TARGET_HOURS)
  const overdueBefore = new Date(now.getTime() - targetHours * 3_600_000)

  const [pending, overdue, needsChanges, activeTasks, awaiting, pointsCredited] = await Promise.all([
    db.platformTaskCompletion.count({ where: { status: 'pending_review' } }),
    db.platformTaskCompletion.count({ where: { status: 'pending_review', updatedAt: { lt: overdueBefore } } }),
    db.platformTaskCompletion.count({ where: { status: 'needs_changes' } }),
    db.platformTask.count({
      where: {
        isActive: true, isDraft: false, archivedAt: null,
        AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gt: now } }] }],
      },
    }),
    db.platformTaskCompletion.aggregate({ where: { status: 'awaiting_payout' }, _sum: { rewardUsdt: true }, _count: { _all: true } }),
    db.platformTaskCompletion.aggregate({
      where: { status: 'completed', rewardType: 'points', completedAt: { gte: period.from, lte: period.to } },
      _sum: { rewardPoints: true }, _count: { _all: true },
    }),
  ])

  return {
    period: { from: period.from.toISOString(), to: period.to.toISOString() },
    reviewTargetHours: targetHours,
    // Current state, independent of the selected period.
    pendingReview: { count: pending, overTarget: overdue },
    needsChanges: needsChanges,
    activeTasks,
    usdtAwaitingPayment: { amount: num(awaiting._sum.rewardUsdt) ?? 0, count: awaiting._count._all },
    // Scoped to the selected period.
    pointsCredited: { amount: num(pointsCredited._sum.rewardPoints) ?? 0, count: pointsCredited._count._all },
  }
}

// ── Inbox ───────────────────────────────────────────────────────────────────

export interface InboxQuery {
  status?: string | undefined
  taskId?: string | undefined
  platform?: string | undefined
  rewardType?: string | undefined
  from?: string | undefined
  to?: string | undefined
  q?: string | undefined
  sort?: 'oldest' | 'newest' | undefined
  page?: number | undefined
  limit?: number | undefined
}

const STATUSES = ['pending_review', 'needs_changes', 'awaiting_payout', 'completed', 'rejected']

async function userMap(ids: string[]) {
  const users = await db.user.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: { id: true, email: true, username: true, fullName: true, telegramUsername: true, avatarUrl: true },
  })
  return new Map(users.map((u) => [u.id, u]))
}

const fallbackUser = (id: string) => ({ id, email: '—', username: null, fullName: null, telegramUsername: null, avatarUrl: null })

export async function getInbox(q: InboxQuery) {
  const page = Math.max(1, q.page ?? 1)
  const limit = Math.min(50, Math.max(1, q.limit ?? 20))
  const status = q.status && STATUSES.includes(q.status) ? q.status : q.status === 'all' ? undefined : 'pending_review'

  const and: Prisma.PlatformTaskCompletionWhereInput[] = []
  if (status) and.push({ status })
  if (q.taskId) and.push({ taskId: q.taskId })
  if (q.rewardType === 'points' || q.rewardType === 'usdt') and.push({ rewardType: q.rewardType })
  if (q.platform) and.push({ task: { platform: q.platform } })
  if (q.from || q.to) {
    const range: Prisma.DateTimeFilter = {}
    if (q.from && !Number.isNaN(Date.parse(q.from))) range.gte = new Date(q.from)
    if (q.to && !Number.isNaN(Date.parse(q.to))) range.lte = new Date(q.to)
    // "Submission date": any revision submitted in the range.
    and.push({ revisions: { some: { submittedAt: range } } })
  }
  const search = q.q?.trim()
  if (search) {
    const users = await db.user.findMany({
      where: { OR: [
        { username: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { fullName: { contains: search, mode: 'insensitive' } },
      ] },
      select: { id: true },
      take: 200,
    })
    and.push({ OR: [
      { userId: { in: users.map((u) => u.id) } },
      { id: { equals: search } },
      { id: { startsWith: search } },
      { task: { title: { contains: search, mode: 'insensitive' } } },
    ] })
  }
  const where: Prisma.PlatformTaskCompletionWhereInput = and.length ? { AND: and } : {}

  const [total, rows] = await Promise.all([
    db.platformTaskCompletion.count({ where }),
    db.platformTaskCompletion.findMany({
      where,
      // Waiting time runs from the latest submission, which is what updatedAt tracks while a claim is queued.
      orderBy: [{ updatedAt: q.sort === 'newest' ? 'desc' : 'asc' }, { id: 'asc' }],
      skip: (page - 1) * limit,
      take: limit,
      include: {
        task: { select: { id: true, title: true, platform: true, verifyMode: true, logoUrl: true } },
        revisions: { orderBy: { number: 'desc' }, take: 1, select: { number: true, attachments: true, links: true, proof: true, submittedAt: true } },
      },
    }),
  ])
  const users = await userMap(rows.map((r) => r.userId))
  const now = new Date()

  return {
    total, page, limit,
    items: rows.map((r) => {
      const rev = r.revisions[0]
      const attachments = Array.isArray(rev?.attachments) ? (rev!.attachments as unknown as Attachment[]) : []
      const links = Array.isArray(rev?.links) ? (rev!.links as unknown as string[]) : []
      const submittedAt = rev?.submittedAt ?? r.updatedAt
      return {
        id: r.id,
        status: r.status,
        user: users.get(r.userId) ?? fallbackUser(r.userId),
        task: r.task,
        revisionNo: r.revisionNo,
        isResubmission: r.revisionNo > 1,
        submittedAt,
        waitingHours: r.status === 'pending_review' ? Math.round(waitingHours(submittedAt, now) * 10) / 10 : null,
        rewardType: r.rewardType,
        rewardPoints: num(r.rewardPoints),
        rewardUsdt: num(r.rewardUsdt),
        evidence: { files: attachments.length, links: links.length, hasNote: !!rev?.proof },
      }
    }),
  }
}

// ── Detail ──────────────────────────────────────────────────────────────────

const domainOf = (u: string): string | null => { try { return new URL(u).hostname.replace(/^www\./, '') } catch { return null } }

export async function getSubmissionDetail(id: string) {
  const c = await db.platformTaskCompletion.findUnique({
    where: { id },
    include: { task: true, revisions: { orderBy: { number: 'asc' } } },
  })
  if (!c) throw new AppError('NOT_FOUND', 'Submission not found', 404)
  const [users, others, reviewers] = await Promise.all([
    userMap([c.userId]),
    db.platformTaskCompletion.findMany({
      where: { userId: c.userId, id: { not: c.id } },
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: { id: true, status: true, createdAt: true, task: { select: { title: true } } },
    }),
    userMap(c.revisions.map((r) => r.reviewedById).filter((x): x is string => !!x)),
  ])
  const snap = (c.snapshot ?? null) as Record<string, unknown> | null
  const now = new Date()

  return {
    id: c.id,
    status: c.status,
    revisionNo: c.revisionNo,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    waitingHours: c.status === 'pending_review' ? Math.round(waitingHours(c.revisions[c.revisions.length - 1]?.submittedAt ?? c.updatedAt, now) * 10) / 10 : null,
    user: users.get(c.userId) ?? fallbackUser(c.userId),
    // Terms as they were when the member claimed, plus whether the task has changed since.
    terms: {
      title: (snap?.title as string | undefined) ?? c.task.title,
      instructions: (snap?.instructions as string | null | undefined) ?? c.task.instructions,
      proofRequirements: (snap?.proofRequirements as string | null | undefined) ?? c.task.proofRequirements,
      proofFileRequired: (snap?.proofFileRequired as boolean | undefined) ?? c.task.proofFileRequired,
      version: c.taskVersion,
      taskHasChangedSince: c.task.version !== c.taskVersion,
    },
    task: { id: c.task.id, title: c.task.title, platform: c.task.platform, url: c.task.url, verifyMode: c.task.verifyMode, logoUrl: c.task.logoUrl, telegramChat: c.task.telegramChat },
    reward: { type: c.rewardType, points: num(c.rewardPoints), usdt: num(c.rewardUsdt), payoutMode: c.payoutMode, payoutNetwork: c.payoutNetwork, payoutAddress: c.payoutAddress, txHash: c.txHash },
    // What is and is not verified. A screenshot or link is evidence the member submitted, not platform verification.
    verification: {
      method: c.task.verifyMode,
      automatic: c.task.verifyMode === 'telegram_auto' || c.task.verifyMode === 'self_claim',
      note: c.task.verifyMode === 'manual_proof'
        ? 'Submitted evidence only. Nothing here was checked against the platform automatically.'
        : c.task.verifyMode === 'telegram_auto'
          ? 'Membership was checked automatically through the Telegram bot at submission time.'
          : 'Self-confirmed by the member. Not verified.',
    },
    revisions: c.revisions.map((r) => ({
      number: r.number,
      submittedAt: r.submittedAt,
      proof: r.proof,
      links: (Array.isArray(r.links) ? (r.links as unknown as string[]) : []).map((u) => ({ url: u, domain: domainOf(u) })),
      attachments: (Array.isArray(r.attachments) ? (r.attachments as unknown as Attachment[]) : []).map((a) => ({
        name: a.name, size: a.size, mime: a.mime,
        // Private uploads are only viewable through a URL this server signs, and only for admins.
        viewUrl: signCloudinaryDeliveryUrl(a.url),
      })),
      decision: r.decision,
      feedback: r.feedback,
      internalNote: r.internalNote,
      checks: r.checks,
      reviewedAt: r.reviewedAt,
      reviewer: r.reviewedById ? (reviewers.get(r.reviewedById)?.username ?? reviewers.get(r.reviewedById)?.email ?? null) : null,
    })),
    otherSubmissions: others.map((o) => ({ id: o.id, status: o.status, createdAt: o.createdAt, taskTitle: o.task.title })),
  }
}

// ── Rewards ─────────────────────────────────────────────────────────────────

export interface RewardsQuery { state?: string | undefined; type?: string | undefined; q?: string | undefined; page?: number | undefined; limit?: number | undefined }

export async function getRewards(q: RewardsQuery) {
  const page = Math.max(1, q.page ?? 1)
  const limit = Math.min(50, Math.max(1, q.limit ?? 20))
  const and: Prisma.PlatformTaskCompletionWhereInput[] = [{ status: { in: ['awaiting_payout', 'completed'] } }]
  if (q.type === 'points' || q.type === 'usdt') and.push({ rewardType: q.type })
  // "Awaiting payment" is every unpaid claim (so it matches the unpaid total); processing and failed narrow it.
  if (q.state === 'awaiting_payment') and.push({ status: 'awaiting_payout' })
  else if (q.state === 'processing' || q.state === 'failed') and.push({ status: 'awaiting_payout', payoutAttempt: q.state })
  else if (q.state === 'paid') and.push({ status: 'completed', rewardType: 'usdt', txHash: { not: null } })
  else if (q.state === 'credited') and.push({ status: 'completed', OR: [{ rewardType: 'points' }, { rewardType: 'usdt', txHash: null }] })
  const search = q.q?.trim()
  if (search) {
    const users = await db.user.findMany({
      where: { OR: [{ username: { contains: search, mode: 'insensitive' } }, { email: { contains: search, mode: 'insensitive' } }] },
      select: { id: true }, take: 200,
    })
    and.push({ OR: [{ userId: { in: users.map((u) => u.id) } }, { id: { startsWith: search } }, { task: { title: { contains: search, mode: 'insensitive' } } }, { txHash: { contains: search } }] })
  }
  const where: Prisma.PlatformTaskCompletionWhereInput = { AND: and }
  const [total, rows, totals] = await Promise.all([
    db.platformTaskCompletion.count({ where }),
    db.platformTaskCompletion.findMany({
      where,
      // Money waiting on us first, then newest.
      orderBy: [{ status: 'asc' }, { reviewedAt: 'desc' }, { id: 'asc' }],
      skip: (page - 1) * limit, take: limit,
      include: { task: { select: { title: true } } },
    }),
    db.platformTaskCompletion.groupBy({ by: ['rewardType', 'status'], where: { status: { in: ['awaiting_payout', 'completed'] } }, _sum: { rewardPoints: true, rewardUsdt: true }, _count: { _all: true } }),
  ])
  const users = await userMap(rows.map((r) => r.userId))
  const sum = (type: string, status: string, f: 'rewardPoints' | 'rewardUsdt') => Number(totals.find((t) => t.rewardType === type && t.status === status)?._sum[f] ?? 0)
  return {
    total, page, limit,
    // Totals over ALL matching-state claims (not just this page); never mixed across units.
    totals: {
      pointsCredited: sum('points', 'completed', 'rewardPoints'),
      usdtAwaitingPayment: sum('usdt', 'awaiting_payout', 'rewardUsdt'),
      usdtSettled: sum('usdt', 'completed', 'rewardUsdt'),
    },
    items: rows.map((r) => ({
      id: r.id,
      user: users.get(r.userId) ?? fallbackUser(r.userId),
      taskTitle: r.task.title,
      rewardType: r.rewardType,
      amount: r.rewardType === 'points' ? num(r.rewardPoints) : num(r.rewardUsdt),
      approvedAt: r.reviewedAt ?? r.completedAt ?? r.updatedAt,
      state: paymentState(r),
      payoutMode: r.payoutMode,
      payoutNetwork: r.payoutNetwork,
      payoutAddress: r.payoutAddress,
      txHash: r.txHash,
      paidAt: r.status === 'completed' ? r.completedAt : null,
      attemptNote: r.status === 'awaiting_payout' ? r.payoutAttemptNote : null,
      attemptAt: r.status === 'awaiting_payout' ? r.payoutAttemptAt : null,
    })),
  }
}

// ── Analytics ───────────────────────────────────────────────────────────────

interface DayRow { d: Date; n: bigint }

export async function getAnalytics(period: Period) {
  const { from, to } = period
  const days = dayBuckets(from, to)

  const [submittedPerDay, decidedPerDay, reviewed, tasks, byStatus, rewardAgg] = await Promise.all([
    db.$queryRaw<DayRow[]>(Prisma.sql`SELECT date_trunc('day', "submittedAt") AS d, count(*)::bigint AS n FROM "PlatformTaskRevision" WHERE "submittedAt" >= ${from} AND "submittedAt" <= ${to} GROUP BY 1`),
    db.$queryRaw<Array<{ d: Date; decision: string; n: bigint }>>(Prisma.sql`SELECT date_trunc('day', "reviewedAt") AS d, decision, count(*)::bigint AS n FROM "PlatformTaskRevision" WHERE "reviewedAt" >= ${from} AND "reviewedAt" <= ${to} AND decision IS NOT NULL GROUP BY 1, 2`),
    // Review turnaround: manual reviews only (instant claims are decided at submission).
    db.platformTaskRevision.findMany({
      where: { reviewedAt: { gte: from, lte: to }, decision: { not: null }, completion: { task: { verifyMode: 'manual_proof' } } },
      select: { submittedAt: true, reviewedAt: true }, take: 5000,
    }),
    db.platformTask.findMany({ where: { isDraft: false }, select: { id: true, title: true, platform: true, verifyMode: true, rewardType: true, archivedAt: true } }),
    db.platformTaskCompletion.groupBy({ by: ['taskId', 'status'], where: { createdAt: { gte: from, lte: to } }, _count: { _all: true } }),
    db.platformTaskCompletion.groupBy({ by: ['rewardType', 'status'], where: { status: { in: ['completed', 'awaiting_payout'] }, reviewedAt: { gte: from, lte: to } }, _sum: { rewardPoints: true, rewardUsdt: true }, _count: { _all: true } }),
  ])

  const key = (d: Date) => d.toISOString().slice(0, 10)
  const submitted = new Map(submittedPerDay.map((r) => [key(r.d), Number(r.n)]))
  const decided = new Map<string, { approved: number; rejected: number; needs_changes: number }>()
  for (const r of decidedPerDay) {
    const k = key(r.d)
    const e = decided.get(k) ?? { approved: 0, rejected: 0, needs_changes: 0 }
    if (r.decision === 'approved') e.approved += Number(r.n)
    else if (r.decision === 'rejected') e.rejected += Number(r.n)
    else if (r.decision === 'needs_changes') e.needs_changes += Number(r.n)
    decided.set(k, e)
  }
  const daily = days.map((d) => ({ day: d, submitted: submitted.get(d) ?? 0, ...(decided.get(d) ?? { approved: 0, rejected: 0, needs_changes: 0 }) }))

  const totals = daily.reduce((a, r) => ({ submitted: a.submitted + r.submitted, approved: a.approved + r.approved, rejected: a.rejected + r.rejected, needsChanges: a.needsChanges + r.needs_changes }), { submitted: 0, approved: 0, rejected: 0, needsChanges: 0 })
  const decidedFinal = totals.approved + totals.rejected
  const turnaround = reviewed.map((r) => (r.reviewedAt!.getTime() - r.submittedAt.getTime()) / 3_600_000)

  const statusByTask = new Map<string, Record<string, number>>()
  for (const s of byStatus) {
    const m = statusByTask.get(s.taskId) ?? {}
    m[s.status] = s._count._all
    statusByTask.set(s.taskId, m)
  }
  const perTask = tasks.map((t) => {
    const s = statusByTask.get(t.id) ?? {}
    const approved = (s.completed ?? 0) + (s.awaiting_payout ?? 0)
    const rejected = s.rejected ?? 0
    return {
      id: t.id, title: t.title, platform: t.platform, verifyMode: t.verifyMode, rewardType: t.rewardType,
      claims: Object.values(s).reduce((a, b) => a + b, 0),
      approved, rejected, pending: (s.pending_review ?? 0) + (s.needs_changes ?? 0),
      approvalRate: approved + rejected > 0 ? approved / (approved + rejected) : null,
    }
  }).filter((t) => t.claims > 0).sort((a, b) => b.claims - a.claims)

  const byPlatform = new Map<string, number>()
  for (const t of perTask) byPlatform.set(t.platform ?? 'unspecified', (byPlatform.get(t.platform ?? 'unspecified') ?? 0) + t.claims)

  const reward = (type: string, status: string, f: 'rewardPoints' | 'rewardUsdt') => Number(rewardAgg.find((r) => r.rewardType === type && r.status === status)?._sum[f] ?? 0)

  return {
    period: { from: from.toISOString(), to: to.toISOString() },
    totals: { ...totals, approvalRate: decidedFinal > 0 ? totals.approved / decidedFinal : null },
    medianReviewHours: median(turnaround),
    reviewedCount: turnaround.length,
    daily,
    perTask,
    byPlatform: [...byPlatform.entries()].map(([platform, claims]) => ({ platform, claims })).sort((a, b) => b.claims - a.claims),
    // Reward totals for claims DECIDED in this period; units are never combined.
    rewards: {
      pointsCredited: reward('points', 'completed', 'rewardPoints'),
      usdtApprovedAwaitingPayment: reward('usdt', 'awaiting_payout', 'rewardUsdt'),
      usdtSettled: reward('usdt', 'completed', 'rewardUsdt'),
    },
  }
}

// ── Activity ────────────────────────────────────────────────────────────────

export async function getActivity(page = 1, limit = 30) {
  const where: Prisma.AuditLogWhereInput = { action: { startsWith: 'PLATFORM_TASK' } }
  const [total, rows] = await Promise.all([
    db.auditLog.count({ where }),
    db.auditLog.findMany({
      where, orderBy: { createdAt: 'desc' }, skip: (Math.max(1, page) - 1) * limit, take: limit,
      include: { actor: { select: { username: true, email: true } } },
    }),
  ])
  return {
    total, page, limit,
    items: rows.map((r) => ({
      id: r.id,
      action: r.action,
      actor: r.actor.username ?? r.actor.email,
      targetType: r.targetType,
      targetId: r.targetId,
      metadata: r.metadata,
      createdAt: r.createdAt,
    })),
  }
}

export { taskLifecycle }
