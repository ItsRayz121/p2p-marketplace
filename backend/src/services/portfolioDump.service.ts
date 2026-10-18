import { createHash } from 'node:crypto'
import { db } from '../lib/prisma'

/**
 * A raw, complete export of the portfolio tables for the given users, and a restore that puts back any row that
 * is missing. Used before the tracking-period cutover so the state it starts from can always be recovered.
 * Portfolio tables only (never wallets, orders or settlement). Decimals are written as exact strings and dates
 * as ISO text, so nothing is rounded on the way out or in.
 */

export const DUMP_FORMAT = 'rupchain-portfolio-dump'
export const DUMP_VERSION = 1

const TABLES = ['assets', 'events', 'revisions', 'prices', 'interests', 'periods', 'holdings', 'snapshots'] as const
export type DumpTable = (typeof TABLES)[number]
type Row = Record<string, unknown>

export interface PortfolioDump {
  format: typeof DUMP_FORMAT
  version: number
  createdAt: string
  userIds: string[]
  counts: Record<DumpTable, number>
  tables: Record<DumpTable, Row[]>
}

const DECIMAL_FIELDS = new Set(['quantity', 'consideration', 'fee', 'basis', 'fxRate', 'price', 'marketPrice', 'valuePkr', 'fxUsdtPkr'])

/** Plain JSON-safe copy of a database row: Decimal -> exact string, Date -> ISO text. */
function plain(row: Row): Row {
  const out: Row = {}
  for (const [k, v] of Object.entries(row)) {
    if (v instanceof Date) out[k] = { $date: v.toISOString() }
    else if (v !== null && typeof v === 'object' && typeof (v as { toFixed?: unknown }).toFixed === 'function' && DECIMAL_FIELDS.has(k)) out[k] = (v as { toFixed(): string }).toFixed()
    else out[k] = v
  }
  return out
}

function revive(row: Row): Row {
  const out: Row = {}
  for (const [k, v] of Object.entries(row)) {
    if (v && typeof v === 'object' && '$date' in (v)) out[k] = new Date((v as { $date: string }).$date)
    else out[k] = v
  }
  return out
}

export async function dumpPortfolioState(userIds: string[]): Promise<PortfolioDump> {
  const where = { userId: { in: userIds } }
  // Read in one consistent snapshot so the dump cannot mix states from two moments.
  const [assets, events, revisions, prices, interests, periods, holdings, snapshots] = await db.$transaction([
    db.portfolioAsset.findMany({ where, orderBy: { id: 'asc' } }),
    db.portfolioEvent.findMany({ where, orderBy: { id: 'asc' } }),
    db.portfolioEventRevision.findMany({ where, orderBy: { id: 'asc' } }),
    db.portfolioPriceObservation.findMany({ where, orderBy: { id: 'asc' } }),
    db.portfolioListingInterest.findMany({ where, orderBy: { id: 'asc' } }),
    db.portfolioTrackingPeriod.findMany({ where, orderBy: { id: 'asc' } }),
    db.portfolioOpeningHolding.findMany({ where, orderBy: { id: 'asc' } }),
    db.portfolioSnapshot.findMany({ where, orderBy: { id: 'asc' } }),
  ])
  const tables = {
    assets: assets.map(plain), events: events.map(plain), revisions: revisions.map(plain), prices: prices.map(plain),
    interests: interests.map(plain), periods: periods.map(plain), holdings: holdings.map(plain), snapshots: snapshots.map(plain),
  } as Record<DumpTable, Row[]>
  return {
    format: DUMP_FORMAT, version: DUMP_VERSION, createdAt: new Date().toISOString(), userIds: [...userIds].sort(),
    counts: Object.fromEntries(TABLES.map((t) => [t, tables[t].length])) as Record<DumpTable, number>,
    tables,
  }
}

/** Serialised dump plus its SHA-256, so a file that was edited or truncated is detected before it is trusted. */
export function serializeDump(d: PortfolioDump): { text: string; sha256: string } {
  const text = JSON.stringify(d)
  return { text, sha256: createHash('sha256').update(text).digest('hex') }
}

export function parseDump(text: string, expectedSha256?: string): PortfolioDump {
  if (expectedSha256 && createHash('sha256').update(text).digest('hex') !== expectedSha256) throw new Error('backup file does not match its checksum')
  const d = JSON.parse(text) as PortfolioDump
  if (d.format !== DUMP_FORMAT || d.version !== DUMP_VERSION) throw new Error('not a portfolio dump this version can read')
  for (const t of TABLES) {
    if (!Array.isArray(d.tables?.[t]) || d.counts?.[t] !== d.tables[t].length) throw new Error(`backup file is incomplete (${t})`)
  }
  return d
}

export interface RestoreCounts { created: Record<DumpTable, number>; alreadyThere: Record<DumpTable, number> }

/**
 * Put back every row of the dump that is missing (matched by id). Rows that already exist are left exactly as
 * they are, so it is safe to run twice. It never deletes anything. Order respects the foreign keys.
 */
export async function restoreDump(d: PortfolioDump): Promise<RestoreCounts> {
  const created = {} as Record<DumpTable, number>
  const alreadyThere = {} as Record<DumpTable, number>
  await db.$transaction(async (tx) => {
    const order: Array<[DumpTable, (data: Row[]) => Promise<{ count: number }>]> = [
      ['assets', (data) => tx.portfolioAsset.createMany({ data: data as never, skipDuplicates: true })],
      ['periods', (data) => tx.portfolioTrackingPeriod.createMany({ data: data as never, skipDuplicates: true })],
      ['events', (data) => tx.portfolioEvent.createMany({ data: data as never, skipDuplicates: true })],
      ['revisions', (data) => tx.portfolioEventRevision.createMany({ data: data as never, skipDuplicates: true })],
      ['prices', (data) => tx.portfolioPriceObservation.createMany({ data: data as never, skipDuplicates: true })],
      ['interests', (data) => tx.portfolioListingInterest.createMany({ data: data as never, skipDuplicates: true })],
      ['holdings', (data) => tx.portfolioOpeningHolding.createMany({ data: data as never, skipDuplicates: true })],
      ['snapshots', (data) => tx.portfolioSnapshot.createMany({ data: data as never, skipDuplicates: true })],
    ]
    for (const [table, run] of order) {
      const rows = d.tables[table].map(revive)
      let made = 0
      for (let i = 0; i < rows.length; i += 500) made += (await run(rows.slice(i, i + 500))).count
      created[table] = made
      alreadyThere[table] = rows.length - made
    }
  }, { timeout: 120_000, maxWait: 15_000 })
  return { created, alreadyThere }
}
