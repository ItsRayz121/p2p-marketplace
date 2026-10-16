import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { db } from '../lib/prisma'
import { AppError } from '../lib/errors'
import { validateCustomAsset, type CustomAssetInput } from '../lib/portfolioAsset'
import { eventSchema, cleanNote, PRICE_SOURCES } from '../lib/portfolio/eventInput'
import { cleanRate } from '../lib/portfolio/currency'
import { checkExcludedTradeRecordable, ensureLinkedAsset } from './portfolioImport.service'

/**
 * Restore a portfolio backup into the signed-in account.
 *
 * Reads and writes ONLY the caller's own portfolio tables (assets, entries, prices, correction history).
 * The one read outside them is the same read-only trade check the "record a left-out trade" screen
 * already uses. Wallet, deposits, orders and settlement are never touched.
 *
 * Safe to run twice: anything already there is skipped, never duplicated. The file is validated in
 * full first and the writes happen in one transaction, so a bad file or a failure changes nothing.
 */

export interface RestoreLimits {
  maxAssets: number
  maxEvents: number
  maxRevisionsPerEvent: number
  maxRevisionsPerUser: number
}

export interface RestoreResult {
  assets: { created: number; alreadyThere: number }
  entries: { restored: number; alreadyThere: number; notRestored: number }
  prices: { restored: number; alreadyThere: number }
  history: { restored: number; alreadyThere: number; notRestored: number }
  /** Why some entries were not restored, in words a person can read. */
  notes: string[]
}

const MAX_TRADE_LINKED = 200

const dec = z.string().regex(/^\d{1,28}(\.\d{1,18})?$/)
const iso = z.string().datetime({ offset: true })
const text = (max: number) => z.string().max(max)
const quote = z.enum(['PKR', 'USDT'])

const assetSchema = z.object({
  id: text(64), name: text(200), symbol: text(64).nullable(), sourceUrl: text(2048).nullable(), network: text(100).nullable(),
  contractAddress: text(200).nullable(), createdAt: iso, archivedAt: iso.nullable(),
  linkedToRupChainToken: z.boolean().optional(),
}).strict()

const entrySchema = z.object({
  id: text(64), assetId: text(64), type: z.enum(['BUY', 'SELL', 'OPENING']), occurredAt: iso, quantity: dec,
  consideration: dec.nullable(), fee: dec.nullable(), basis: dec.nullable(), zeroCost: z.boolean(), quote,
  fxRate: z.string().regex(/^\d{1,10}(\.\d{1,18})?$/).nullable(), fxSource: z.enum(['platform', 'manual']).nullable(),
  note: text(1000).nullable(), source: z.enum(['manual', 'ctm']), voided: z.boolean(), voidReason: text(60).nullable(),
  priceBasis: z.enum(['platform', 'own']).nullable().optional(),
  editedAt: iso.nullable().optional(), linkedTradeRef: text(64).nullable().optional(),
}).strict()

const priceSchema = z.object({ assetId: text(64), price: dec, quote, observedAt: iso, source: z.enum(PRICE_SOURCES).optional() }).strict()

const nullableText = text(64).nullable()
const revisionSchema = z.object({
  eventId: text(40), assetId: text(64), action: z.enum(['edit', 'delete']), createdAt: iso,
  before: z.object({
    type: nullableText.optional(), occurredAt: nullableText.optional(), quantity: nullableText.optional(),
    consideration: nullableText.optional(), fee: nullableText.optional(), basis: nullableText.optional(),
    zeroCost: z.boolean().optional(), quote: nullableText.optional(), fxRate: nullableText.optional(),
    fxSource: nullableText.optional(), note: text(1000).nullable().optional(), priceBasis: nullableText.optional(),
  }),
}).strict()

const backupSchema = z.object({
  format: z.literal('rupchain-portfolio-backup'),
  version: z.union([z.literal(1), z.literal(2)]),
  exportedAt: iso,
  assets: z.array(assetSchema).max(200),
  events: z.array(entrySchema).max(5000),
  prices: z.array(priceSchema).max(5000),
  revisions: z.array(revisionSchema).max(5000).optional(),
}).strict()

type Backup = z.infer<typeof backupSchema>

const bad = (message: string) => new AppError('VALIDATION_ERROR', message, 400)
const newId = () => `c${randomBytes(12).toString('hex')}`
/** Stable per (account, backup entry): restoring the same file twice finds the entry already there. */
const requestIdFor = (userId: string, oldId: string) => `rst-${createHash('sha256').update(`${userId}:${oldId}`).digest('hex').slice(0, 40)}`
const same = (v: string | null | undefined) => v ?? ''

type BackupAsset = z.infer<typeof assetSchema>
function assetInput(a: BackupAsset): CustomAssetInput {
  const i: CustomAssetInput = { name: a.name }
  if (a.symbol !== null) i.symbol = a.symbol
  if (a.sourceUrl !== null) i.sourceUrl = a.sourceUrl
  if (a.network !== null) i.network = a.network
  if (a.contractAddress !== null) i.contractAddress = a.contractAddress
  return i
}

/** Whole-file checks. Nothing is partly accepted: the first problem rejects the file. */
function validate(raw: unknown): Backup {
  const r = backupSchema.safeParse(raw)
  if (!r.success) {
    const i = r.error.issues[0]
    const where = i && i.path.length ? ` (${i.path.join('.')})` : ''
    throw bad(`This file is not a valid RupChain portfolio backup${where}.`)
  }
  const b = r.data
  const assetIds = new Set<string>()
  for (const a of b.assets) {
    if (assetIds.has(a.id)) throw bad('This backup lists the same token twice.')
    assetIds.add(a.id)
    if (a.linkedToRupChainToken) continue // re-derived from RupChain's own record of the token
    const v = validateCustomAsset(assetInput(a))
    if (!v.ok || v.value.name !== a.name) throw bad('This backup contains a token with invalid or unsafe details.')
  }
  const eventIds = new Set<string>()
  b.events.forEach((e, i) => {
    if (eventIds.has(e.id)) throw bad('This backup lists the same entry twice.')
    eventIds.add(e.id)
    if (!assetIds.has(e.assetId)) throw bad(`Entry ${i + 1} points at a token that is not in the file.`)
    if (e.source !== 'manual') return // trades read from RupChain are rebuilt from the platform's own records
    const p = eventSchema.safeParse({
      type: e.type, occurredAt: e.occurredAt, quantity: e.quantity, consideration: e.consideration, fee: e.fee, basis: e.basis,
      zeroCost: e.zeroCost, quote: e.quote, fxRate: e.fxRate, note: e.note, priceBasis: e.priceBasis ?? null,
    })
    if (!p.success) throw bad(`Entry ${i + 1} cannot be restored: ${p.error.issues[0]?.message ?? 'invalid values'}.`)
    if (e.fxRate !== null && cleanRate(e.fxRate) === null) throw bad(`Entry ${i + 1} has an invalid exchange rate.`)
  })
  for (const p of b.prices) if (!assetIds.has(p.assetId)) throw bad('A price in this file points at a token that is not in the file.')
  for (const rv of b.revisions ?? []) if (!assetIds.has(rv.assetId)) throw bad('A correction record points at a token that is not in the file.')
  if (b.events.filter((e) => e.source === 'manual' && e.linkedTradeRef).length > MAX_TRADE_LINKED) {
    throw bad('This backup has too many entries tied to RupChain trades.')
  }
  return b
}

export async function restorePortfolioBackup(userId: string, raw: unknown, limits: RestoreLimits): Promise<RestoreResult> {
  const b = validate(raw)
  const notes: string[] = []
  const manual = b.events.filter((e) => e.source === 'manual')

  // ── Read-only preparation (before anything is written) ──
  // An entry recorded for a RupChain trade is restored only if that trade is still one the platform lets you record
  // by hand (yours, finished, and not already counted automatically): otherwise it could be counted twice.
  const tradeTarget = new Map<string, string>() // backup event id -> account asset id
  for (const e of manual) {
    if (!e.linkedTradeRef) continue
    const check = await checkExcludedTradeRecordable(userId, e.linkedTradeRef)
    if (!check.ok || check.side !== e.type) continue
    const id = await ensureLinkedAsset(userId, check.token, { maxAssets: limits.maxAssets })
    if (id) tradeTarget.set(e.id, id)
  }

  const result = await db.$transaction(async (tx) => {
    // One restore per account at a time: a double click or two tabs would otherwise both pass the
    // "already there" checks and create the same token twice. Released automatically at the end of the transaction.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`portfolio-restore:${userId}`}))`
    // ── Tokens ──
    const mine = await tx.portfolioAsset.findMany({
      where: { userId }, select: { id: true, name: true, symbol: true, network: true, contractAddress: true, createdAt: true, ctmTokenId: true },
    })
    const target = new Map<string, string>() // backup asset id -> account asset id (all tokens that have a home)
    const toCreate: Prisma.PortfolioAssetCreateManyInput[] = []
    let assetsAlready = 0
    for (const a of b.assets) {
      // Tokens that mirror a RupChain token are rebuilt by the trade import; entries on them come back only through their trade link.
      if (a.linkedToRupChainToken) continue
      const hit = mine.find((m) => m.id === a.id)
        ?? mine.find((m) => m.ctmTokenId === null && m.name === a.name && same(m.symbol) === same(a.symbol) && same(m.network) === same(a.network)
          && same(m.contractAddress) === same(a.contractAddress) && m.createdAt.getTime() === Date.parse(a.createdAt))
      if (hit) { target.set(a.id, hit.id); assetsAlready += 1; continue }
      const v = validateCustomAsset(assetInput(a))
      if (!v.ok) throw bad('This backup contains a token with invalid or unsafe details.')
      const id = newId()
      target.set(a.id, id)
      toCreate.push({ id, userId, ...v.value, createdAt: new Date(a.createdAt), archivedAt: a.archivedAt ? new Date(a.archivedAt) : null })
    }
    if (mine.length + toCreate.length > limits.maxAssets) throw new AppError('PORTFOLIO_ASSET_LIMIT', `Restoring would go over the limit of ${limits.maxAssets} tokens. Nothing was changed.`, 400)
    if (toCreate.length) await tx.portfolioAsset.createMany({ data: toCreate })

    // ── Entries ──
    const reqIds = manual.map((e) => requestIdFor(userId, e.id))
    const there = await tx.portfolioEvent.findMany({
      where: { userId, OR: [{ id: { in: manual.map((e) => e.id) } }, { clientRequestId: { in: reqIds } }] },
      select: { id: true, clientRequestId: true },
    })
    const thereIds = new Set(there.flatMap((r) => [r.id, r.clientRequestId ?? '']))
    const linkedHave = new Set((await tx.portfolioEvent.findMany({ where: { userId, linkedTradeRef: { not: null } }, select: { linkedTradeRef: true } })).map((r) => r.linkedTradeRef))
    const newEventId = new Map<string, string>() // backup entry id -> account entry id (created now)
    const rows: Prisma.PortfolioEventCreateManyInput[] = []
    let entriesAlready = 0, tradeSkipped = 0, noHome = 0
    for (const e of manual) {
      const rid = requestIdFor(userId, e.id)
      if (thereIds.has(e.id) || thereIds.has(rid)) { entriesAlready += 1; continue }
      let assetId = target.get(e.assetId)
      if (e.linkedTradeRef) {
        assetId = tradeTarget.get(e.id)
        if (linkedHave.has(e.linkedTradeRef)) { entriesAlready += 1; continue }
      }
      if (!assetId) { if (e.linkedTradeRef) tradeSkipped += 1; else noHome += 1; continue }
      const id = newId()
      newEventId.set(e.id, id)
      const rate = e.fxRate !== null ? cleanRate(e.fxRate) : null
      rows.push({
        id, userId, assetId, type: e.type, occurredAt: new Date(e.occurredAt), quantity: e.quantity,
        consideration: e.type === 'OPENING' ? null : e.consideration,
        fee: e.type === 'OPENING' ? null : (e.fee ?? '0'),
        basis: e.type === 'OPENING' ? e.basis : null,
        zeroCost: e.type === 'OPENING' ? e.zeroCost : false,
        quote: e.quote, fxRate: rate, fxSource: rate ? e.fxSource : null, note: cleanNote(e.note),
        priceBasis: e.type === 'OPENING' ? null : (e.priceBasis ?? null),
        editedAt: e.editedAt ? new Date(e.editedAt) : null,
        linkedTradeRef: e.linkedTradeRef ?? null,
        clientRequestId: rid,
      })
    }
    const eventCount = await tx.portfolioEvent.count({ where: { userId } })
    if (eventCount + rows.length > limits.maxEvents) throw new AppError('PORTFOLIO_EVENT_LIMIT', `Restoring would go over the limit of ${limits.maxEvents} entries. Nothing was changed.`, 400)
    let restoredEntries = 0
    if (rows.length) restoredEntries = (await tx.portfolioEvent.createMany({ data: rows, skipDuplicates: true })).count

    // ── Prices ──
    const homes = Array.from(new Set(b.prices.map((p) => target.get(p.assetId)).filter((x): x is string => Boolean(x))))
    const haveP = homes.length
      ? await tx.portfolioPriceObservation.findMany({ where: { userId, assetId: { in: homes } }, select: { assetId: true, price: true, quote: true, observedAt: true } })
      : []
    const pKey = (assetId: string, price: string, q: string, at: number) => `${assetId}|${price}|${q}|${at}`
    const havePrices = new Set(haveP.map((p) => pKey(p.assetId, p.price.toFixed(), p.quote, p.observedAt.getTime())))
    const priceRows: Prisma.PortfolioPriceObservationCreateManyInput[] = []
    let pricesAlready = 0
    for (const p of b.prices) {
      const assetId = target.get(p.assetId)
      if (!assetId) continue
      const k = pKey(assetId, new Prisma.Decimal(p.price).toFixed(), p.quote, Date.parse(p.observedAt))
      if (havePrices.has(k)) { pricesAlready += 1; continue }
      havePrices.add(k)
      priceRows.push({ userId, assetId, price: p.price, quote: p.quote, source: p.source ?? 'manual', observedAt: new Date(p.observedAt) })
    }
    const priceCount = await tx.portfolioPriceObservation.count({ where: { userId } })
    if (priceCount + priceRows.length > limits.maxEvents) throw new AppError('PORTFOLIO_PRICE_LIMIT', `Restoring would go over the limit of ${limits.maxEvents} price entries. Nothing was changed.`, 400)
    if (priceRows.length) await tx.portfolioPriceObservation.createMany({ data: priceRows })

    // ── Correction history ──
    // Kept for entries restored now, and for entries that were removed (their history is all that is left).
    // History of entries that are already in the account (or were not restored) is left as it is.
    const inFile = new Set(b.events.map((e) => e.id))
    const revs = (b.revisions ?? []).flatMap((r) => {
      const eventId = inFile.has(r.eventId) ? newEventId.get(r.eventId) : r.eventId
      const assetId = target.get(r.assetId)
      return eventId && assetId ? [{ ...r, eventId, assetId }] : []
    })
    const revEventIds = Array.from(new Set(revs.map((r) => r.eventId)))
    const haveRev = revEventIds.length
      ? await tx.portfolioEventRevision.findMany({ where: { userId, eventId: { in: revEventIds } }, select: { eventId: true, createdAt: true } })
      : []
    const haveRevKeys = new Set(haveRev.map((r) => `${r.eventId}|${r.createdAt.getTime()}`))
    const perEvent = new Map<string, number>()
    for (const r of haveRev) perEvent.set(r.eventId, (perEvent.get(r.eventId) ?? 0) + 1)
    let userRevs = await tx.portfolioEventRevision.count({ where: { userId } })
    const revRows: Prisma.PortfolioEventRevisionCreateManyInput[] = []
    let revAlready = 0, revNot = 0
    for (const r of revs) {
      const key = `${r.eventId}|${Date.parse(r.createdAt)}`
      if (haveRevKeys.has(key)) { revAlready += 1; continue }
      if ((perEvent.get(r.eventId) ?? 0) >= limits.maxRevisionsPerEvent || userRevs >= limits.maxRevisionsPerUser) { revNot += 1; continue }
      haveRevKeys.add(key)
      perEvent.set(r.eventId, (perEvent.get(r.eventId) ?? 0) + 1)
      userRevs += 1
      revRows.push({ userId, eventId: r.eventId, assetId: r.assetId, action: r.action, before: r.before, createdAt: new Date(r.createdAt) })
    }
    if (revRows.length) await tx.portfolioEventRevision.createMany({ data: revRows })

    return {
      assets: { created: toCreate.length, alreadyThere: assetsAlready },
      entries: { restored: restoredEntries, alreadyThere: entriesAlready, notRestored: tradeSkipped + noHome },
      tradeSkipped, noHome,
      prices: { restored: priceRows.length, alreadyThere: pricesAlready },
      history: { restored: revRows.length, alreadyThere: revAlready, notRestored: revNot },
    }
  }, { timeout: 60_000, maxWait: 10_000 })

  const skippedTrades = b.events.filter((e) => e.source === 'ctm').length
  if (skippedTrades > 0) notes.push(`${skippedTrades} ${skippedTrades === 1 ? 'entry' : 'entries'} read from RupChain trades ${skippedTrades === 1 ? 'was' : 'were'} not copied: they are rebuilt from the platform's own records.`)
  const { tradeSkipped, noHome, ...counts } = result
  if (tradeSkipped > 0) notes.push(`${tradeSkipped} ${tradeSkipped === 1 ? 'entry' : 'entries'} recorded for a RupChain trade could not be matched to that trade now, so ${tradeSkipped === 1 ? 'it was' : 'they were'} left out to avoid counting the trade twice.`)
  if (noHome > 0) notes.push(`${noHome} ${noHome === 1 ? 'entry' : 'entries'} could not be placed on a token and ${noHome === 1 ? 'was' : 'were'} left out.`)
  if (counts.history.notRestored > 0) notes.push(`${counts.history.notRestored} earlier version${counts.history.notRestored === 1 ? ' was' : 's were'} not restored because of the per-entry history limit.`)
  return { ...counts, notes }
}
