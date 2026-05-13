import { db } from '../lib/prisma'
import { logger } from '../lib/logger'
import { EVM_CHAINS, getMoralisStreamId } from '../lib/chains'
import { addAddressToStream, getStreamMetadata, MoralisApiError } from '../lib/moralisClient'
import { recordAuditLog } from '../lib/audit'
import { env } from '../lib/env'
import { queues } from '../queues/definitions'

/**
 * Ensure a `MoralisStreamSubscription` row exists for the given
 * (depositAddressId, chain) pair. Idempotent — safe to call multiple times.
 *
 * For chains whose stream id isn't configured yet, the row is created with
 * status='skipped' so the admin status endpoint surfaces it. Once the
 * operator sets the env var and triggers a backfill, those rows flip to
 * status='pending' and get enqueued.
 */
export async function ensureSubscriptionRows(depositAddressId: string): Promise<void> {
  for (const chain of EVM_CHAINS) {
    const streamId = getMoralisStreamId(chain.id)
    await db.moralisStreamSubscription.upsert({
      where: { depositAddressId_chain: { depositAddressId, chain: chain.id } },
      create: {
        depositAddressId,
        chain: chain.id,
        streamId: streamId ?? null,
        status: streamId ? 'pending' : 'skipped',
      },
      update: {
        // If a stream id appeared between runs, flip skipped → pending so a
        // backfill picks it up. Never downgrade a 'subscribed' or 'failed' row.
        ...(streamId ? { streamId } : {}),
      },
    })
  }
}

/**
 * Enqueue a subscription job for every pending row attached to a given
 * DepositAddress. Fire-and-forget — used after a new address is generated.
 *
 * Idempotent: BullMQ jobs are de-duplicated by job id (subscriptionId), so
 * accidentally calling this twice for the same address is harmless.
 */
export async function enqueuePendingSubscriptions(depositAddressId: string): Promise<void> {
  const pending = await db.moralisStreamSubscription.findMany({
    where: { depositAddressId, status: 'pending' },
    select: { id: true },
  })
  await Promise.all(
    pending.map((p) =>
      queues.moralisSubscribe.add('subscribe', { subscriptionId: p.id }, { jobId: 'moralis-sub-' + p.id }).catch((err) => {
        logger.warn({ err, subscriptionId: p.id }, 'Failed to enqueue Moralis subscription job')
      }),
    ),
  )
}

/**
 * Full provisioning step called from depositAddress.service after a new
 * address is created. Creates one MoralisStreamSubscription row per EVM
 * chain and enqueues subscribe jobs for each row that has a configured
 * stream id. Never throws — any failure here must not block the user's
 * deposit-address request.
 */
export async function provisionSubscriptions(depositAddressId: string): Promise<void> {
  try {
    await ensureSubscriptionRows(depositAddressId)
    await enqueuePendingSubscriptions(depositAddressId)
  } catch (err) {
    logger.error({ err, depositAddressId }, 'Failed to provision Moralis subscriptions')
  }
}

/**
 * Process one subscription row: POST the address into the chain's stream
 * and update the row's status. Returns true if the row reached a terminal
 * success state, false if it should be retried.
 */
export async function processSubscription(subscriptionId: string): Promise<{ done: boolean; retryable: boolean }> {
  const sub = await db.moralisStreamSubscription.findUnique({
    where: { id: subscriptionId },
    include: { depositAddress: { select: { address: true, userId: true } } },
  })
  if (!sub) {
    logger.warn({ subscriptionId }, 'Subscription row vanished mid-flight')
    return { done: true, retryable: false }
  }
  if (sub.status === 'subscribed') return { done: true, retryable: false }
  if (sub.status === 'skipped' && !sub.streamId) {
    // Operator hasn't configured this chain — nothing to do.
    return { done: true, retryable: false }
  }

  const streamId = sub.streamId ?? getMoralisStreamId(sub.chain)
  if (!streamId) {
    await db.moralisStreamSubscription.update({
      where: { id: sub.id },
      data: { status: 'skipped', lastError: 'stream_id_not_configured', lastAttemptAt: new Date() },
    })
    return { done: true, retryable: false }
  }

  try {
    await addAddressToStream(streamId, sub.depositAddress.address)
    await db.moralisStreamSubscription.update({
      where: { id: sub.id },
      data: {
        status: 'subscribed',
        streamId,
        subscribedAt: new Date(),
        lastAttemptAt: new Date(),
        lastError: null,
        attempts: { increment: 1 },
      },
    })
    void recordAuditLog(
      sub.depositAddress.userId,
      'MORALIS_STREAM_SUBSCRIBED',
      'MoralisStreamSubscription',
      sub.id,
      { chain: sub.chain, streamId, address: sub.depositAddress.address },
    )
    logger.info({ subscriptionId: sub.id, chain: sub.chain }, 'Address subscribed to Moralis Stream')
    return { done: true, retryable: false }
  } catch (err) {
    const isFatal = err instanceof MoralisApiError && err.isFatal
    const message = err instanceof Error ? err.message.slice(0, 500) : 'unknown error'
    await db.moralisStreamSubscription.update({
      where: { id: sub.id },
      data: {
        status: isFatal ? 'failed' : 'pending',
        lastError: message,
        lastAttemptAt: new Date(),
        attempts: { increment: 1 },
      },
    })
    if (isFatal) {
      logger.error({ subscriptionId: sub.id, chain: sub.chain, err: message }, 'Subscription failed permanently')
      return { done: true, retryable: false }
    }
    logger.warn({ subscriptionId: sub.id, chain: sub.chain, err: message }, 'Subscription failed; will retry')
    return { done: false, retryable: true }
  }
}

export async function getStreamStatusSummary() {
  // Total + per-chain × per-status breakdown.
  const rows = await db.moralisStreamSubscription.groupBy({
    by: ['chain', 'status'],
    _count: { _all: true },
  })
  const perChain: Record<string, Record<string, number>> = {}
  for (const r of rows) {
    const bucket = perChain[r.chain] ?? {}
    bucket[r.status] = r._count._all
    perChain[r.chain] = bucket
  }
  // Operator-visible status per chain: stream id configured + reachable?
  const chains = await Promise.all(
    EVM_CHAINS.map(async (c) => {
      const streamId = getMoralisStreamId(c.id)
      let reachable: boolean | null = null
      let lastError: string | null = null
      if (streamId && env.MORALIS_API_KEY) {
        try {
          const meta = await getStreamMetadata(streamId)
          reachable = meta !== null
        } catch (err) {
          reachable = false
          lastError = err instanceof Error ? err.message.slice(0, 200) : 'unknown error'
        }
      }
      return {
        chainId: c.id,
        chainName: c.name,
        streamConfigured: !!streamId,
        streamReachable: reachable,
        streamError: lastError,
        counts: perChain[c.id] ?? {},
      }
    }),
  )
  return { chains }
}
