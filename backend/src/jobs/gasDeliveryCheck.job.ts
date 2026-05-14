import type { Job } from 'bullmq'
import { db } from '../lib/prisma'
import { env } from '../lib/env'
import { logger } from '../lib/logger'

async function checkTronTxConfirmed(txHash: string): Promise<boolean> {
  const url = `${env.TRON_FULLNODE_URL}/v1/transactions/${encodeURIComponent(txHash)}`
  const headers: Record<string, string> = {}
  if (env.TRONGRID_API_KEY) headers['TRONGRID-API-Key'] = env.TRONGRID_API_KEY

  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`TronGrid API error: HTTP ${res.status}`)

  const data = (await res.json()) as {
    data?: Array<{ ret?: Array<{ contractRet?: string }> }>
  }
  const tx = data.data?.[0]
  return tx?.ret?.[0]?.contractRet === 'SUCCESS'
}

// Runs 60s after delivery. Retries every 60s for up to 10 attempts (10 min total).
// After all attempts are exhausted, BullMQ marks the job as permanently failed and
// the workers.ts `failed` event handler sends the admin alert.
export async function checkGasDelivery(job: Job<{ orderId: string; txHash: string }>) {
  const { orderId, txHash } = job.data

  const confirmed = await checkTronTxConfirmed(txHash)

  if (confirmed) {
    await db.gasFeeOrder.update({
      where: { id: orderId },
      data: { deliveryConfirmed: true },
    })
    logger.info({ orderId, txHash }, 'Gas delivery confirmed on-chain')
    return
  }

  // Not confirmed yet — throw so BullMQ schedules the next retry
  logger.debug(
    { orderId, txHash, attempt: job.attemptsMade + 1 },
    'Gas delivery not yet confirmed — will retry',
  )
  throw new Error('NOT_CONFIRMED_YET')
}
