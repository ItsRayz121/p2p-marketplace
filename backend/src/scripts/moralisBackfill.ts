/* eslint-disable no-console */
/**
 * Manual backfill: ensure every existing DepositAddress has the full set of
 * MoralisStreamSubscription rows and enqueue subscribe jobs for any that
 * are pending.
 *
 * Safe to run repeatedly. Re-running picks up only what's still 'pending' or
 * what became 'pending' because an operator just set a new MORALIS_STREAM_ID_*
 * env var (skipped → pending flip happens in ensureSubscriptionRows).
 *
 * Usage:  npm run moralis:backfill
 */
import 'dotenv/config'
import './../lib/env'
import { db } from '../lib/prisma'
import { ensureSubscriptionRows, enqueuePendingSubscriptions } from '../services/moralisStreams.service'
import { logger } from '../lib/logger'

async function main() {
  logger.info('Moralis backfill starting...')

  const total = await db.depositAddress.count({ where: { chainFamily: 'EVM' } })
  logger.info({ total }, 'Total EVM DepositAddress rows to inspect')

  const batchSize = 100
  let cursor: string | undefined
  let scanned = 0
  let enqueued = 0

  for (;;) {
    const batch = await db.depositAddress.findMany({
      where: { chainFamily: 'EVM' },
      orderBy: { createdAt: 'asc' },
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: { id: true },
    })
    if (batch.length === 0) break

    for (const da of batch) {
      await ensureSubscriptionRows(da.id)
      const before = await db.moralisStreamSubscription.count({
        where: { depositAddressId: da.id, status: 'pending' },
      })
      await enqueuePendingSubscriptions(da.id)
      enqueued += before
      scanned += 1
    }

    cursor = batch[batch.length - 1]!.id
    logger.info({ scanned, total, enqueuedPending: enqueued }, 'Backfill progress')
  }

  logger.info({ scanned, enqueuedJobs: enqueued }, 'Moralis backfill complete')
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
