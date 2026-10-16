import type { FastifyInstance } from 'fastify'
import { authenticate, requireRole } from '../middleware/auth.middleware'
import { db } from '../lib/prisma'
import { getNumberConfig } from '../services/platformFlags.service'
import {
  buildInterestReport, effectiveThreshold, DEFAULT_MIN_GROUP, SNAPSHOT_TTL_MS, type GroupCounts, type InterestReport,
} from '../lib/portfolio/interest'

const DAY = 24 * 60 * 60 * 1000

interface Snapshot { at: number; threshold: number; report: InterestReport }
let snapshot: Snapshot | null = null

/** Test hook. */
export function resetInterestSnapshot() { snapshot = null }

async function computeReport(now: number): Promise<Snapshot> {
  const threshold = effectiveThreshold(await getNumberConfig('portfolio_interest_min_group', DEFAULT_MIN_GROUP))
  const active = { withdrawnAt: null }

  const totals = await db.portfolioListingInterest.groupBy({ by: ['identityKey'], where: active, _count: { _all: true } })
  // Only groups that can be shown need their finer detail; smaller ones are never examined further.
  const big = totals.filter((t) => t._count._all >= threshold).map((t) => t.identityKey)

  const [recent, previous, names] = big.length === 0 ? [[], [], []] : await Promise.all([
    db.portfolioListingInterest.groupBy({
      by: ['identityKey'], where: { ...active, identityKey: { in: big }, consentedAt: { gte: new Date(now - 30 * DAY) } }, _count: { _all: true },
    }),
    db.portfolioListingInterest.groupBy({
      by: ['identityKey'], where: { ...active, identityKey: { in: big }, consentedAt: { gte: new Date(now - 60 * DAY), lt: new Date(now - 30 * DAY) } }, _count: { _all: true },
    }),
    db.portfolioListingInterest.groupBy({ by: ['identityKey', 'displayName'], where: { ...active, identityKey: { in: big } }, _count: { _all: true } }),
  ])

  const count = (rows: Array<{ identityKey: string; _count: { _all: number } }>, key: string) => rows.find((r) => r.identityKey === key)?._count._all ?? 0
  const groups: GroupCounts[] = totals.map((t) => ({
    identityKey: t.identityKey,
    total: t._count._all,
    recent: count(recent, t.identityKey),
    previous: count(previous, t.identityKey),
    names: names.filter((n) => n.identityKey === t.identityKey).map((n) => ({ name: n.displayName, count: n._count._all })),
  }))
  return { at: now, threshold, report: buildInterestReport(groups, threshold) }
}

/**
 * Listing research for administrators: AGGREGATE signals only. No account list, no holdings, no
 * amounts, no notes, no individual data of any kind, and nothing below the minimum group size.
 *
 * Differencing protection beyond the threshold: counts are rounded down to a multiple of 5, the
 * trend uses rounded values, and the result is a snapshot refreshed at most once an hour, so
 * repeated queries cannot be used to see who joined or left. Every view is written to the audit log.
 * Interest never approves a listing; that needs the normal operational and risk review.
 */
export async function portfolioAdminRoutes(app: FastifyInstance) {
  app.addHook('onSend', async (_req, reply) => {
    reply.header('Cache-Control', 'private, no-store')
  })

  app.get('/portfolio/interest', {
    preHandler: [authenticate, requireRole('admin', 'super_admin')],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const now = Date.now()
    if (!snapshot || now - snapshot.at > SNAPSHOT_TTL_MS) snapshot = await computeReport(now)
    const snap = snapshot

    await db.auditLog.create({
      data: {
        actorId: req.user!.id,
        action: 'PORTFOLIO_INTEREST_VIEW',
        targetType: 'PortfolioListingInterest',
        targetId: 'aggregate',
        metadata: { threshold: snap.threshold, groupsShown: snap.report.groups.length },
        ipAddress: req.ip ?? null,
        userAgent: (req.headers['user-agent'] ?? '').toString().slice(0, 500) || null,
      },
    }).catch(() => { /* a failed audit write must not leak details; the view itself is still aggregate-only */ })

    return reply.send({
      success: true,
      data: {
        asOf: new Date(snap.at).toISOString(),
        refreshesEvery: '1 hour',
        ...snap.report,
        notice: 'Self-reported interest from consenting accounts. It is not market volume, and it does not approve a listing.',
      },
    })
  })
}
