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

function assertPrismaClientIsCurrent() {
  // The generated client is missing models when `prisma generate` wasn't run
  // against the current schema. Most common cause: `railway run` spawned a
  // container that skipped the build step. Fail loudly with a fix-it message
  // instead of the bare "Cannot read properties of undefined" we'd otherwise
  // get from `db.depositAddress.count(...)`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dbAny = db as any
  const missing: string[] = []
  if (!dbAny.depositAddress) missing.push('depositAddress')
  if (!dbAny.moralisStreamSubscription) missing.push('moralisStreamSubscription')
  if (missing.length > 0) {
    console.error(
      '\n[fatal] Prisma client is missing model(s): ' + missing.join(', ') + '\n' +
        '         The @prisma/client in this environment was generated against an\n' +
        '         older schema. Run `prisma generate` against the current schema\n' +
        '         before this script. The npm script already does this — make sure\n' +
        '         you ran `npm run moralis:backfill` (not `tsx` directly).\n',
    )
    process.exit(2)
  }
}

async function main() {
  logger.info('Moralis backfill starting...')
  assertPrismaClientIsCurrent()

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
