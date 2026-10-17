import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'

/**
 * Real-database checks for the portfolio restore. Skipped unless TEST_DATABASE_URL is set, and it
 * refuses to run against anything but localhost, so it can never touch a shared or production database.
 * See vitest.integration.config.ts.
 */
const url = process.env.TEST_DATABASE_URL
const host = url ? (() => { try { return new URL(url).hostname } catch { return '' } })() : ''
const local = host === 'localhost' || host === '127.0.0.1' || host === '::1'
if (url && !local) throw new Error(`Refusing to run integration tests against non-local database host "${host}"`)

const h = vi.hoisted(() => ({ client: null as unknown }))
vi.mock('../../lib/prisma', async () => {
  const { PrismaClient: P } = await import('@prisma/client')
  const client = process.env.TEST_DATABASE_URL ? new P({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } }) : (null as never)
  h.client = client
  return { db: client }
})
// The real ensureLinkedAsset runs (it only touches the caller's portfolio tables); only the trade check is stubbed.
vi.mock('../portfolioImport.service', async (orig) => ({ ...(await orig<typeof import('../portfolioImport.service')>()), checkExcludedTradeRecordable: vi.fn() }))
vi.mock('../../lib/env', () => ({ env: { NODE_ENV: 'test', CNIC_HASH_SECRET: 'integration-test-cnic-0123456789abc' } }))

import { restorePortfolioBackup, type RestoreLimits } from '../portfolioRestore.service'
import { linkedTokenRef } from '../../lib/portfolio/linkedTokenRef'

const LIMITS: RestoreLimits = { maxAssets: 200, maxEvents: 5000, maxRevisionsPerEvent: 50, maxRevisionsPerUser: 20000 }
const past = '2026-09-01T10:00:00.000Z'
const backup = () => ({
  format: 'rupchain-portfolio-backup', version: 2, exportedAt: past,
  assets: [
    { id: 'a1', name: 'Alpha', symbol: 'ALP', sourceUrl: null, network: null, contractAddress: null, createdAt: '2026-01-01T00:00:00.000Z', archivedAt: null },
    { id: 'a2', name: 'Beta', symbol: null, sourceUrl: null, network: null, contractAddress: null, createdAt: '2026-01-02T00:00:00.000Z', archivedAt: '2026-08-01T00:00:00.000Z' },
  ],
  events: [
    { id: 'e1', assetId: 'a1', type: 'BUY', occurredAt: past, quantity: '10', consideration: '1000', fee: '5', basis: null, zeroCost: false, quote: 'PKR', fxRate: null, fxSource: null, note: 'one', source: 'manual', voided: false, voidReason: null, priceBasis: 'own', editedAt: '2026-09-02T00:00:00.000Z', linkedTradeRef: null },
    { id: 'e2', assetId: 'a2', type: 'OPENING', occurredAt: past, quantity: '3', consideration: null, fee: null, basis: '90', zeroCost: false, quote: 'PKR', fxRate: null, fxSource: null, note: null, source: 'manual', voided: false, voidReason: null, priceBasis: null, editedAt: null, linkedTradeRef: null },
  ],
  prices: [{ assetId: 'a1', price: '120', quote: 'PKR', observedAt: past, source: 'p2p' }],
  revisions: [
    { eventId: 'e1', assetId: 'a1', action: 'edit', createdAt: '2026-09-02T00:00:00.000Z', before: { type: 'BUY', quantity: '9' } },
    { eventId: 'gone', assetId: 'a1', action: 'delete', createdAt: '2026-09-03T00:00:00.000Z', before: { type: 'SELL', quantity: '1' } },
  ],
})

describe.skipIf(!url)('portfolio restore against a real database', () => {
  const db = () => h.client as PrismaClient
  const users: string[] = []
  const makeUser = async () => {
    const tag = Math.random().toString(36).slice(2, 10)
    const u = await db().user.create({ data: { email: `it-${tag}@example.test`, fullName: 'Integration', username: `it_${tag}`, passwordHash: 'x', isEmailVerified: true } as never })
    users.push(u.id)
    return u.id
  }
  const counts = async (userId: string) => ({
    assets: await db().portfolioAsset.count({ where: { userId } }),
    events: await db().portfolioEvent.count({ where: { userId } }),
    prices: await db().portfolioPriceObservation.count({ where: { userId } }),
    revisions: await db().portfolioEventRevision.count({ where: { userId } }),
  })

  beforeAll(async () => {
    await db().$connect()
    // Open several connections up front: a cold pool lets Prisma queue the calls one after another,
    // which would hide the very race this file exists to catch.
    await Promise.all(Array.from({ length: 10 }, () => db().$queryRaw`SELECT 1`))
  })
  afterAll(async () => {
    // Deleting a user removes everything it owns (cascade).
    for (const id of users) await db().user.delete({ where: { id } }).catch(() => {})
    await db().$disconnect()
  })

  it('restores everything with its original dates, edit time, archive state and price source', async () => {
    const u = await makeUser()
    await restorePortfolioBackup(u, backup(), LIMITS)
    expect(await counts(u)).toEqual({ assets: 2, events: 2, prices: 1, revisions: 2 })
    const beta = await db().portfolioAsset.findFirst({ where: { userId: u, name: 'Beta' } })
    expect(beta?.archivedAt?.toISOString()).toBe('2026-08-01T00:00:00.000Z')
    const e1 = await db().portfolioEvent.findFirst({ where: { userId: u, quantity: 10 as never } })
    expect(e1?.editedAt?.toISOString()).toBe('2026-09-02T00:00:00.000Z')
    expect((await db().portfolioPriceObservation.findFirst({ where: { userId: u } }))?.source).toBe('p2p')
  })

  it('running it again changes nothing', async () => {
    const u = await makeUser()
    await restorePortfolioBackup(u, backup(), LIMITS)
    const before = await counts(u)
    const second = await restorePortfolioBackup(u, backup(), LIMITS)
    expect(await counts(u)).toEqual(before)
    expect(second).toMatchObject({ assets: { created: 0 }, entries: { restored: 0 }, prices: { restored: 0 }, history: { restored: 0 } })
  })

  it('eight restores at the same moment create everything exactly once', async () => {
    const u = await makeUser()
    await Promise.all(Array.from({ length: 8 }, () => restorePortfolioBackup(u, backup(), LIMITS)))
    expect(await counts(u)).toEqual({ assets: 2, events: 2, prices: 1, revisions: 2 })
  })

  it('a rejected file and a limit failure leave the account exactly as it was', async () => {
    const u = await makeUser()
    await expect(restorePortfolioBackup(u, { ...backup(), events: [{ ...backup().events[0], quantity: 'x' }] }, LIMITS)).rejects.toMatchObject({ statusCode: 400 })
    await expect(restorePortfolioBackup(u, backup(), { ...LIMITS, maxEvents: 1 })).rejects.toMatchObject({ code: 'PORTFOLIO_EVENT_LIMIT' })
    expect(await counts(u)).toEqual({ assets: 0, events: 0, prices: 0, revisions: 0 })
  })

  it('a full-size account (5,000 entries, 5,000 prices, 20,000 correction records) restores in one go and fits the size limit', async () => {
    const day = 24 * 3600 * 1000, t0 = Date.parse('2024-01-01T00:00:00Z')
    const assets = Array.from({ length: 50 }, (_, i) => ({ id: `A${i}`, name: `Token ${i}`, symbol: `T${i}`, sourceUrl: null, network: null, contractAddress: null, createdAt: '2024-01-01T00:00:00.000Z', archivedAt: null }))
    const events = Array.from({ length: 5000 }, (_, i) => ({
      id: `E${i}`, assetId: `A${i % 50}`, type: 'BUY', occurredAt: new Date(t0 + i * day / 8).toISOString(), quantity: '12.345678', consideration: '123456.78', fee: '10', basis: null, zeroCost: false,
      quote: 'PKR', fxRate: null, fxSource: null, note: `entry number ${i} with a typical short note`, source: 'manual', voided: false, voidReason: null, priceBasis: 'own', editedAt: i % 4 === 0 ? '2025-06-01T00:00:00.000Z' : null, linkedTradeRef: null,
    }))
    const prices = Array.from({ length: 5000 }, (_, i) => ({ assetId: `A${i % 50}`, price: `${100 + i}.5`, quote: 'PKR', observedAt: new Date(t0 + i * day / 8).toISOString(), source: 'manual' }))
    const revisions = Array.from({ length: 20000 }, (_, i) => ({
      eventId: `E${i % 5000}`, assetId: `A${(i % 5000) % 50}`, action: 'edit', createdAt: new Date(t0 + 700 * day + i * 1000).toISOString(),
      before: { type: 'BUY', occurredAt: new Date(t0).toISOString(), quantity: '12.345678', consideration: '123456.78', fee: '10', basis: null, quote: 'PKR', fxRate: null, fxSource: null, note: 'an earlier note', priceBasis: 'own', zeroCost: false },
    }))
    const big = { format: 'rupchain-portfolio-backup', version: 2, exportedAt: past, assets, events, prices, revisions, revisionsTruncated: false }
    const bytes = JSON.stringify(big).length
    expect(bytes).toBeLessThan(16 * 1024 * 1024)

    const u = await makeUser()
    const started = Date.now()
    const r = await restorePortfolioBackup(u, big, LIMITS)
    const seconds = (Date.now() - started) / 1000
    console.log(`full-size restore: ${(bytes / 1048576).toFixed(1)} MB file, ${seconds.toFixed(1)} s`)
    expect(r).toMatchObject({ assets: { created: 50 }, entries: { restored: 5000 }, prices: { restored: 5000 }, history: { restored: 20000, notRestored: 0 } })
    expect(await counts(u)).toEqual({ assets: 50, events: 5000, prices: 5000, revisions: 20000 })
    expect(seconds).toBeLessThan(45)
    // And running it again still adds nothing, even at this size.
    const again = await restorePortfolioBackup(u, big, LIMITS)
    expect(again).toMatchObject({ assets: { created: 0 }, entries: { restored: 0 }, prices: { restored: 0 }, history: { restored: 0 } })
  })

  it('puts entries typed on a RupChain-linked token back on that token, found through the keyed reference', async () => {
    const tag = Math.random().toString(36).slice(2, 10)
    const token = await db().ctmToken.create({ data: { slug: `it-${tag}`, symbol: 'ITT', name: `Integration Token ${tag}`, description: 'integration test', settlementType: 'MANUAL' } as never })
    try {
      const u = await makeUser()
      const file = {
        format: 'rupchain-portfolio-backup', version: 2, exportedAt: past,
        assets: [{ id: 'L1', name: token.name, symbol: 'ITT', sourceUrl: null, network: null, contractAddress: null, createdAt: '2026-01-01T00:00:00.000Z', archivedAt: null, linkedToRupChainToken: true, linkedTokenRef: linkedTokenRef(token.id) }],
        events: [{ id: 'M1', assetId: 'L1', type: 'BUY', occurredAt: past, quantity: '4', consideration: '400', fee: '0', basis: null, zeroCost: false, quote: 'PKR', fxRate: null, fxSource: null, note: 'typed by hand', source: 'manual', voided: false, voidReason: null, priceBasis: null, editedAt: null, linkedTradeRef: null }],
        prices: [{ assetId: 'L1', price: '101', quote: 'PKR', observedAt: past, source: 'manual' }],
        revisions: [],
      }
      const r = await restorePortfolioBackup(u, file, LIMITS)
      expect(r).toMatchObject({ entries: { restored: 1 }, prices: { restored: 1 } })
      const linked = await db().portfolioAsset.findFirst({ where: { userId: u, ctmTokenId: token.id } })
      expect(linked).not.toBeNull()
      expect(await db().portfolioEvent.count({ where: { userId: u, assetId: linked!.id } })).toBe(1)
      // Again: the linked token is reused, nothing is added twice.
      const again = await restorePortfolioBackup(u, file, LIMITS)
      expect(again).toMatchObject({ entries: { restored: 0 }, prices: { restored: 0 } })
      expect(await db().portfolioAsset.count({ where: { userId: u } })).toBe(1)
      // A reference that matches no platform token places nothing.
      const stray = await makeUser()
      const lost = await restorePortfolioBackup(stray, { ...file, assets: [{ ...file.assets[0]!, linkedTokenRef: 'f'.repeat(32) }] }, LIMITS)
      expect(lost.entries).toMatchObject({ restored: 0, notRestored: 1 })
    } finally {
      await db().portfolioAsset.deleteMany({ where: { ctmTokenId: token.id } }).catch(() => {})
      await db().ctmToken.delete({ where: { id: token.id } }).catch(() => {})
    }
  })

  it("one account's restore never touches another account", async () => {
    const a = await makeUser(), b = await makeUser()
    await restorePortfolioBackup(a, backup(), LIMITS)
    expect(await counts(b)).toEqual({ assets: 0, events: 0, prices: 0, revisions: 0 })
    await restorePortfolioBackup(b, backup(), LIMITS)
    expect(await counts(a)).toEqual({ assets: 2, events: 2, prices: 1, revisions: 2 })
  })
})
