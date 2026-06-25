/**
 * One-shot backfill: rebuild every TradeStreak from existing COMPLETED trades.
 *
 * The mutual-streak feature increments a per-pair counter going forward, but
 * pairs who already traded many times before the feature shipped would otherwise
 * show "1st trade together" on their next trade. This script recomputes each
 * pair's combined count from the historical Trade (crypto_released) + CtmTrade
 * (completed) rows so the live counter starts from the truth.
 *
 * Idempotent: it wipes and rebuilds the TradeStreak table from scratch each run.
 *
 * Usage:
 *   npx tsx src/scripts/backfillTradeStreaks.ts
 */

import 'dotenv/config'
import '../lib/env'
import { db } from '../lib/prisma'

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

async function main() {
  const [usdt, ctm] = await Promise.all([
    db.trade.findMany({
      where: { status: 'crypto_released' },
      select: { buyerId: true, sellerId: true, releasedAt: true, createdAt: true },
    }),
    db.ctmTrade.findMany({
      where: { status: 'completed' },
      select: { buyerId: true, sellerId: true, completedAt: true, createdAt: true },
    }),
  ])

  type Agg = { userAId: string; userBId: string; count: number; first: Date; last: Date }
  const map = new Map<string, Agg>()

  const add = (a: string, b: string, at: Date) => {
    if (a === b) return
    const key = pairKey(a, b)
    const [userAId, userBId] = a < b ? [a, b] : [b, a]
    const existing = map.get(key)
    if (!existing) {
      map.set(key, { userAId, userBId, count: 1, first: at, last: at })
    } else {
      existing.count += 1
      if (at < existing.first) existing.first = at
      if (at > existing.last) existing.last = at
    }
  }

  for (const t of usdt) add(t.buyerId, t.sellerId, t.releasedAt ?? t.createdAt)
  for (const t of ctm) add(t.buyerId, t.sellerId, t.completedAt ?? t.createdAt)

  console.log(
    `Found ${usdt.length} completed USDT + ${ctm.length} completed CTM trades → ${map.size} unique pair(s).`,
  )

  await db.tradeStreak.deleteMany({})

  const rows = [...map.values()].map((a) => ({
    userAId: a.userAId,
    userBId: a.userBId,
    tradeCount: a.count,
    firstTradeAt: a.first,
    lastTradeAt: a.last,
  }))

  // createMany skips relational checks and is fast; any orphaned ids (deleted
  // users) would violate the FK, so chunk + tolerate by falling back per-row.
  const CHUNK = 500
  let inserted = 0
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    try {
      const res = await db.tradeStreak.createMany({ data: chunk, skipDuplicates: true })
      inserted += res.count
    } catch {
      // Fall back to per-row so one bad FK doesn't sink the whole chunk.
      for (const r of chunk) {
        try {
          await db.tradeStreak.create({ data: r })
          inserted += 1
        } catch (err) {
          console.warn(`  skipped pair ${r.userAId}/${r.userBId}:`, (err as Error).message)
        }
      }
    }
  }

  console.log(`Backfill complete — ${inserted} TradeStreak row(s) written.`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
