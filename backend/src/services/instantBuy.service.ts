import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { AppError, Errors } from '../lib/errors'
import { generateOrderRef } from '../lib/hash'
import { queues } from '../queues/definitions'
import { assertCloudinaryUrl } from '../lib/upload'

// ─── createOrder ──────────────────────────────────────────────────────────────

export async function createOrder(
  userId: string,
  data: {
    coin: string
    network: string
    paymentMode: 'pkr' | 'crypto'
    amount: number
    destinationAddress: string
    idempotencyKey?: string
  },
) {
  const idemKey = data.idempotencyKey ? `idem:instantbuy:${data.idempotencyKey}` : null
  const resolveDepositAddress = async () => {
    const depKey = `deposit_address_${data.coin.toLowerCase()}_${data.network.toLowerCase()}`
    const cfg = await db.platformConfig.findUnique({ where: { key: depKey } })
    return cfg?.value ?? null
  }

  // Idempotency: claim the key with SET NX BEFORE any writes so two concurrent
  // submissions (double-click / retry) can't both create an order and double-charge
  // the daily buy limit.
  if (idemKey) {
    const existing = await redis.get(idemKey)
    if (existing && existing !== 'pending') {
      const order = await db.instantBuyOrder.findUnique({ where: { id: existing } })
      if (order) return { order, depositAddress: await resolveDepositAddress() }
    }
    const claimed = await redis.set(idemKey, 'pending', 'EX', 86400, 'NX')
    if (claimed !== 'OK') {
      throw new AppError('DUPLICATE_REQUEST', 'This order is already being created. Please wait a moment.', 409)
    }
  }

  try {
    return await createOrderInner(userId, data, idemKey)
  } catch (err) {
    // Release the claim so a legitimate retry isn't blocked for 24h.
    if (idemKey) await redis.del(idemKey).catch(() => {})
    throw err
  }
}

async function createOrderInner(
  userId: string,
  data: {
    coin: string
    network: string
    paymentMode: 'pkr' | 'crypto'
    amount: number
    destinationAddress: string
    idempotencyKey?: string
  },
  idemKey: string | null,
) {
  // Fetch rate, fee config, and deposit address outside the transaction (read-only, non-critical timing)
  const rateStr = await redis.get(`rate:${data.coin}`)
  if (!rateStr) {
    throw new AppError('RATE_UNAVAILABLE', `Rate for ${data.coin}/PKR is not available`, 503)
  }
  const rateParsed = JSON.parse(rateStr) as { rate?: number; updatedAt?: number | string }
  const rate = rateParsed.rate
  if (!rate || rate <= 0) {
    throw new AppError('RATE_UNAVAILABLE', `Rate for ${data.coin}/PKR is not available`, 503)
  }
  // Staleness gate: the rate key has a 1h TTL, but if rateUpdater stalls we must
  // not quote an hour-old crypto price. Reject anything older than MAX_RATE_AGE.
  const MAX_RATE_AGE_MS = 20 * 60 * 1000
  const updatedAtMs =
    typeof rateParsed.updatedAt === 'number'
      ? rateParsed.updatedAt
      : rateParsed.updatedAt
        ? Date.parse(rateParsed.updatedAt)
        : NaN
  if (Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs > MAX_RATE_AGE_MS) {
    throw new AppError('RATE_STALE', `Rate for ${data.coin}/PKR is stale — please retry shortly`, 503)
  }

  const feeConfig = await db.platformConfig.findUnique({ where: { key: 'instant_buy_fee_pct' } })
  const feePct = feeConfig ? parseFloat(feeConfig.value) : 1.5

  const depositAddrKey = `deposit_address_${data.coin.toLowerCase()}_${data.network.toLowerCase()}`
  const depositConfig = await db.platformConfig.findUnique({ where: { key: depositAddrKey } })

  // Calculate amounts
  const fiatAmount = data.paymentMode === 'pkr' ? data.amount : null
  const coinAmount = data.paymentMode === 'pkr' ? data.amount / rate : data.amount
  const fee = coinAmount * (feePct / 100)

  const orderRef = generateOrderRef('IB')
  const quoteExpiresAt = new Date(Date.now() + 30 * 60 * 1000)

  const order = await db.$transaction(async (tx) => {
    // SELECT FOR UPDATE — KYC check and daily limit increment must be atomic
    const [userRow] = await tx.$queryRaw<Array<{
      id: string; kycStatus: string; dailyBuyUsed: string; dailyBuyLimit: string; dailyBuyReset: Date | null
    }>>`
      SELECT id, "kycStatus", "dailyBuyUsed", "dailyBuyLimit", "dailyBuyReset"
      FROM "User" WHERE id = ${userId} FOR UPDATE
    `
    if (!userRow) throw Errors.NOT_FOUND('User')
    if (userRow.kycStatus !== 'approved') {
      throw new AppError('KYC_REQUIRED', 'KYC verification required to use instant buy', 403)
    }

    const now = new Date()
    const needsReset = userRow.dailyBuyReset && now > userRow.dailyBuyReset
    const effectiveUsed = needsReset ? 0 : Number(userRow.dailyBuyUsed)
    const fiatIncrement = data.paymentMode === 'pkr' ? data.amount : coinAmount * rate

    if (effectiveUsed + fiatIncrement > Number(userRow.dailyBuyLimit)) {
      throw new AppError('DAILY_LIMIT_EXCEEDED', `Daily buy limit of PKR ${userRow.dailyBuyLimit} would be exceeded`, 400)
    }

    const resetAt = new Date(now.getTime() + 24 * 60 * 60 * 1000)
    await tx.user.update({
      where: { id: userId },
      data: {
        dailyBuyUsed: needsReset ? fiatIncrement : { increment: fiatIncrement },
        ...(needsReset ? { dailyBuyReset: resetAt } : {}),
      },
    })

    return tx.instantBuyOrder.create({
      data: {
        orderRef,
        userId,
        coin: data.coin,
        network: data.network,
        paymentMode: data.paymentMode,
        fiatAmount,
        coinAmount,
        rate,
        fee,
        status: 'payment_pending',
        verificationStatus: 'pending_layer1',
        toAddress: data.destinationAddress,
        quoteExpiresAt,
      },
    })
  })

  // Replace the 'pending' marker with the real order id so a sequential retry
  // returns the same order instead of creating a new one.
  if (idemKey) {
    await redis.setex(idemKey, 86400, order.id)
  }

  return { order, depositAddress: depositConfig?.value ?? null }
}

// ─── getUserOrders ────────────────────────────────────────────────────────────

export async function getUserOrders(
  userId: string,
  params: { page?: number; limit?: number; status?: string },
) {
  const page = params.page ?? 1
  const limit = Math.min(params.limit ?? 20, 100)
  const skip = (page - 1) * limit

  const where: Record<string, unknown> = { userId }
  if (params.status) where.status = params.status

  const [orders, total] = await Promise.all([
    db.instantBuyOrder.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    db.instantBuyOrder.count({ where }),
  ])

  return {
    orders,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  }
}

// ─── getOrderById ─────────────────────────────────────────────────────────────

export async function getOrderById(orderId: string, userId: string) {
  const order = await db.instantBuyOrder.findUnique({ where: { id: orderId } })
  if (!order) throw Errors.NOT_FOUND('Order')
  if (order.userId !== userId) throw Errors.FORBIDDEN()
  return order
}

// ─── uploadPaymentProof ───────────────────────────────────────────────────────

export async function uploadPaymentProof(orderId: string, userId: string, proofUrl: string) {
  const order = await db.instantBuyOrder.findUnique({ where: { id: orderId } })
  if (!order) throw Errors.NOT_FOUND('Order')
  if (order.userId !== userId) throw Errors.FORBIDDEN()
  if (order.status !== 'payment_pending') {
    throw new AppError('INVALID_STATUS', `Order is in status ${order.status}, expected payment_pending`, 400)
  }

  assertCloudinaryUrl(proofUrl, 'proofUrl')

  const updated = await db.instantBuyOrder.update({
    where: { id: orderId },
    data: {
      status: 'payment_uploaded',
      paymentProofUrl: proofUrl,
    },
  })

  // Queue OCR verification
  await queues.ocr.add('verify', { orderId })

  return updated
}

// ─── confirmCryptoDeposit ─────────────────────────────────────────────────────

export async function confirmCryptoDeposit(orderId: string, userId: string, txHash: string) {
  const normalizedHash = txHash.trim()
  // Basic shape guard — accept EVM (0x + 64 hex) or other-chain hashes (>= 16 chars),
  // reject empty/garbage so we never record a meaningless "proof".
  const isEvmHash = /^0x[0-9a-fA-F]{64}$/.test(normalizedHash)
  if (!isEvmHash && normalizedHash.length < 16) {
    throw new AppError('INVALID_TX_HASH', 'A valid transaction hash is required', 400)
  }

  const order = await db.instantBuyOrder.findUnique({ where: { id: orderId } })
  if (!order) throw Errors.NOT_FOUND('Order')
  if (order.userId !== userId) throw Errors.FORBIDDEN()

  const validStatuses = ['payment_pending', 'payment_uploaded', 'admin_review']
  if (!validStatuses.includes(order.status)) {
    throw new AppError('INVALID_STATUS', `Cannot confirm deposit for order in status ${order.status}`, 400)
  }

  // Don't overwrite a hash already recorded (e.g. set authoritatively by the webhook).
  if (order.incomingTxHash && order.incomingTxHash !== normalizedHash) {
    throw new AppError('TX_HASH_ALREADY_SET', 'A transaction hash is already recorded for this order', 409)
  }

  // Reject a hash already claimed by a different order (replay / copy-paste).
  const duplicate = await db.instantBuyOrder.findFirst({
    where: { incomingTxHash: normalizedHash, id: { not: orderId } },
    select: { id: true },
  })
  if (duplicate) {
    throw new AppError('TX_HASH_IN_USE', 'This transaction hash is already associated with another order', 409)
  }

  // Status-guarded claim so a concurrent webhook can't be clobbered.
  const claimed = await db.instantBuyOrder.updateMany({
    where: { id: orderId, userId, incomingTxHash: null },
    data: { incomingTxHash: normalizedHash },
  })
  if (claimed.count === 0) {
    // Either it was just set concurrently or the same hash is already there — return current state.
    return db.instantBuyOrder.findUniqueOrThrow({ where: { id: orderId } })
  }

  return db.instantBuyOrder.findUniqueOrThrow({ where: { id: orderId } })
}
