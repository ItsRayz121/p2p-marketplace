import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate } from '../middleware/auth.middleware'
import { db } from '../lib/prisma'
import { AppError, Errors } from '../lib/errors'
import { validateCustomAsset, type CustomAssetInput } from '../lib/portfolioAsset'
import { eventSchema, priceSchema, cleanNote } from '../lib/portfolio/eventInput'
import { buildSummary, type EventRow as SummaryEvent } from '../lib/portfolio/summaryBuilder'
import { chooseFxStamp, cleanRate, type Quote } from '../lib/portfolio/currency'
import { computePerformance, currentMarksIn } from '../lib/portfolio/performance'
import { getStringConfig } from '../services/platformFlags.service'
import { runCtmImport } from '../services/portfolioImport.service'
import { identityKey, MAX_ACTIVE_INTERESTS_PER_USER } from '../lib/portfolio/interest'
import { isPortfolioEnabled } from '../lib/portfolio/flag'

/** Per-user cap so a client bug or abuse cannot grow this table without bound. */
export const MAX_PORTFOLIO_ASSETS = 200
export const MAX_PORTFOLIO_EVENTS = 5000

const EVENT_SELECT = {
  id: true, assetId: true, type: true, occurredAt: true, quantity: true, consideration: true,
  fee: true, basis: true, zeroCost: true, quote: true, fxRate: true, fxSource: true, note: true, createdAt: true,
  source: true, voidedAt: true, voidReason: true,
} as const

type EventRow = {
  id: string; assetId: string; type: string; occurredAt: Date
  quantity: { toFixed(): string }; consideration: { toFixed(): string } | null
  fee: { toFixed(): string } | null; basis: { toFixed(): string } | null
  zeroCost: boolean; quote: string; fxRate: { toFixed(): string } | null; fxSource: string | null
  note: string | null; createdAt: Date
  source: string; voidedAt: Date | null; voidReason: string | null
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
    quote: r.quote,
    fxRate: r.fxRate?.toFixed() ?? null,
    fxSource: r.fxSource,
    note: r.note,
    /** 'manual' (typed by the user) or 'ctm' (read from a settled RupChain trade). Set by the server only. */
    source: r.source,
    /** An imported entry whose trade stopped qualifying: shown, but excluded from every calculation. */
    voided: r.voidedAt !== null,
    voidReason: r.voidReason,
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

const interestBody = z.object({ consent: z.literal(true) }).strict()

const importBody = z.object({ dryRun: z.boolean().optional() }).strict()

const currencyQuery = z.object({ currency: z.enum(['PKR', 'USDT']).default('PKR') })

const SELECT = {
  id: true, name: true, symbol: true, sourceUrl: true, network: true, contractAddress: true, createdAt: true, archivedAt: true,
} as const

const listQuery = z.object({ includeArchived: z.enum(['1', 'true']).optional() })

function assetDto<T extends { archivedAt: Date | null }>(a: T) {
  return { ...a, archivedAt: a.archivedAt ? a.archivedAt.toISOString() : null }
}

type DbEvent = {
  id: string; assetId: string; type: string; occurredAt: Date
  quantity: { toFixed(): string }; consideration: { toFixed(): string } | null
  fee: { toFixed(): string } | null; basis: { toFixed(): string } | null
  zeroCost: boolean; quote: string; fxRate: { toFixed(): string } | null
}

/** DB row -> plain strings for the pure calculation modules (rates validated, never trusted blindly). */
function toSummaryRow(r: DbEvent): SummaryEvent {
  return {
    id: r.id,
    assetId: r.assetId,
    type: r.type as SummaryEvent['type'],
    occurredAt: r.occurredAt,
    quantity: r.quantity.toFixed(),
    consideration: r.consideration?.toFixed() ?? null,
    fee: r.fee?.toFixed() ?? null,
    basis: r.basis?.toFixed() ?? null,
    zeroCost: r.zeroCost,
    quote: r.quote as Quote,
    fxRate: cleanRate(r.fxRate?.toFixed()),
  }
}

const MAX_RANGE_MS = 25 * 365 * 24 * 60 * 60 * 1000
const perfQuery = z.object({
  currency: z.enum(['PKR', 'USDT']).default('PKR'),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
})

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

  // Kill switch. When the feature is switched off every portfolio route answers 404, except the status
  // route the app uses to find out. Nothing is deleted; wallet, deposits and trading are not involved.
  app.addHook('onRequest', async (req) => {
    if (req.routeOptions?.url?.endsWith('/portfolio/status')) return
    if (!(await isPortfolioEnabled())) throw new AppError('PORTFOLIO_DISABLED', 'Portfolio is not available right now', 404)
  })

  app.get('/portfolio/status', { preHandler: [authenticate] }, async (_req, reply) => {
    return reply.send({ success: true, data: { enabled: await isPortfolioEnabled() } })
  })

  app.get('/portfolio/assets', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const q = listQuery.safeParse(req.query)
    if (!q.success) throw new AppError('VALIDATION_ERROR', 'Invalid query', 400)
    const items = await db.portfolioAsset.findMany({
      where: q.data.includeArchived ? { userId } : { userId, archivedAt: null },
      orderBy: { createdAt: 'asc' },
      take: MAX_PORTFOLIO_ASSETS,
      select: { ...SELECT, ctmTokenId: true },
    })
    const interested = new Set(
      (await db.portfolioListingInterest.findMany({ where: { userId, withdrawnAt: null }, select: { assetId: true } })).map((r) => r.assetId),
    )
    return reply.send({ success: true, data: items.map(({ ctmTokenId, ...a }) => ({ ...assetDto(a), listingInterest: interested.has(a.id), linkedToRupChainToken: Boolean(ctmTokenId) })) })
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
    return reply.code(201).send({ success: true, data: assetDto(item) })
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
    // Consent was given for ONE network+contract. If that identity changed, the consent no longer applies.
    const newKey = identityKey(item.network, item.contractAddress)
    await db.portfolioListingInterest.updateMany({
      where: { assetId: id, userId, withdrawnAt: null, ...(newKey ? { identityKey: { not: newKey } } : {}) },
      data: { withdrawnAt: new Date() },
    })
    return reply.send({ success: true, data: assetDto(item) })
  })

  // Archive keeps the token's history and its realized profit/loss in your totals; it only hides the token.
  app.post('/portfolio/assets/:id/archive', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const { id } = req.params as { id: string }
    const res = await db.portfolioAsset.updateMany({ where: { id, userId, archivedAt: null }, data: { archivedAt: new Date() } })
    if (res.count === 0) throw await missingOrAlready(userId, id, 'archived')
    return reply.send({ success: true })
  })

  app.post('/portfolio/assets/:id/unarchive', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const { id } = req.params as { id: string }
    const res = await db.portfolioAsset.updateMany({ where: { id, userId, archivedAt: { not: null } }, data: { archivedAt: null } })
    if (res.count === 0) throw await missingOrAlready(userId, id, 'not archived')
    return reply.send({ success: true })
  })

  // Delete is only for tokens with NO records (e.g. added by mistake). A token with history is archived
  // instead, so a delete can never erase the numbers behind your profit and loss.
  app.delete('/portfolio/assets/:id', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const { id } = req.params as { id: string }
    const found = await db.portfolioAsset.findFirst({ where: { id, userId }, select: { id: true } })
    if (!found) throw Errors.NOT_FOUND('Token')
    const records = await db.portfolioEvent.count({ where: { assetId: id, userId } })
    if (records > 0) {
      throw Errors.CONFLICT('This token has records. Archive it instead so your history is kept.')
    }
    await db.portfolioPriceObservation.deleteMany({ where: { assetId: id, userId } })
    // The relation filter makes this a no-op if a record was added in the meantime.
    const res = await db.portfolioAsset.deleteMany({ where: { id, userId, events: { none: {} } } })
    if (res.count === 0) throw Errors.CONFLICT('This token has records. Archive it instead so your history is kept.')
    return reply.send({ success: true })
  })

  // ── Manual events (analytical records; never touch balances, orders or settlement) ──

  async function ownedAsset(userId: string, id: string, opts: { allowArchived?: boolean } = {}) {
    const a = await db.portfolioAsset.findFirst({ where: { id, userId }, select: { id: true, archivedAt: true } })
    if (!a) throw Errors.NOT_FOUND('Token') // other users' ids look exactly like missing ones
    if (a.archivedAt && !opts.allowArchived) throw Errors.CONFLICT('This token is archived. Restore it before adding records.')
    return a
  }

  async function missingOrAlready(userId: string, id: string, state: string) {
    const a = await db.portfolioAsset.findFirst({ where: { id, userId }, select: { id: true } })
    return a ? Errors.CONFLICT(`This token is already ${state}.`) : Errors.NOT_FOUND('Token')
  }

  app.get('/portfolio/assets/:id/events', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const { id } = req.params as { id: string }
    await ownedAsset(userId, id, { allowArchived: true })
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

    // Currency + exchange rate. The platform rate is stamped only for records dated ~now; older
    // records need a rate typed by the user or they cannot be shown in the other currency.
    const stamp = chooseFxStamp({
      userRate: e.fxRate,
      platformRate: e.fxRate ? null : await getStringConfig('rate_USDT_PKR', ''),
      occurredAtMs: Date.parse(e.occurredAt),
      nowMs: Date.now(),
    })

    let row: EventRow
    try {
      row = await db.portfolioEvent.create({
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
        quote: e.quote ?? 'PKR',
        fxRate: stamp.fxRate,
        fxSource: stamp.fxSource,
        note: cleanNote(e.note),
        clientRequestId: e.clientRequestId ?? null,
      },
      select: EVENT_SELECT,
      })
    } catch (err) {
      // Two saves with the same request id at the same instant: the database's uniqueness rule lets
      // exactly one through. The other gets the entry that was saved, not an error.
      if (e.clientRequestId && (err as { code?: string }).code === 'P2002') {
        const saved = await db.portfolioEvent.findFirst({ where: { userId, clientRequestId: e.clientRequestId, assetId: id }, select: EVENT_SELECT })
        if (saved) return reply.send({ success: true, data: eventDto(saved) })
      }
      throw err
    }
    return reply.code(201).send({ success: true, data: eventDto(row) })
  })

  // Removes one of the caller's own manual records. Analytical only: nothing else is changed.
  app.delete('/portfolio/assets/:id/events/:eventId', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const { id, eventId } = req.params as { id: string; eventId: string }
    const entry = await db.portfolioEvent.findFirst({ where: { id: eventId, assetId: id, userId }, select: { id: true, source: true } })
    if (!entry) throw Errors.NOT_FOUND('Entry')
    // Entries read from a RupChain trade mirror a platform record and cannot be edited or removed here.
    if (entry.source !== 'manual') throw Errors.CONFLICT('This entry was imported from a RupChain trade and is read-only.')
    const res = await db.portfolioEvent.deleteMany({ where: { id: eventId, assetId: id, userId, source: 'manual' } })
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
    // Same per-user bound as entries, so price history cannot grow without limit.
    if ((await db.portfolioPriceObservation.count({ where: { userId } })) >= MAX_PORTFOLIO_EVENTS) {
      throw new AppError('PORTFOLIO_PRICE_LIMIT', `You can keep up to ${MAX_PORTFOLIO_EVENTS} price entries`, 400)
    }
    const row = await db.portfolioPriceObservation.create({
      data: { userId, assetId: id, price: parsed.data.price, quote: parsed.data.quote ?? 'PKR', source: 'manual' },
      select: { price: true, quote: true, observedAt: true },
    })
    return reply.code(201).send({ success: true, data: { price: row.price.toFixed(), quote: row.quote, observedAt: row.observedAt.toISOString() } })
  })

  // FIFO summary over the caller's recorded events and latest manual prices, in PKR or USDT.
  // Unknown stays unknown: a token whose records lack a usable exchange rate is left out and listed.
  app.get('/portfolio/summary', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const q = currencyQuery.safeParse(req.query)
    if (!q.success) throw new AppError('VALIDATION_ERROR', 'currency must be PKR or USDT', 400)

    const [events, prices, platformRate] = await Promise.all([
      db.portfolioEvent.findMany({
        where: { userId, voidedAt: null }, orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }], take: MAX_PORTFOLIO_EVENTS,
        select: EVENT_SELECT,
      }),
      db.portfolioPriceObservation.findMany({
        where: { userId }, orderBy: { observedAt: 'desc' }, distinct: ['assetId'],
        select: { assetId: true, price: true, quote: true, observedAt: true },
      }),
      getStringConfig('rate_USDT_PKR', ''),
    ])

    const rows = events.map(toSummaryRow)


    try {
      const data = buildSummary({
        events: rows,
        prices: prices.map((p) => ({ assetId: p.assetId, price: p.price.toFixed(), quote: p.quote as Quote, observedAt: p.observedAt })),
        currency: q.data.currency,
        platformRate,
      })
      return reply.send({ success: true, data })
    } catch (err) {
      req.log.error({ err }, 'portfolio summary failed')
      throw new AppError('PORTFOLIO_CALC_FAILED', 'Could not calculate your portfolio. Please contact support.', 500)
    }
  })
  // Charts and period results. History uses only entries and prices the user actually recorded:
  // gaps stay gaps, and an old price in another currency is never converted at today's rate.
  app.get('/portfolio/performance', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const q = perfQuery.safeParse(req.query)
    if (!q.success) throw new AppError('VALIDATION_ERROR', 'Invalid date range or currency', 400)

    const [events, prices, platformRate] = await Promise.all([
      db.portfolioEvent.findMany({
        where: { userId, voidedAt: null }, orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }], take: MAX_PORTFOLIO_EVENTS,
        select: EVENT_SELECT,
      }),
      db.portfolioPriceObservation.findMany({
        where: { userId }, orderBy: { observedAt: 'asc' }, take: MAX_PORTFOLIO_EVENTS,
        select: { assetId: true, price: true, quote: true, observedAt: true },
      }),
      getStringConfig('rate_USDT_PKR', ''),
    ])

    const now = new Date()
    const to = q.data.to ? new Date(q.data.to) : now
    const first = events[0]?.occurredAt
    const from = q.data.from ? new Date(q.data.from) : (first ?? to)
    if (from.getTime() > to.getTime()) throw new AppError('VALIDATION_ERROR', 'The start date must be before the end date', 400)
    if (to.getTime() - from.getTime() > MAX_RANGE_MS) throw new AppError('VALIDATION_ERROR', 'That date range is too long', 400)

    const priceRows = prices.map((p) => ({ assetId: p.assetId, price: p.price.toFixed(), quote: p.quote as Quote, observedAt: p.observedAt }))
    // Latest observation per asset (rows are ascending, so later ones overwrite earlier ones).
    const latest = new Map<string, (typeof priceRows)[number]>()
    for (const p of priceRows) latest.set(p.assetId, p)

    try {
      const data = computePerformance({
        events: events.map(toSummaryRow),
        prices: priceRows,
        currency: q.data.currency,
        currentMarks: currentMarksIn([...latest.values()], q.data.currency, cleanRate(platformRate)),
        from,
        to,
        now,
      })
      return reply.send({ success: true, data })
    } catch (err) {
      req.log.error({ err }, 'portfolio performance failed')
      throw new AppError('PORTFOLIO_CALC_FAILED', 'Could not calculate your portfolio. Please contact support.', 500)
    }
  })
  // Copy the caller's SETTLED RupChain trades into their tracker. One-way and read-only toward the
  // platform: it only reads trades and writes this user's own portfolio tables. `dryRun` previews.
  app.post('/portfolio/import/ctm', {
    preHandler: [authenticate],
    config: { rateLimit: { max: 12, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const userId = req.user!.id
    const body = importBody.safeParse(req.body ?? {})
    if (!body.success) throw new AppError('VALIDATION_ERROR', 'Invalid request', 400)
    try {
      const report = await runCtmImport(userId, {
        dryRun: body.data.dryRun ?? false,
        maxAssets: MAX_PORTFOLIO_ASSETS,
        maxEvents: MAX_PORTFOLIO_EVENTS,
      })
      return reply.send({ success: true, data: report })
    } catch (err) {
      req.log.error({ err }, 'portfolio import failed')
      throw new AppError('PORTFOLIO_IMPORT_FAILED', 'Could not read your RupChain trades right now. Please try again later.', 500)
    }
  })
  // Everything the caller has recorded, for CSV / JSON export. Includes archived tokens and voided
  // entries (flagged) so a backup is complete. Never includes another user's data or internal ids
  // of the source system.
  app.get('/portfolio/export', {
    preHandler: [authenticate],
    config: { rateLimit: { max: 6, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const userId = req.user!.id
    const [assets, events, prices] = await Promise.all([
      db.portfolioAsset.findMany({ where: { userId }, orderBy: { createdAt: 'asc' }, take: MAX_PORTFOLIO_ASSETS, select: { ...SELECT, ctmTokenId: true } }),
      db.portfolioEvent.findMany({
        where: { userId }, orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }], take: MAX_PORTFOLIO_EVENTS, select: EVENT_SELECT,
      }),
      db.portfolioPriceObservation.findMany({
        where: { userId }, orderBy: { observedAt: 'asc' }, take: MAX_PORTFOLIO_EVENTS,
        select: { assetId: true, price: true, quote: true, observedAt: true },
      }),
    ])
    return reply.send({
      success: true,
      data: {
        exportedAt: new Date().toISOString(),
        assets: assets.map(({ ctmTokenId, ...a }) => ({ ...assetDto(a), linkedToRupChainToken: ctmTokenId !== null })),
        // Exactly the documented backup fields (the backup reader is strict about unknown ones).
        events: events.map((e) => { const { createdAt, ...rest } = eventDto(e); void createdAt; return rest }),
        prices: prices.map((p) => ({ assetId: p.assetId, price: p.price.toFixed(), quote: p.quote, observedAt: p.observedAt.toISOString() })),
      },
    })
  })
  // ── Optional: "I would like this token listed on RupChain" ──
  // Explicit, withdrawable, and only for tokens with a known network + contract. It never lists
  // anything; admins only ever see anonymous aggregate groups above a minimum size.
  app.post('/portfolio/assets/:id/interest', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const { id } = req.params as { id: string }
    if (!interestBody.safeParse(req.body).success) throw new AppError('VALIDATION_ERROR', 'Consent must be given explicitly', 400)

    const asset = await db.portfolioAsset.findFirst({
      where: { id, userId },
      select: { id: true, name: true, network: true, contractAddress: true, ctmTokenId: true },
    })
    if (!asset) throw Errors.NOT_FOUND('Token')
    if (asset.ctmTokenId) throw Errors.CONFLICT('This token is already available on RupChain.')
    const key = identityKey(asset.network, asset.contractAddress)
    if (!key) throw new AppError('VALIDATION_ERROR', 'Add the network and contract address of this token first. A name alone cannot identify a token.', 400)

    const user = await db.user.findUnique({ where: { id: userId }, select: { isEmailVerified: true, isBanned: true } })
    if (!user || user.isBanned || !user.isEmailVerified) {
      throw new AppError('EMAIL_NOT_VERIFIED', 'Verify your email address to suggest a token.', 403)
    }

    // Already listed? Match on the same network + contract (hex addresses compare case-insensitively).
    const listed = await db.ctmToken.findFirst({
      where: {
        contractAddress: { equals: asset.contractAddress!, mode: 'insensitive' },
        network: { equals: asset.network!, mode: 'insensitive' },
      },
      select: { id: true },
    })
    if (listed) throw Errors.CONFLICT('This token is already available on RupChain.')

    const active = await db.portfolioListingInterest.count({ where: { userId, withdrawnAt: null } })
    const existing = await db.portfolioListingInterest.findFirst({ where: { userId, identityKey: key }, select: { id: true, withdrawnAt: true } })
    // Re-confirming an already-active suggestion is fine; a NEW one is capped per user.
    const alreadyActive = existing !== null && existing.withdrawnAt === null
    if (!alreadyActive && active >= MAX_ACTIVE_INTERESTS_PER_USER) {
      throw new AppError('INTEREST_LIMIT', `You can suggest up to ${MAX_ACTIVE_INTERESTS_PER_USER} tokens at a time`, 400)
    }

    await db.portfolioListingInterest.upsert({
      where: { userId_identityKey: { userId, identityKey: key } },
      create: { userId, assetId: asset.id, identityKey: key, displayName: asset.name },
      update: { assetId: asset.id, displayName: asset.name, consentedAt: new Date(), withdrawnAt: null },
    })
    return reply.send({ success: true, data: { listingInterest: true } })
  })

  app.delete('/portfolio/assets/:id/interest', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const { id } = req.params as { id: string }
    const res = await db.portfolioListingInterest.updateMany({ where: { assetId: id, userId, withdrawnAt: null }, data: { withdrawnAt: new Date() } })
    if (res.count === 0) throw Errors.NOT_FOUND('Suggestion')
    return reply.send({ success: true, data: { listingInterest: false } })
  })}
