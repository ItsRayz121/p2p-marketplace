import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({ impl: (async () => null) as () => Promise<unknown> }))
vi.mock('../../lib/prisma', () => ({ db: { portfolioTrackingPeriod: { findFirst: () => m.impl() } } }))
vi.mock('../../lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))
vi.mock('../platformFlags.service', () => ({ getStringConfig: async () => '' }))
vi.mock('../portfolioMarks.service', () => ({ latestMarksForUser: async () => [] }))

import { getActivePeriod, clampToPeriod } from '../portfolioPeriod.service'

beforeEach(() => { m.impl = async () => null })

describe('getActivePeriod', () => {
  it('treats a missing period table (deployed ahead of the migration) as "no period"', async () => {
    m.impl = async () => { throw Object.assign(new Error('table does not exist'), { code: 'P2021' }) }
    expect(await getActivePeriod('u1')).toBeNull()
  })
  it('does NOT hide any other failure: a user with a baseline must never be shown numbers without it', async () => {
    m.impl = async () => { throw new Error('connection reset') }
    await expect(getActivePeriod('u1')).rejects.toThrow('connection reset')
  })
  it('returns null when the user simply has none', async () => {
    expect(await getActivePeriod('u1')).toBeNull()
  })
})

describe('clampToPeriod', () => {
  const row = (at: string) => ({ id: 'x', assetId: 'a', type: 'BUY' as const, occurredAt: new Date(at), quantity: '1', consideration: '1', fee: '0', basis: null, zeroCost: false, quote: 'PKR' as const, fxRate: null })
  it('moves an entry dated before the cutover to the cutover, and leaves later ones alone', () => {
    const start = new Date('2026-10-18T07:00:00Z')
    const out = clampToPeriod([row('2026-10-01T00:00:00Z'), row('2026-10-19T00:00:00Z')], start)
    expect(out[0]!.occurredAt).toEqual(start)
    expect(out[1]!.occurredAt).toEqual(new Date('2026-10-19T00:00:00Z'))
  })
})
