import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate } from '../middleware/auth.middleware'
import { db } from '../lib/prisma'
import { AppError, Errors } from '../lib/errors'
import { validateCustomAsset, type CustomAssetInput } from '../lib/portfolioAsset'
import { eventSchema, priceSchema, cleanNote } from '../lib/portfolio/eventInput'
import { summarizePortfolio, type TradeEvent, type Mark } from '../lib/portfolio/fifo'

/** Per-user cap so a client bug or abuse cannot grow this table without bound. */
export const MAX_PORTFOLIO_ASSETS = 200
export const MAX_PORTFOLIO_EVENTS = 5000

const EVENT_SELECT = {
  id: true, assetId: true, type: true, occurredAt: true, quantity: true, consideration: true,
  fee: true, basis: true, zeroCost: true, note: true, createdAt: true,
} as const

type EventRow = {
  id: string; assetId: string; type: string; occurredAt: Date
  quantity: { toFixed(): string }; consideration: { toFixed(): string } | null
  fee: { toFixed(): string } | null; basis: { toFixed(): string } | null
  zeroCost: boolean; note: string | null; createdAt: Date
}

/** Decimal columns leave the API as strings, never numbers. */
function eventDto(r: EventRow) {
  return {
    id: r.id,
    assetId: r.assetId,
    type: r.type,
    occurredAt: r.occurredAt.toISOString(),
    quantity: r.quantity.toFixed(),
    consideration: r.consideration?.toFixed() ?? null,
    fee: r.fee?.toFixed() ?? null,
    basis: r.basis?.toFixed() ?? null,
    zeroCost: r.zeroCost,
    note: r.note,
    createdAt: r.createdAt.toISOString(),
  }
}

// Shape only (type + a generous size bound so oversized input is cheap to reject). The real rules
// (charset, URL scheme, credentials, invisible characters, lengths in characters) live in
// validateCustomAsset, which is also what the client form runs.
const bodySchema = z.object({
  name: z.string().max(1000),
  symbol: z.string().max(1000).nullish(),
  sourceUrl: z.string().max(5000).nullish(),
  network: z.string().max(1000).nullish(),
  contractAddress: z.string().max(1000).nullish(),
}).strict()

const SELECT = {
  id: true, name: true, symbol: true, sourceUrl: true, network: true, contractAddress: true, createdAt: true,
} as const

function parseBody(body: unknown) {
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Invalid token details', 400)
  const d = parsed.data
  const input: CustomAssetInput = { name: d.name }
  if (d.symbol != null) input.symbol = d.symbol
  if (d.sourceUrl != null) input.sourceUrl = d.sourceUrl
  if (d.network != null) input.network = d.network
  if (d.contractAddress != null) input.contractAddress = d.contractAddress
  const r = validateCustomAsset(input)
  if (!r.ok) {
    const first = Object.values(r.errors)[0] ?? 'Invalid token details'
    throw new AppError('VALIDATION_ERROR', first, 400)
  }
  return r.value
}

/**
 * Portfolio (analytical shadow ledger). Everything here is scoped to the authenticated user and
 * never reads or writes Wallet, Transaction, orders or any settlement table.
 * Responses are marked no-store: this is private finance metadata.
 */
export async function portfolioRoutes(app: FastifyInstance) {
  app.addHook('onSend', async (_req, reply) => {
    reply.header('Cache-Control', 'private, no-store')
  })

  app.get('/portfolio/assets', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const items = await db.portfolioAsset.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      take: MAX_PORTFOLIO_ASSETS,
      select: SELECT,
    })
    return reply.send({ success: true, data: items })
  })

  // Same name / symbol / link as an existing token is allowed and creates a separate asset.
  app.post('/portfolio/assets', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const value = parseBody(req.body)
    const count = await db.portfolioAsset.count({ where: { userId } })
    if (count >= MAX_PORTFOLIO_ASSETS) {
      throw new AppError('PORTFOLIO_ASSET_LIMIT', `You can track up to ${MAX_PORTFOLIO_ASSETS} custom tokens`, 400)
    }
    const item = await db.portfolioAsset.create({ data: { userId, ...value }, select: SELECT })
    return reply.code(201).send({ success: true, data: item })
  })

  // Metadata only. This route cannot touch quantities, transactions, cost basis or P&L: it updates
  // display fields of one row that the caller owns, and nothing else.
  app.patch('/portfolio/assets/:id', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const { id } = req.params as { id: string }
    const value = parseBody(req.body)
    // updateMany scoped by userId: another user's id behaves exactly like a missing id (404),
    // so ids cannot be probed across accounts.
    const res = await db.portfolioAsset.updateMany({ where: { id, userId }, data: value })
    if (res.count === 0) throw Errors.NOT_FOUND('Token')
    const item = await db.portfolioAsset.findFirst({ where: { id, userId }, select: SELECT })
    if (!item) throw Errors.NOT_FOUND('Token')
    return reply.send({ success: true, data: item })
  })

  // ── Manual events (analytical records; never touch balances, orders or settlement) ──

  async function ownedAsset(userId: string, id: string) {
    const a = await db.portfolioAsset.findFirst({ where: { id, userId }, select: { id: true } })
    if (!a) throw Errors.NOT_FOUND('Token') // other users' ids look exactly like missing ones
    return a
  }

  app.get('/portfolio/assets/:id/events', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const { id } = req.params as { id: string }
    await ownedAsset(userId, id)
    const rows = await db.portfolioEvent.findMany({
      where: { userId, assetId: id },
      orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
      take: MAX_PORTFOLIO_EVENTS,
      select: EVENT_SELECT,
    })
    return reply.send({ success: true, data: rows.map(eventDto) })
  })

  app.post('/portfolio/assets/:id/events', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const { id } = req.params as { id: string }
    const parsed = eventSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid record', 400)
    }
    const e = parsed.data
    await ownedAsset(userId, id)

    // A retried submit (double click, flaky network) must not record the same event twice.
    if (e.clientRequestId) {
      const existing = await db.portfolioEvent.findFirst({
        where: { userId, clientRequestId: e.clientRequestId }, select: EVENT_SELECT,
      })
      if (existing) {
        if (existing.assetId !== id) throw Errors.CONFLICT('This request id was already used for a different token')
        return reply.send({ success: true, data: eventDto(existing) })
      }
    }

    const total = await db.portfolioEvent.count({ where: { userId } })
    if (total >= MAX_PORTFOLIO_EVENTS) {
      throw new AppError('PORTFOLIO_EVENT_LIMIT', `You can record up to ${MAX_PORTFOLIO_EVENTS} entries`, 400)
    }

    const row = await db.portfolioEvent.create({
      data: {
        userId,
        assetId: id,
        type: e.type,
        occurredAt: new Date(e.occurredAt),
        quantity: e.quantity,
        consideration: e.consideration ?? null,
        fee: e.type === 'OPENING' ? null : (e.fee ?? '0'),
        basis: e.type === 'OPENING' ? (e.basis ?? null) : null,
        zeroCost: e.type === 'OPENING' ? Boolean(e.zeroCost) : false,
        note: cleanNote(e.note),
        clientRequestId: e.clientRequestId ?? null,
      },
      select: EVENT_SELECT,
    })
    return reply.code(201).send({ success: true, data: eventDto(row) })
  })

  // Removes one of the caller's own manual records. Analytical only: nothing else is changed.
  app.delete('/portfolio/assets/:id/events/:eventId', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const { id, eventId } = req.params as { id: string; eventId: string }
    const res = await db.portfolioEvent.deleteMany({ where: { id: eventId, assetId: id, userId } })
    if (res.count === 0) throw Errors.NOT_FOUND('Entry')
    return reply.send({ success: true })
  })

  // Manual current price: a price observation, not a transaction.
  app.post('/portfolio/assets/:id/price', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const { id } = req.params as { id: string }
    const parsed = priceSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid price', 400)
    }
    await ownedAsset(userId, id)
    const row = await db.portfolioPriceObservation.create({
      data: { userId, assetId: id, price: parsed.data.price, source: 'manual' },
      select: { price: true, observedAt: true },
    })
    return reply.code(201).send({ success: true, data: { price: row.price.toFixed(), observedAt: row.observedAt.toISOString() } })
  })

  // FIFO summary over the caller's recorded events and latest manual prices. Unknown stays unknown.
  app.get('/portfolio/summary', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const [events, prices] = await Promise.all([
      db.portfolioEvent.findMany({
        where: { userId }, orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }], take: MAX_PORTFOLIO_EVENTS,
        select: EVENT_SELECT,
      }),
      db.portfolioPriceObservation.findMany({
        where: { userId }, orderBy: { observedAt: 'desc' }, distinct: ['assetId'],
        select: { assetId: true, price: true, observedAt: true },
      }),
    ])

    const trade: TradeEvent[] = events.map((r, i) => ({
      id: r.id,
      assetId: r.assetId,
      type: r.type as TradeEvent['type'],
      at: r.occurredAt.toISOString(),
      seq: i,
      quantity: r.quantity.toFixed(),
      ...(r.consideration != null ? { consideration: r.consideration.toFixed() } : {}),
      ...(r.fee != null ? { fee: r.fee.toFixed() } : {}),
      ...(r.type === 'OPENING' ? { basis: r.basis == null ? null : r.basis.toFixed(), zeroCost: r.zeroCost } : {}),
    }))
    const marks: Record<string, Mark> = {}
    const priceMeta: Record<string, { price: string; observedAt: string }> = {}
    for (const p of prices) {
      marks[p.assetId] = { price: p.price.toFixed() }
      priceMeta[p.assetId] = { price: p.price.toFixed(), observedAt: p.observedAt.toISOString() }
    }

    let summary
    try {
      summary = summarizePortfolio(trade, marks)
    } catch (err) {
      req.log.error({ err }, 'portfolio summary failed')
      throw new AppError('PORTFOLIO_CALC_FAILED', 'Could not calculate your portfolio. Please contact support.', 500)
    }
    return reply.send({
      success: true,
      data: { currency: 'PKR', method: 'FIFO', summary, prices: priceMeta, asOf: new Date().toISOString() },
    })
  })
}
