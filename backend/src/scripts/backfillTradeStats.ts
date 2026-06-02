/* eslint-disable no-console */
/**
 * One-shot backfill: recompute every user's TradeStats (and badge / trust score)
 * from live trade data across all three marketplaces (USDT P2P, CTM, Gas).
 *
 * Why this exists:
 *   The dashboard, KYC page, and trader-badge card read the persisted
 *   `TradeStats.completedTrades` value. That row is kept in sync going forward
 *   by the badgeRecalculate job, which is queued on every USDT release, CTM
 *   completion, and Gas delivery. But those CTM/Gas triggers were added after
 *   many trades had already completed, so existing rows are stale — a user with
 *   18 live completed trades can still show "2" because no recalc has fired for
 *   them since the triggers landed.
 *
 *   The leaderboard never had this problem because it counts live from the
 *   trade tables. This script makes TradeStats agree with that live count for
 *   every existing user. After running once, the standard triggers keep rows
 *   accurate.
 *
 * Safe to run repeatedly — recalculateUserBadge is idempotent (it recomputes
 * from scratch and respects admin badge overrides).
 *
 * Usage:
 *   npx tsx src/scripts/backfillTradeStats.ts
 *   npx tsx src/scripts/backfillTradeStats.ts --user <userId>   (single user)
 */

import 'dotenv/config'
import '../lib/env'
import { db } from '../lib/prisma'
import { recalculateUserBadge } from '../jobs/badgeRecalculate.job'

const args = process.argv.slice(2)
const singleUserId =
  args.find((a) => a.startsWith('--user='))?.split('=')[1] ??
  (args.includes('--user') ? args[args.indexOf('--user') + 1] : null)

async function main() {
  let userIds: string[]

  if (singleUserId) {
    userIds = [singleUserId]
  } else {
    // Every user who has participated in any trade on any marketplace.
    const [usdt, ctm, gas] = await Promise.all([
      db.trade.findMany({ select: { buyerId: true, sellerId: true } }),
      db.ctmTrade.findMany({ select: { buyerId: true, sellerId: true } }),
      db.gasFeeOrder.findMany({ where: { userId: { not: null } }, select: { userId: true } }),
    ])

    const set = new Set<string>()
    for (const t of usdt) { set.add(t.buyerId); set.add(t.sellerId) }
    for (const t of ctm) { set.add(t.buyerId); set.add(t.sellerId) }
    for (const o of gas) { if (o.userId) set.add(o.userId) }
    userIds = [...set]
  }

  console.log(`Backfilling TradeStats for ${userIds.length} user(s)...`)

  let ok = 0
  let failed = 0
  // Sequential to keep DB load gentle; the job runs a handful of queries each.
  for (const userId of userIds) {
    try {
      await recalculateUserBadge(userId)
      ok += 1
      if (ok % 25 === 0) console.log(`  ...${ok}/${userIds.length} done`)
    } catch (err) {
      failed += 1
      console.error(`  FAILED for ${userId}:`, err instanceof Error ? err.message : err)
    }
  }

  console.log(`\nDone. Recalculated: ${ok}, failed: ${failed}.`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Backfill aborted:', err)
    process.exit(1)
  })
