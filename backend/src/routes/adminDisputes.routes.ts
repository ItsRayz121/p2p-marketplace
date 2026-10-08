import type { FastifyInstance } from 'fastify'
import type { Prisma } from '@prisma/client'
import { authenticate, requireRole } from '../middleware/auth.middleware'
import { db } from '../lib/prisma'
import { AppError } from '../lib/errors'

/**
 * Marketplace Disputes overview — a read-only, market-agnostic view over the two
 * existing dispute workflows (USDT `Dispute`, CTM `CtmDispute`). Resolution itself
 * still goes through the original per-market endpoints; nothing here changes a
 * dispute outcome, a trade status or any money.
 *
 * Trade status and dispute status are separate: a trade that completed AFTER a
 * dispute was opened keeps its dispute row (resolutionType = settled_by_parties),
 * and shows up under "Closed", never as an admin "Resolved" ruling.
 */

const adminOrSuper = requireRole('admin', 'super_admin')

type Market = 'usdt' | 'ctm'
type Filter = 'all' | 'open' | 'escalated' | 'resolved' | 'closed'
const FILTERS: readonly Filter[] = ['all', 'open', 'escalated', 'resolved', 'closed']

const NO_FAULT = ['settled_by_parties', 'dismissed'] as const
const RULED = ['buyer_wins', 'seller_wins', 'split'] as const

/** Dispute-status buckets. Mutually exclusive, and together they cover every row. */
type StatusWhere = Prisma.DisputeWhereInput & Prisma.CtmDisputeWhereInput

function whereFor(filter: Filter): StatusWhere {
  switch (filter) {
    case 'open':
      return { status: { in: ['open', 'under_review', 'awaiting_evidence'] } }
    case 'escalated':
      return { status: 'escalated' }
    case 'resolved':
      // Admin ruled (or an older row with no resolutionType recorded).
      return { status: 'resolved', OR: [{ resolutionType: null }, { resolutionType: { in: [...RULED] } }] }
    case 'closed':
      // Closed without a ruling against anyone: settled by the parties or dismissed.
      return { status: 'resolved', resolutionType: { in: [...NO_FAULT] } }
    default:
      return {}
  }
}

export interface ParticipantStats {
  total: number
  open: number
  won: number
  lost: number
  split: number
  closedNoFault: number
  resolvedOther: number
}

const emptyStats = (): ParticipantStats => ({ total: 0, open: 0, won: 0, lost: 0, split: 0, closedNoFault: 0, resolvedOther: 0 })

interface DisputeLite {
  status: string
  winner: string | null
  resolutionType: string | null
  buyerId: string
  sellerId: string
}

/** Total disputes per user across BOTH markets, broken down by outcome from that user's side. */
async function participantStats(userIds: string[]): Promise<Map<string, ParticipantStats>> {
  const out = new Map<string, ParticipantStats>(userIds.map((id) => [id, emptyStats()]))
  if (userIds.length === 0) return out
  const [usdt, ctm] = await Promise.all([
    db.dispute.findMany({
      where: { trade: { OR: [{ buyerId: { in: userIds } }, { sellerId: { in: userIds } }] } },
      select: { status: true, winner: true, resolutionType: true, trade: { select: { buyerId: true, sellerId: true } } },
    }),
    db.ctmDispute.findMany({
      where: { trade: { OR: [{ buyerId: { in: userIds } }, { sellerId: { in: userIds } }] } },
      select: { status: true, winner: true, resolutionType: true, trade: { select: { buyerId: true, sellerId: true } } },
    }),
  ])
  const rows: DisputeLite[] = [...usdt, ...ctm].map((d) => ({
    status: d.status, winner: d.winner, resolutionType: d.resolutionType, buyerId: d.trade.buyerId, sellerId: d.trade.sellerId,
  }))
  for (const d of rows) {
    for (const [uid, side] of [[d.buyerId, 'buyer'], [d.sellerId, 'seller']] as const) {
      const s = out.get(uid)
      if (!s) continue
      s.total++
      if (d.status !== 'resolved') { s.open++; continue }
      if (d.resolutionType && (NO_FAULT as readonly string[]).includes(d.resolutionType)) { s.closedNoFault++; continue }
      if (d.resolutionType === 'split') { s.split++; continue }
      const winner = d.winner ?? (d.resolutionType === 'buyer_wins' ? 'buyer' : d.resolutionType === 'seller_wins' ? 'seller' : null)
      if (!winner) { s.resolvedOther++; continue }
      if (winner === side) s.won++
      else s.lost++
    }
  }
  return out
}

export async function adminDisputeRoutes(app: FastifyInstance) {
  // GET /admin/disputes/overview?market=usdt|ctm&filter=all|open|escalated|resolved|closed&page=&limit=&search=
  app.get('/admin/disputes/overview', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>
    const market: Market = q.market === 'ctm' ? 'ctm' : 'usdt'
    const filter: Filter = (FILTERS as readonly string[]).includes(q.filter ?? '') ? (q.filter as Filter) : 'all'
    const page = Math.max(1, parseInt(q.page ?? '1', 10) || 1)
    const limit = Math.min(100, Math.max(1, parseInt(q.limit ?? '20', 10) || 20))
    const search = q.search?.trim().slice(0, 80)

    const usdtSearch: Prisma.DisputeWhereInput = search
      ? { trade: { OR: [
          { orderRef: { contains: search, mode: 'insensitive' } },
          { buyer: { username: { contains: search, mode: 'insensitive' } } },
          { seller: { username: { contains: search, mode: 'insensitive' } } },
        ] } }
      : {}
    const ctmSearch: Prisma.CtmDisputeWhereInput = search
      ? { trade: { OR: [
          { tradeRef: { contains: search, mode: 'insensitive' } },
          { displayRef: { contains: search, mode: 'insensitive' } },
          { buyer: { username: { contains: search, mode: 'insensitive' } } },
          { seller: { username: { contains: search, mode: 'insensitive' } } },
        ] } }
      : {}
    const usdtWhere = (f: Filter): Prisma.DisputeWhereInput => ({ AND: [usdtSearch, whereFor(f)] })
    const ctmWhere = (f: Filter): Prisma.CtmDisputeWhereInput => ({ AND: [ctmSearch, whereFor(f)] })

    const count = (f: Filter) => (market === 'usdt' ? db.dispute.count({ where: usdtWhere(f) }) : db.ctmDispute.count({ where: ctmWhere(f) }))
    const countsArr = await Promise.all(FILTERS.map(count))
    const counts = Object.fromEntries(FILTERS.map((f, i) => [f, countsArr[i]])) as Record<Filter, number>

    const skip = (page - 1) * limit
    const userSel = { select: { id: true, username: true } } as const

    type Row = {
      id: string; status: string; reason: string; openedById: string; resolutionType: string | null; winner: string | null
      escalatedAt: Date | null; resolvedAt: Date | null; resolvedBy: string | null; createdAt: Date; resolution: string | null
      _count: { messages: number }
      trade: { id: string; status: string; ref: string; buyer: { id: string; username: string | null }; seller: { id: string; username: string | null } }
    }
    let rows: Row[]
    if (market === 'usdt') {
      const r = await db.dispute.findMany({
        where: usdtWhere(filter), orderBy: { createdAt: 'desc' }, skip, take: limit,
        select: {
          id: true, status: true, reason: true, openedById: true, resolutionType: true, winner: true, escalatedAt: true,
          resolvedAt: true, resolvedBy: true, createdAt: true, resolution: true, _count: { select: { messages: true } },
          trade: { select: { id: true, status: true, orderRef: true, buyer: userSel, seller: userSel } },
        },
      })
      rows = r.map((d) => ({ ...d, reason: String(d.reason), trade: { id: d.trade.id, status: d.trade.status, ref: d.trade.orderRef, buyer: d.trade.buyer, seller: d.trade.seller } }))
    } else {
      const r = await db.ctmDispute.findMany({
        where: ctmWhere(filter), orderBy: { createdAt: 'desc' }, skip, take: limit,
        select: {
          id: true, status: true, reason: true, openedById: true, resolutionType: true, winner: true, escalatedAt: true,
          resolvedAt: true, resolvedBy: true, createdAt: true, resolution: true, _count: { select: { messages: true } },
          trade: { select: { id: true, status: true, tradeRef: true, displayRef: true, buyer: userSel, seller: userSel } },
        },
      })
      rows = r.map((d) => ({ ...d, reason: String(d.reason), trade: { id: d.trade.id, status: d.trade.status, ref: d.trade.displayRef ?? d.trade.tradeRef, buyer: d.trade.buyer, seller: d.trade.seller } }))
    }

    const userIds = [...new Set(rows.flatMap((r) => [r.trade.buyer.id, r.trade.seller.id]))]
    const resolverIds = [...new Set(rows.map((r) => r.resolvedBy).filter((x): x is string => !!x))]
    const [stats, resolvers] = await Promise.all([
      participantStats(userIds),
      resolverIds.length ? db.user.findMany({ where: { id: { in: resolverIds } }, select: { id: true, username: true } }) : Promise.resolve([]),
    ])
    const resolverName = new Map(resolvers.map((u) => [u.id, u.username ?? u.id]))

    const total = counts[filter]
    return reply.send({
      success: true,
      data: {
        market,
        filter,
        counts,
        rows: rows.map((r) => ({
          id: r.id,
          market,
          tradeId: r.trade.id,
          tradeRef: r.trade.ref,
          disputeStatus: r.status,
          resolutionType: r.resolutionType,
          winner: r.winner,
          tradeStatus: r.trade.status,
          reason: r.reason,
          buyer: { ...r.trade.buyer, stats: stats.get(r.trade.buyer.id) ?? emptyStats() },
          seller: { ...r.trade.seller, stats: stats.get(r.trade.seller.id) ?? emptyStats() },
          openedById: r.openedById,
          createdAt: r.createdAt,
          escalatedAt: r.escalatedAt,
          resolvedAt: r.resolvedAt,
          // The platform has no per-case assignment field; the resolver is the only reviewer on record.
          reviewer: r.resolvedBy ? (resolverName.get(r.resolvedBy) ?? r.resolvedBy) : null,
          resolution: r.resolution,
          evidenceCount: r._count.messages,
        })),
        pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
      },
    })
  })

  // GET /admin/disputes/overview/:market/:id — participants' dispute history + full timeline for one case
  app.get('/admin/disputes/overview/:market/:id', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { market, id } = req.params as { market: string; id: string }
    if (market !== 'usdt' && market !== 'ctm') throw new AppError('VALIDATION_ERROR', 'Unknown market', 400)

    const userSel = { select: { id: true, username: true } } as const
    const d = market === 'usdt'
      ? await db.dispute.findUnique({
          where: { id },
          include: { messages: { orderBy: { createdAt: 'asc' } }, trade: { select: { id: true, orderRef: true, status: true, buyer: userSel, seller: userSel } } },
        })
      : await db.ctmDispute.findUnique({
          where: { id },
          include: { messages: { orderBy: { createdAt: 'asc' } }, trade: { select: { id: true, tradeRef: true, displayRef: true, status: true, buyer: userSel, seller: userSel } } },
        })
    if (!d) throw new AppError('NOT_FOUND', 'Dispute not found', 404)

    const trade = d.trade as { id: string; status: string; buyer: { id: string; username: string | null }; seller: { id: string; username: string | null } } & Record<string, unknown>
    const nameOf = (uid: string) => (uid === trade.buyer.id ? trade.buyer.username : uid === trade.seller.id ? trade.seller.username : null) ?? null

    const [stats, audit] = await Promise.all([
      participantStats([trade.buyer.id, trade.seller.id]),
      db.auditLog.findMany({
        where: { targetId: { in: [d.id, trade.id] } },
        orderBy: { createdAt: 'asc' },
        take: 100,
        select: { id: true, action: true, createdAt: true, actor: { select: { username: true } } },
      }),
    ])

    type Ev = { at: Date; kind: 'opened' | 'escalated' | 'message' | 'resolved' | 'audit'; actor: string | null; text: string; evidenceUrl?: string | null }
    const events: Ev[] = []
    events.push({ at: d.createdAt, kind: 'opened', actor: nameOf(d.openedById) ?? 'Unknown user', text: `Dispute opened — ${String(d.reason).replace(/_/g, ' ')}` })
    if (d.escalatedAt) events.push({ at: d.escalatedAt, kind: 'escalated', actor: null, text: 'Escalated for senior review' })
    for (const m of d.messages) {
      events.push({ at: m.createdAt, kind: 'message', actor: nameOf(m.senderId) ?? 'Admin / system', text: m.message, evidenceUrl: m.evidenceUrl })
    }
    if (d.resolvedAt) {
      events.push({ at: d.resolvedAt, kind: 'resolved', actor: null, text: `${d.resolutionType ? String(d.resolutionType).replace(/_/g, ' ') : 'resolved'}${d.resolution ? ` — ${d.resolution}` : ''}` })
    }
    for (const a of audit) events.push({ at: a.createdAt, kind: 'audit', actor: a.actor.username ?? 'admin', text: a.action.replace(/[._]/g, ' ') })
    events.sort((a, b) => a.at.getTime() - b.at.getTime())

    return reply.send({
      success: true,
      data: {
        market,
        disputeStatus: d.status,
        tradeStatus: trade.status,
        resolutionType: d.resolutionType,
        winner: d.winner,
        participants: [
          { role: 'buyer', ...trade.buyer, stats: stats.get(trade.buyer.id) ?? emptyStats() },
          { role: 'seller', ...trade.seller, stats: stats.get(trade.seller.id) ?? emptyStats() },
        ],
        timeline: events,
      },
    })
  })
}
