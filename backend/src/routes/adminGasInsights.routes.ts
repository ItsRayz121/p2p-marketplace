import type { FastifyInstance } from 'fastify'
import { authenticate, requireRole } from '../middleware/auth.middleware'
import { db } from '../lib/prisma'
import { AppError } from '../lib/errors'
import { buildGasOrderWhere } from '../lib/gas/gas.orderQuery'
import {
  bucketKey, bucketKeys, change, dailyActivity, dailySettled, deliveryByNetwork, deliveryDate, demandByAsset,
  GAS_CATEGORIES, inWindow, pickBucketUnit, previousWindow, recipientKeyFromParts, safeTimeZone, shareOf,
  summarizeCohort, summarizePayments, userSeries, userTotals,
  type CohortSummary, type InsightOrderRow, type Window,
} from '../lib/gas/gas.insights'

const adminOrSuper = requireRole('admin', 'super_admin')
const MAX_ROWS = 100_000

const ORDER_SELECT = {
  id: true, userId: true, toAddress: true, chain: true, isFreeGrant: true, paymentCoin: true, paymentNetwork: true,
  status: true, retryCount: true, paymentTxHash: true, failureReason: true, deliveryTxHash: true, gasAmountUSD: true,
  createdAt: true, deliveredAt: true, paymentVerifiedAt: true, updatedAt: true,
  gasTokenConfig: { select: { symbol: true } },
} as const

type RawRow = Omit<InsightOrderRow, 'tokenSymbol' | 'gasAmountUSD'> & { gasAmountUSD: unknown; gasTokenConfig: { symbol: string } | null }

function toRow(r: RawRow): InsightOrderRow {
  const { gasTokenConfig, gasAmountUSD, ...rest } = r
  return { ...rest, gasAmountUSD: Number(gasAmountUSD ?? 0), tokenSymbol: gasTokenConfig?.symbol ?? null }
}

/** `from`/`to` are ISO instants (inclusive). No `from` = All time. */
function parseWindow(q: { from?: string | undefined; to?: string | undefined }): Window {
  const to = q.to ? new Date(q.to) : new Date()
  if (Number.isNaN(to.getTime())) throw new AppError('VALIDATION_ERROR', 'Invalid "to" date', 400)
  let from: Date | null = null
  if (q.from) {
    from = new Date(q.from)
    if (Number.isNaN(from.getTime())) throw new AppError('VALIDATION_ERROR', 'Invalid "from" date', 400)
    if (from > to) throw new AppError('VALIDATION_ERROR', '"from" must be before "to"', 400)
  }
  return { from, to }
}

function meta(w: Window, pw: Window | null, tz: string, unit: string) {
  return {
    from: w.from?.toISOString() ?? null,
    to: w.to.toISOString(),
    prevFrom: pw?.from?.toISOString() ?? null,
    prevTo: pw?.to.toISOString() ?? null,
    hasComparison: pw !== null,
    timeZone: tz,
    bucket: unit,
    generatedAt: new Date().toISOString(),
  }
}

function categoryBlock(cur: CohortSummary, prev: CohortSummary | null) {
  return GAS_CATEGORIES.map((c) => ({
    category: c,
    count: cur.byCategory[c],
    share: shareOf(cur.byCategory[c], cur.total),
    delivered: cur.deliveredByCategory[c],
    change: prev ? change(cur.byCategory[c], prev.byCategory[c]) : null,
  }))
}

export async function adminGasInsightsRoutes(app: FastifyInstance) {
  // ── GET /admin/gas/insights — the dedicated Analytics page ────────────────────
  //
  // Metric basis (also shown in the UI tooltips):
  //   orders / delivered / paid purchases / categories / network delivery → orders CREATED in range
  //   unique / new / returning gas users                                  → deliveries CONFIRMED in range
  app.get('/admin/gas/insights', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const q = req.query as { from?: string; to?: string; tz?: string }
    const w = parseWindow(q)
    const pw = previousWindow(w)
    const tz = safeTimeZone(q.tz)

    const lo = pw?.from ?? w.from
    const range = lo ? { gte: lo, lte: w.to } : undefined
    const rawRows = await db.gasFeeOrder.findMany({
      where: range ? { OR: [{ createdAt: range }, { deliveredAt: range }] } : {},
      select: ORDER_SELECT,
      orderBy: { createdAt: 'desc' },
      take: MAX_ROWS,
    })
    const rows = (rawRows as unknown as RawRow[]).map(toRow)

    // First-ever delivery per recipient (all history), for new vs returning.
    const [firstByUser, firstByAddr] = await Promise.all([
      db.gasFeeOrder.groupBy({ by: ['userId'], where: { status: 'delivered', deliveredAt: { not: null }, userId: { not: null } }, _min: { deliveredAt: true } }),
      db.gasFeeOrder.groupBy({ by: ['toAddress'], where: { status: 'delivered', deliveredAt: { not: null }, userId: null }, _min: { deliveredAt: true } }),
    ])
    const firstEver = new Map<string, Date>()
    for (const g of firstByUser) if (g._min.deliveredAt) firstEver.set(recipientKeyFromParts(g.userId, ''), g._min.deliveredAt)
    for (const g of firstByAddr) {
      if (!g._min.deliveredAt) continue
      const k = recipientKeyFromParts(null, g.toAddress)
      const ex = firstEver.get(k)
      if (!ex || g._min.deliveredAt < ex) firstEver.set(k, g._min.deliveredAt)
    }

    const cohort = rows.filter((r) => inWindow(r.createdAt, w))
    const prevCohort = pw ? rows.filter((r) => inWindow(r.createdAt, pw)) : []
    const deliveries = rows.filter((r) => { const d = deliveryDate(r); return !!d && inWindow(d, w) })
    const prevDeliveries = pw ? rows.filter((r) => { const d = deliveryDate(r); return !!d && inWindow(d, pw) }) : []

    const cur = summarizeCohort(cohort)
    const prev = pw ? summarizeCohort(prevCohort) : null
    const users = userTotals(deliveries, firstEver, w)
    const prevUsers = pw ? userTotals(prevDeliveries, firstEver, pw) : null

    const spanFrom = w.from ?? cohort.reduce<Date>((m, r) => (r.createdAt < m ? r.createdAt : m), w.to)
    const unit = pickBucketUnit(w.to.getTime() - spanFrom.getTime())

    // Registered users: account creation events, not purchases. null when unavailable.
    let registered: { key: string; count: number }[] | null = null
    try {
      const created = await db.user.findMany({
        where: { createdAt: { ...(w.from ? { gte: w.from } : {}), lte: w.to } },
        select: { createdAt: true },
        take: MAX_ROWS,
      })
      const keys = bucketKeys(w.from ?? created.reduce<Date>((m, u) => (u.createdAt < m ? u.createdAt : m), w.to), w.to, tz, unit)
      const counts = new Map(keys.map((k) => [k, 0]))
      for (const u of created) {
        const k = bucketKey(u.createdAt, tz, unit)
        if (counts.has(k)) counts.set(k, (counts.get(k) ?? 0) + 1)
      }
      registered = keys.map((key) => ({ key, count: counts.get(key) ?? 0 }))
    } catch { registered = null }

    const ppChange = cur.successRate !== null && prev && prev.successRate !== null
      ? (cur.successRate - prev.successRate) * 100 : null

    return reply.send({
      success: true,
      data: {
        meta: { ...meta(w, pw, tz, unit), truncated: rawRows.length >= MAX_ROWS },
        headline: {
          totalOrders: change(cur.total, prev ? prev.total : null),
          deliveredOrders: change(cur.delivered, prev ? prev.delivered : null),
          paidPurchases: change(cur.paidPurchases, prev ? prev.paidPurchases : null),
          uniqueUsers: change(users.unique, prevUsers ? prevUsers.unique : null),
          newUsers: change(users.newUsers, prevUsers ? prevUsers.newUsers : null),
          deliverySuccess: {
            rate: cur.successRate, previousRate: prev ? prev.successRate : null, pointChange: ppChange,
            delivered: cur.delivered, failed: cur.failedDelivery, pending: cur.pending,
            denominator: cur.delivered + cur.failedDelivery,
          },
        },
        outcomes: { delivered: cur.delivered, failed: cur.failedDelivery, pending: cur.pending, other: cur.other },
        categories: categoryBlock(cur, prev),
        freeGas: cur.freeGas,
        daily: dailyActivity(cohort, prevCohort, w, pw, tz, unit),
        demand: {
          paid: demandByAsset(cohort, 'paid'),
          free: demandByAsset(cohort, 'free'),
          all: demandByAsset(cohort, 'all'),
        },
        users: {
          daily: userSeries(deliveries, firstEver, w, tz, unit),
          registered,
        },
        delivery: {
          delivered: cur.delivered, failed: cur.failedDelivery, pending: cur.pending,
          successRate: cur.successRate,
          avgCompletionSec: cur.avgCompletionSec,
          avgCompletionChange: change(cur.avgCompletionSec, prev ? prev.avgCompletionSec : null),
          failedChange: change(cur.failedDelivery, prev ? prev.failedDelivery : null),
          byNetwork: deliveryByNetwork(cohort),
        },
      },
    })
  })

  // ── GET /admin/gas/orders/summary — compact strip for Gas Trades / Payment Orders ─
  //
  // Accepts the SAME filters as GET /admin/gas/orders (status, category, merchantOnly,
  // chain, search, …) plus from/to/tz, so cards, chart and the list describe one set.
  app.get('/admin/gas/orders/summary', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>
    const view = q.view === 'payments' ? 'payments' : 'trades'
    const w = parseWindow(q)
    const pw = previousWindow(w)
    const tz = safeTimeZone(q.tz)

    const where = buildGasOrderWhere(q, { omitDates: true })
    const lo = pw?.from ?? w.from
    where.createdAt = lo ? { gte: lo, lte: w.to } : { lte: w.to }

    const rawRows = await db.gasFeeOrder.findMany({ where, select: ORDER_SELECT, orderBy: { createdAt: 'desc' }, take: MAX_ROWS })
    const rows = (rawRows as unknown as RawRow[]).map(toRow)
    const cohort = rows.filter((r) => inWindow(r.createdAt, w))
    const prevCohort = pw ? rows.filter((r) => inWindow(r.createdAt, pw)) : []
    const spanFrom = w.from ?? cohort.reduce<Date>((m, r) => (r.createdAt < m ? r.createdAt : m), w.to)
    const unit = pickBucketUnit(w.to.getTime() - spanFrom.getTime())
    const m = { ...meta(w, pw, tz, unit), truncated: rawRows.length >= MAX_ROWS }

    if (view === 'payments') {
      const cur = summarizePayments(cohort)
      const prev = pw ? summarizePayments(prevCohort) : null
      return reply.send({
        success: true,
        data: {
          meta: m,
          cards: {
            paymentOrders: change(cur.paymentOrders, prev ? prev.paymentOrders : null),
            settled: change(cur.settled, prev ? prev.settled : null),
            settledCrypto: change(cur.settledCrypto, prev ? prev.settledCrypto : null),
            settledPkr: change(cur.settledPkr, prev ? prev.settledPkr : null),
          },
          shares: {
            crypto: shareOf(cur.settledCrypto, cur.settled),
            pkr: shareOf(cur.settledPkr, cur.settled),
          },
          pendingPayment: cur.pendingPayment,
          daily: dailySettled(cohort, prevCohort, w, pw, tz, unit),
        },
      })
    }

    const cur = summarizeCohort(cohort)
    const prev = pw ? summarizeCohort(prevCohort) : null
    return reply.send({
      success: true,
      data: {
        meta: m,
        cards: {
          orders: change(cur.total, prev ? prev.total : null),
          delivered: change(cur.delivered, prev ? prev.delivered : null),
          uniqueRecipients: change(cur.uniqueRecipients, prev ? prev.uniqueRecipients : null),
          freeDelivered: change(cur.freeGas.delivered, prev ? prev.freeGas.delivered : null),
        },
        categories: categoryBlock(cur, prev),
        outcomes: { delivered: cur.delivered, failed: cur.failedDelivery, pending: cur.pending, other: cur.other },
        freeGas: cur.freeGas,
        daily: dailyActivity(cohort, prevCohort, w, pw, tz, unit),
      },
    })
  })
}
