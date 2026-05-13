import type { FastifyInstance } from 'fastify'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { env } from '../lib/env'
import { queues } from '../queues/definitions'
import { logger } from '../lib/logger'

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

    const payload = req.body as {
      txHash?: string
      toAddress?: string
      amount?: string
      coin?: string
      network?: string
      confirmations?: number
    }

    const { txHash, toAddress, coin } = payload

    if (!txHash || !toAddress) {
      return reply.code(400).send({ error: 'Missing required fields' })
    }

    // 2. Idempotency check
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
