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
  // Check idempotency
  if (data.idempotencyKey) {
    const idemKey = `idem:instantbuy:${data.idempotencyKey}`
    const existing = await redis.get(idemKey)
    if (existing) {
      const order = await db.instantBuyOrder.findUnique({ where: { id: existing } })
      if (order) return order
    }
  }

  // Check KYC
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { kycStatus: true, dailyBuyUsed: true, dailyBuyLimit: true, dailyBuyReset: true },
  })
  if (!user) throw Errors.NOT_FOUND('User')
  if (user.kycStatus !== 'approved') {
    throw new AppError('KYC_REQUIRED', 'KYC verification required to use instant buy', 403)
  }

  // Check daily limit
  const now = new Date()
  let dailyUsed = Number(user.dailyBuyUsed)
  if (user.dailyBuyReset && now > user.dailyBuyReset) {
    dailyUsed = 0
  }
  if (dailyUsed + data.amount > Number(user.dailyBuyLimit)) {
    throw new AppError(
      'DAILY_LIMIT_EXCEEDED',
      `Daily buy limit of PKR ${user.dailyBuyLimit} would be exceeded`,
      400,
    )
  }

  // Get live rate from Redis
  const rateKey = `rate:${data.coin}:PKR`
  const rateStr = await redis.get(rateKey)
  if (!rateStr) {
    throw new AppError('RATE_UNAVAILABLE', `Rate for ${data.coin}/PKR is not available`, 503)
  }
  const rate = parseFloat(rateStr)

  // Get fee config
  const feeConfig = await db.platformConfig.findUnique({
    where: { key: 'instant_buy_fee_pct' },
  })
  const feePct = feeConfig ? parseFloat(feeConfig.value) : 1.5 // default 1.5%

  // Calculate amounts
  const fiatAmount = data.paymentMode === 'pkr' ? data.amount : null
  const coinAmount = data.paymentMode === 'pkr' ? data.amount / rate : data.amount
  const fee = coinAmount * (feePct / 100)

  // Get deposit address from config
  const depositAddrKey = `deposit_address_${data.coin.toLowerCase()}_${data.network.toLowerCase()}`
  const depositConfig = await db.platformConfig.findUnique({
    where: { key: depositAddrKey },
  })

  const orderRef = generateOrderRef('IB')
  const quoteExpiresAt = new Date(Date.now() + 30 * 60 * 1000) // 30 minutes

  const order = await db.$transaction(async (tx) => {
    const newOrder = await tx.instantBuyOrder.create({
      data: {
        orderRef,
        userId,
        coin: data.coin,
        network: data.network,
        paymentMode: data.paymentMode,
        fiatAmount: fiatAmount,
        coinAmount,
        rate,
        fee,
        status: 'payment_pending',
        verificationStatus: 'pending_layer1',
        toAddress: data.destinationAddress,
        quoteExpiresAt,
      },
    })

    // Increment daily buy used
    const resetAt = new Date(now)
    resetAt.setHours(23, 59, 59, 999)
    await tx.user.update({
      where: { id: userId },
      data: {
        dailyBuyUsed: { increment: data.paymentMode === 'pkr' ? data.amount : coinAmount * rate },
        ...(user.dailyBuyReset && now < user.dailyBuyReset ? {} : { dailyBuyReset: resetAt }),
      },
    })

    return newOrder
  })

  // Store idempotency key
  if (data.idempotencyKey) {
    await redis.setex(`idem:instantbuy:${data.idempotencyKey}`, 86400, order.id)
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
  const order = await db.instantBuyOrder.findUnique({ where: { id: orderId } })
  if (!order) throw Errors.NOT_FOUND('Order')
  if (order.userId !== userId) throw Errors.FORBIDDEN()

  const validStatuses = ['payment_pending', 'payment_uploaded', 'admin_review']
  if (!validStatuses.includes(order.status)) {
    throw new AppError('INVALID_STATUS', `Cannot confirm deposit for order in status ${order.status}`, 400)
  }

  const updated = await db.instantBuyOrder.update({
    where: { id: orderId },
    data: {
      incomingTxHash: txHash,
    },
  })

  return updated
}
