import type { FastifyInstance } from 'fastify'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { env } from '../lib/env'
import { queues } from '../queues/definitions'
import { logger } from '../lib/logger'
import {
  normalizeMoralisEvent,
  processDepositEvent,
} from '../services/depositWatcher.service'

export async function webhookRoutes(app: FastifyInstance) {
  // POST /api/webhooks/deposit
  // CSRF exempt — raw body needed for HMAC verification
  app.post('/webhooks/deposit', {
    config: { rawBody: true },
  }, async (req, reply) => {
    // 1. Verify HMAC signature
    const signature = req.headers['x-signature'] as string | undefined
    if (!signature || !env.MORALIS_WEBHOOK_SECRET) {
      return reply.code(401).send({ error: 'Missing signature' })
    }

    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody
    const bodyStr = rawBody ? rawBody.toString('utf8') : JSON.stringify(req.body)

    const expected = createHmac('sha256', env.MORALIS_WEBHOOK_SECRET)
      .update(bodyStr)
      .digest('hex')

    let signaturesMatch = false
    try {
      signaturesMatch = timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expected),
      )
    } catch {
      signaturesMatch = false
    }

    if (!signaturesMatch) {
      logger.warn({ signature }, 'Webhook signature mismatch')
      return reply.code(401).send({ error: 'Invalid signature' })
    }

    // The webhook is shared between two payload shapes:
    //   (a) Native Moralis Streams payload (chainId + txs/erc20Transfers arrays)
    //   (b) Legacy normalized payload used by InstantBuy / GasFee matching
    //       ({ txHash, toAddress, amount, coin, network, confirmations })
    //
    // We dispatch (a) to the deposit watcher and fall through to (b) for the
    // InstantBuy/GasFee paths that already exist below. A real Moralis payload
    // does not carry InstantBuy/GasFee metadata, so those branches simply
    // produce no match — safe to run unconditionally.
    const payload = req.body as {
      // Moralis-style
      chainId?: string
      txs?: unknown[]
      erc20Transfers?: unknown[]
      // Legacy / normalized
      txHash?: string
      toAddress?: string
      amount?: string
      coin?: string
      network?: string
      confirmations?: number
    }

    // Process Moralis-style payloads through the deposit watcher.
    if (payload.chainId && (Array.isArray(payload.txs) || Array.isArray(payload.erc20Transfers))) {
      const events = normalizeMoralisEvent(payload)
      const results = []
      for (const event of events) {
        try {
          const r = await processDepositEvent(event)
          results.push({ txHash: event.txHash, asset: event.asset, result: r })
        } catch (err) {
          logger.error({ err, txHash: event.txHash }, 'Deposit watcher failed')
          results.push({ txHash: event.txHash, asset: event.asset, error: 'processing_failed' })
        }
      }
      // Legacy InstantBuy/GasFee matching is skipped for Moralis-style payloads —
      // those flows use the normalized shape below.
      return reply.send({ success: true, processed: results.length, results })
    }

    const { txHash, toAddress, coin } = payload

    if (!txHash || !toAddress) {
      return reply.code(400).send({ error: 'Missing required fields' })
    }

    // 2. Idempotency check (legacy path only — Moralis events are de-duped
    //    inside processDepositEvent via the (txHash, chain, asset) unique).
    const idemKey = `webhook_event:${txHash}`
    const alreadyProcessed = await redis.get(idemKey)
    if (alreadyProcessed) {
      logger.info({ txHash }, 'Webhook already processed, skipping')
      return reply.send({ success: true, skipped: true })
    }

    // Mark as processing
    await redis.setex(idemKey, 86400, '1')

    // 3. Match InstantBuyOrder
    const instantOrder = await db.instantBuyOrder.findFirst({
      where: {
        status: 'payment_pending',
        ...(coin ? { coin } : {}),
      },
    })

    if (instantOrder) {
      await db.instantBuyOrder.update({
        where: { id: instantOrder.id },
        data: {
          status: 'payment_uploaded',
          incomingTxHash: txHash,
        },
      })
      logger.info({ txHash, orderId: instantOrder.id }, 'Deposit detected for instant buy order')
    }

    // 4. Match GasFeeOrder
    const gasOrder = await db.gasFeeOrder.findFirst({
      where: {
        toAddress: toAddress,
        status: 'payment_pending',
      },
    })

    if (gasOrder) {
      await db.gasFeeOrder.update({
        where: { id: gasOrder.id },
        data: {
          status: 'payment_detected',
          paymentTxHash: txHash,
        },
      })
      // Queue gas fee delivery
      await queues.gasFee.add('deliver', { orderId: gasOrder.id })
      logger.info({ txHash, orderId: gasOrder.id }, 'Payment detected for gas fee order')
    }

    return reply.send({ success: true })
  })
}
