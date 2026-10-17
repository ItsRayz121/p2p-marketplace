import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'

/**
 * Real-database checks for the P2P USDT import, its profit through the real engine, the dispute rules and the
 * Telegram clean-up queries. Skipped unless TEST_DATABASE_URL is set; refuses any non-local database.
 * See vitest.integration.config.ts.
 */
const url = process.env.TEST_DATABASE_URL
const host = url ? (() => { try { return new URL(url).hostname } catch { return '' } })() : ''
if (url && !['localhost', '127.0.0.1', '::1'].includes(host)) throw new Error(`Refusing to run integration tests against non-local database host "${host}"`)

const h = vi.hoisted(() => ({ client: null as unknown, tg: vi.fn() }))
vi.mock('../../lib/prisma', async () => {
  const { PrismaClient: P } = await import('@prisma/client')
  const client = process.env.TEST_DATABASE_URL ? new P({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } }) : (null as never)
  h.client = client
  return { db: client }
})
vi.mock('../../lib/telegram.client', () => ({ telegramRequest: h.tg }))
vi.mock('../../lib/env', () => ({ env: { NODE_ENV: 'test', CNIC_HASH_SECRET: 'integration-test-cnic-0123456789abc' } }))

import { runUsdtImport } from '../portfolioUsdtImport.service'
import { runTelegramMessageCleanup, recordTelegramMessage } from '../../lib/telegram.messageLog'
import { buildSummary, type EventRow } from '../../lib/portfolio/summaryBuilder'
import { impliedUsdtRate } from '../../lib/portfolio/usdtImport'
import { platformMarksFor } from '../portfolioMarks.service'

const LIMITS = { dryRun: false, maxAssets: 200, maxEvents: 5000 }

describe.skipIf(!url)('P2P USDT import and Telegram clean-up against a real database', () => {
  const db = () => h.client as PrismaClient
  const tag = Math.random().toString(36).slice(2, 8)
  const ids: { me: string; other: string; ad: string } = { me: '', other: '', ad: '' }
  let n = 0

  beforeAll(async () => {
    const mk = async (k: string) => (await db().user.create({ data: { email: `${k}-${tag}@example.test`, fullName: k, username: `${k}_${tag}`, passwordHash: 'x', isEmailVerified: true } as never })).id
    ids.me = await mk('me'); ids.other = await mk('other')
    ids.ad = (await db().ad.create({
      data: { userId: ids.other, side: 'sell', coin: 'USDT', network: 'BEP20', price: 281, totalAmount: 100000, availableAmount: 100000, minOrder: 100, maxOrder: 100000, paymentMethods: ['bank'], tokenDeliveryTypes: ['wallet'] } as never,
    })).id
  })

  afterAll(async () => {
    await db().telegramSentMessage.deleteMany({})
    await db().portfolioEvent.deleteMany({ where: { userId: { in: [ids.me, ids.other] } } })
    await db().portfolioAsset.deleteMany({ where: { userId: { in: [ids.me, ids.other] } } })
    await db().dispute.deleteMany({ where: { trade: { adId: ids.ad } } })
    await db().trade.deleteMany({ where: { adId: ids.ad } })
    await db().ad.delete({ where: { id: ids.ad } })
    await db().user.deleteMany({ where: { id: { in: [ids.me, ids.other] } } })
    await db().$disconnect()
  })

  const makeTrade = async (o: { buyer?: string; seller?: string; amount: number; fiat: number; status?: string; releasedAt?: Date | null; coin?: string }) =>
    db().trade.create({
      data: {
        orderRef: `RC-${tag}-${++n}`, adId: ids.ad, buyerId: o.buyer ?? ids.me, sellerId: o.seller ?? ids.other, coin: o.coin ?? 'USDT', network: 'BEP20',
        amount: o.amount, price: o.fiat / o.amount, fiatAmount: o.fiat, paymentMethod: 'bank', status: o.status ?? 'crypto_released',
        releasedAt: o.releasedAt === undefined ? new Date() : o.releasedAt, expiresAt: new Date(Date.now() + 3600_000),
      } as never,
    })
  const events = async (userId: string) => db().portfolioEvent.findMany({ where: { userId, source: 'p2p' }, orderBy: { occurredAt: 'asc' } })

  it('buy 100 at 281 then sell 100 at 285 is imported and shows PKR 400 profit, read back from the database', async () => {
    await makeTrade({ buyer: ids.me, seller: ids.other, amount: 100, fiat: 28100, releasedAt: new Date('2026-10-01T10:00:00Z') })
    await makeTrade({ buyer: ids.other, seller: ids.me, amount: 100, fiat: 28500, releasedAt: new Date('2026-10-02T10:00:00Z') })
    await makeTrade({ buyer: ids.me, seller: ids.other, amount: 5, fiat: 1500, status: 'payment_confirmed', releasedAt: null }) // still pending
    await makeTrade({ buyer: ids.me, seller: ids.other, amount: 5, fiat: 1500, coin: 'BTC' }) // not USDT

    const dry = await runUsdtImport(ids.me, { ...LIMITS, dryRun: true })
    expect(dry.created).toBe(2)
    expect(await db().portfolioEvent.count({ where: { userId: ids.me } })).toBe(0) // a dry run writes nothing

    const r = await runUsdtImport(ids.me, LIMITS)
    expect(r).toMatchObject({ created: 2, hasImportedBefore: true })
    const again = await runUsdtImport(ids.me, LIMITS)
    expect(again).toMatchObject({ created: 0, alreadyImported: 2 }) // idempotent, enforced by the unique key too

    const asset = await db().portfolioAsset.findFirst({ where: { userId: ids.me, ctmTokenId: 'p2p-usdt' } })
    expect(asset).toMatchObject({ name: 'Tether USDT', symbol: 'USDT' })
    const evs = await events(ids.me)
    expect(evs.map((e) => [e.type, e.quantity.toFixed(), e.consideration!.toFixed(), e.fxRate!.toFixed()])).toEqual([
      ['BUY', '100', '28100', '281'], ['SELL', '100', '28500', '285'],
    ])
    expect(evs.every((e) => e.source === 'p2p' && e.fee!.toFixed() === '0')).toBe(true)

    const rows: EventRow[] = evs.map((e) => ({
      id: e.id, assetId: e.assetId, type: e.type as 'BUY' | 'SELL', occurredAt: e.occurredAt, quantity: e.quantity.toFixed(), consideration: e.consideration!.toFixed(),
      fee: e.fee!.toFixed(), basis: null, zeroCost: false, quote: 'PKR', fxRate: e.fxRate!.toFixed(),
    }))
    const marks = await platformMarksFor([{ id: asset!.id, ctmTokenId: 'p2p-usdt' }])
    expect(marks[0]).toMatchObject({ price: '1', quote: 'USDT' })
    const pkr = buildSummary({ events: rows, prices: marks, currency: 'PKR', platformRate: '283' })
    expect(pkr.summary.knownRealized).toBe('400')
    expect(buildSummary({ events: rows, prices: marks, currency: 'USDT', platformRate: '283' }).summary.knownRealized).toBe('0')

    // The seller's side sees the mirror image, from the same two trades.
    await runUsdtImport(ids.other, LIMITS)
    expect((await events(ids.other)).map((e) => e.type)).toEqual(['SELL', 'BUY'])
  })

  it('mixes platform trades with an outside purchase by FIFO: 100@281 + 50@279 outside, sell 120@285 = PKR 520', async () => {
    const user = (await db().user.create({ data: { email: `mix-${tag}@example.test`, fullName: 'mix', username: `mix_${tag}`, passwordHash: 'x', isEmailVerified: true } as never })).id
    await makeTrade({ buyer: user, seller: ids.other, amount: 100, fiat: 28100, releasedAt: new Date('2026-10-01T10:00:00Z') })
    await makeTrade({ buyer: ids.other, seller: user, amount: 120, fiat: 34200, releasedAt: new Date('2026-10-03T10:00:00Z') })
    await runUsdtImport(user, LIMITS)
    const asset = (await db().portfolioAsset.findFirst({ where: { userId: user } }))!
    await db().portfolioEvent.create({ data: { userId: user, assetId: asset.id, type: 'BUY', occurredAt: new Date('2026-10-02T10:00:00Z'), quantity: 50, consideration: 13950, fee: 0, quote: 'PKR', source: 'manual' } as never })
    const all = await db().portfolioEvent.findMany({ where: { userId: user }, orderBy: { occurredAt: 'asc' } })
    const rows: EventRow[] = all.map((e) => ({
      id: e.id, assetId: e.assetId, type: e.type as 'BUY' | 'SELL', occurredAt: e.occurredAt, quantity: e.quantity.toFixed(), consideration: e.consideration!.toFixed(),
      fee: e.fee!.toFixed(), basis: null, zeroCost: false, quote: 'PKR',
      fxRate: e.fxRate?.toFixed() ?? impliedUsdtRate(e.consideration!.toFixed(), e.quantity.toFixed()),
    }))
    const s = buildSummary({ events: rows, prices: await platformMarksFor([{ id: asset.id, ctmTokenId: 'p2p-usdt' }]), currency: 'PKR', platformRate: '280' })
    expect(s.summary.knownRealized).toBe('520')
    expect(s.summary.positions[0]).toMatchObject({ quantity: '30', knownRemainingBasis: '8370', unrealized: '30' })
    await db().portfolioEvent.deleteMany({ where: { userId: user } })
    await db().portfolioAsset.deleteMany({ where: { userId: user } })
    await db().trade.deleteMany({ where: { OR: [{ buyerId: user }, { sellerId: user }] } })
    await db().user.delete({ where: { id: user } })
  })

  it('disputes: open stays out; once resolved it is added (buyer wins at the ruling date, no-fault when completed); seller wins and a split are not', async () => {
    const user = (await db().user.create({ data: { email: `disp-${tag}@example.test`, fullName: 'disp', username: `disp_${tag}`, passwordHash: 'x', isEmailVerified: true } as never })).id
    const resolvedAt = new Date('2026-10-05T12:00:00Z')
    const dispute = (tradeId: string, status: string, resolutionType: string | null) =>
      db().dispute.create({ data: { tradeId, openedById: user, reason: 'r', description: 'd', status, resolutionType, resolvedAt: status === 'resolved' ? resolvedAt : null } as never })
    const open = await makeTrade({ buyer: user, amount: 10, fiat: 2810, status: 'disputed', releasedAt: null }); await dispute(open.id, 'under_review', null)
    const buyerWins = await makeTrade({ buyer: user, amount: 20, fiat: 5620, status: 'dispute_resolved', releasedAt: null }); await dispute(buyerWins.id, 'resolved', 'buyer_wins')
    const sellerWins = await makeTrade({ buyer: user, amount: 30, fiat: 8430, status: 'dispute_resolved', releasedAt: null }); await dispute(sellerWins.id, 'resolved', 'seller_wins')
    const split = await makeTrade({ buyer: user, amount: 40, fiat: 11240, status: 'dispute_resolved', releasedAt: null }); await dispute(split.id, 'resolved', 'split')
    const settled = await makeTrade({ buyer: user, amount: 50, fiat: 14050, releasedAt: new Date('2026-10-04T00:00:00Z') }); await dispute(settled.id, 'resolved', 'settled_by_parties')

    await runUsdtImport(user, LIMITS)
    const got = await events(user)
    expect(got.map((e) => e.sourceRef).sort()).toEqual([buyerWins.id, settled.id].sort())
    expect(got.find((e) => e.sourceRef === buyerWins.id)!.occurredAt).toEqual(resolvedAt)

    // The open dispute is resolved for the buyer later: the next sync adds it, without a second copy of the others.
    await db().dispute.update({ where: { tradeId: open.id }, data: { status: 'resolved', resolutionType: 'buyer_wins', resolvedAt } })
    await db().trade.update({ where: { id: open.id }, data: { status: 'dispute_resolved' } })
    expect(await runUsdtImport(user, LIMITS)).toMatchObject({ created: 1, alreadyImported: 2 })

    // A ruling that later turns out to be for the seller voids the entry (kept, but not counted).
    await db().dispute.update({ where: { tradeId: buyerWins.id }, data: { resolutionType: 'seller_wins' } })
    expect(await runUsdtImport(user, LIMITS)).toMatchObject({ voided: 1 })
    expect((await db().portfolioEvent.findFirst({ where: { userId: user, sourceRef: buyerWins.id } }))!.voidedAt).not.toBeNull()

    await db().portfolioEvent.deleteMany({ where: { userId: user } })
    await db().portfolioAsset.deleteMany({ where: { userId: user } })
    await db().dispute.deleteMany({ where: { openedById: user } })
    await db().trade.deleteMany({ where: { buyerId: user } })
    await db().user.delete({ where: { id: user } })
  })

  it('Telegram clean-up: deletes messages of a finished trade, keeps pending and disputed ones, and every query is valid', async () => {
    const done = await makeTrade({ amount: 10, fiat: 2810, releasedAt: new Date(Date.now() - 3 * 3600_000) })
    const pending = await makeTrade({ amount: 10, fiat: 2810, status: 'payment_uploaded', releasedAt: null })
    const disputed = await makeTrade({ amount: 10, fiat: 2810, releasedAt: new Date(Date.now() - 3 * 3600_000) })
    await db().dispute.create({ data: { tradeId: disputed.id, openedById: ids.me, reason: 'r', description: 'd', status: 'open' } as never })
    h.tg.mockResolvedValue({ ok: true, blocked: false })
    const ok = { ok: true, blocked: false, result: { message_id: 1 } }
    await recordTelegramMessage(7n, { ...ok, result: { message_id: 11 } }, { kind: 'usdt', refKey: done.id })
    await recordTelegramMessage(7n, { ...ok, result: { message_id: 12 } }, { kind: 'usdt', refKey: pending.id })
    await recordTelegramMessage(7n, { ...ok, result: { message_id: 13 } }, { kind: 'usdt', refKey: disputed.id })
    await recordTelegramMessage(7n, { ...ok, result: { message_id: 14 } }, { kind: 'ctm', refKey: 'no-such-ref' })
    await recordTelegramMessage(7n, { ...ok, result: { message_id: 15 } }, { kind: 'gas', refKey: 'no-such-order' })
    // Make every message old enough to be past the delay (but inside Telegram's 48h window).
    await db().telegramSentMessage.updateMany({ data: { sentAt: new Date(Date.now() - 2 * 3600_000) } })

    expect(await runTelegramMessageCleanup()).toBe(1)
    expect(h.tg).toHaveBeenCalledTimes(1)
    expect(h.tg).toHaveBeenCalledWith('deleteMessage', { chat_id: '7', message_id: 11 })
    const left = (await db().telegramSentMessage.findMany({ select: { messageId: true } })).map((r) => r.messageId).sort((a, b) => a - b)
    expect(left).toEqual([12, 13, 14, 15])

    // Telegram refuses deletes after 48h, so older rows are simply forgotten.
    await db().telegramSentMessage.updateMany({ data: { sentAt: new Date(Date.now() - 50 * 3600_000) } })
    await runTelegramMessageCleanup()
    expect(await db().telegramSentMessage.count()).toBe(0)
  })
})
