import type { FastifyInstance } from 'fastify'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import bcrypt from 'bcryptjs'
import { authenticate } from '../middleware/auth.middleware'
import { merchantAuth } from '../middleware/merchantAuth.middleware'
import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { AppError, Errors } from '../lib/errors'
import { generateOrderRef } from '../lib/hash'
import { GAS_CHAINS, SUPPORTED_GAS_CHAINS, type GasChainId, toDbChain } from '../lib/gas/gas.chains'
import type { GasFeeOrderStatus } from '@prisma/client'
import { queues } from '../queues/definitions'
import { logger } from '../lib/logger'

// ── Shared rate helper (same as gasFee.routes.ts) ────────────────────────────

const RATE_COIN: Record<GasChainId, string> = {
  TRON: 'TRX', BSC: 'BNB', ETHEREUM: 'ETH',
  BASE: 'ETH', ARB: 'ETH', OP: 'ETH', MATIC: 'MATIC', AVAX: 'AVAX',
  SOL: 'SOL', TON: 'TON', SUI: 'SUI',
}

// ── DB-driven fee: reads platformFeeUsdt from GasChainConfig ─────────────────

async function getChainFee(chain: GasChainId): Promise<{ platformFeeUsdt: number; isActive: boolean | null }> {
  const slug = chain === 'ETHEREUM' ? 'ETH' : chain
  const dbChain = await db.gasChainConfig.findUnique({ where: { slug }, select: { platformFeeUsdt: true, isActive: true } })
  if (dbChain) {
    return { platformFeeUsdt: dbChain.platformFeeUsdt, isActive: dbChain.isActive }
  }
  logger.warn({ chain }, '[merchantGas] No DB chain config found — using default platform fee $0.25')
  return { platformFeeUsdt: 0.25, isActive: null }
}

async function getNativeUsdRate(chain: GasChainId): Promise<number> {
  const coin = RATE_COIN[chain]
  const usdPkrStr = await redis.get('rate:USD_PKR')
  const usdPkrRate = usdPkrStr ? parseFloat(usdPkrStr) : 0

  if (chain === 'TRON') {
    const trxJson = await redis.get('rate:TRX')
    const trxPkr = trxJson ? (JSON.parse(trxJson) as { rate: number }).rate : 0
    return trxPkr > 0 && usdPkrRate > 0 ? trxPkr / usdPkrRate : 0
  }

  const raw = await redis.get(`rate:${coin}`)
  const pkrRate = raw ? (JSON.parse(raw) as { rate: number }).rate : 0
  return pkrRate > 0 && usdPkrRate > 0 ? pkrRate / usdPkrRate : 0
}

// ── Key creation helper ───────────────────────────────────────────────────────

async function generateApiKey(): Promise<{ rawKey: string; keyId: string; keyHash: string; keyPrefix: string }> {
  const keyId  = randomBytes(6).toString('hex')          // 12 hex chars — unique lookup id
  const secret = randomBytes(32).toString('base64url')   // 43-char url-safe secret
  const rawKey = `mpak_${keyId}_${secret}`
  const keyHash = await bcrypt.hash(secret, 12)
  const keyPrefix = rawKey.slice(0, 14)                  // "mpak_" + first 9 chars — display only
  return { rawKey, keyId, keyHash, keyPrefix }
}

// ─────────────────────────────────────────────────────────────────────────────

export async function merchantGasRoutes(app: FastifyInstance) {

  // ── POST /merchant/keys — create API key (requires user JWT auth) ──────────

  app.post('/merchant/keys', { preHandler: [authenticate] }, async (req, reply) => {
    const schema = z.object({
      name:          z.string().min(1).max(100),
      webhookUrl:    z.string().url().optional(),
      webhookSecret: z.string().min(16).max(128).optional(),
      rateLimit:     z.number().int().min(10).max(600).default(60),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }

    const userId = req.user!.id

    // Cap at 10 active keys per user
    const existing = await db.merchantApiKey.count({ where: { userId, isActive: true } })
    if (existing >= 10) {
      throw new AppError('LIMIT_EXCEEDED', 'Maximum 10 active API keys per account', 400)
    }

    const { rawKey, keyId, keyHash, keyPrefix } = await generateApiKey()

    const key = await db.merchantApiKey.create({
      data: {
        userId,
        keyId,
        keyHash,
        keyPrefix,
        name:          parsed.data.name,
        rateLimit:     parsed.data.rateLimit,
        webhookUrl:    parsed.data.webhookUrl ?? null,
        webhookSecret: parsed.data.webhookSecret ?? null,
      },
    })

    logger.info({ userId, keyId: key.id, name: key.name }, 'Merchant API key created')

    return reply.code(201).send({
      success: true,
      data: {
        id:         key.id,
        name:       key.name,
        keyPrefix:  key.keyPrefix,
        rateLimit:  key.rateLimit,
        webhookUrl: key.webhookUrl,
        createdAt:  key.createdAt.toISOString(),
        // rawKey returned ONCE — not stored, cannot be recovered
        apiKey: rawKey,
      },
    })
  })

  // ── GET /merchant/keys — list my keys (no secrets returned) ───────────────

  app.get('/merchant/keys', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const keys = await db.merchantApiKey.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, name: true, keyPrefix: true, isActive: true,
        rateLimit: true, webhookUrl: true, lastUsedAt: true, createdAt: true,
      },
    })
    return reply.send({ success: true, data: { keys } })
  })

  // ── DELETE /merchant/keys/:id — revoke a key ──────────────────────────────

  app.delete('/merchant/keys/:id', { preHandler: [authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const userId = req.user!.id
    const key = await db.merchantApiKey.findFirst({ where: { id, userId } })
    if (!key) throw Errors.NOT_FOUND('API key')
    await db.merchantApiKey.update({ where: { id }, data: { isActive: false } })
    logger.info({ userId, keyId: id }, 'Merchant API key revoked')
    return reply.send({ success: true })
  })

  // ── PATCH /merchant/keys/:id/webhook — update webhook config ─────────────

  app.patch('/merchant/keys/:id/webhook', { preHandler: [authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const userId = req.user!.id
    const schema = z.object({
      webhookUrl:    z.string().url().nullable(),
      webhookSecret: z.string().min(16).max(128).nullable().optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }
    const key = await db.merchantApiKey.findFirst({ where: { id, userId } })
    if (!key) throw Errors.NOT_FOUND('API key')

    const updateData: { webhookUrl: string | null; webhookSecret?: string | null } = {
      webhookUrl: parsed.data.webhookUrl,
    }
    if (parsed.data.webhookSecret !== undefined) {
      updateData.webhookSecret = parsed.data.webhookSecret
    }

    await db.merchantApiKey.update({ where: { id }, data: updateData })
    return reply.send({ success: true })
  })

  // ── GET /merchant/gas/prices — public pricing (merchant key auth) ─────────

  app.get('/merchant/gas/prices', { preHandler: [merchantAuth] }, async (req, reply) => {
    const chain = ((req.query as { chain?: string }).chain?.toUpperCase() as GasChainId | undefined) ?? 'TRON'
    const chainConfig = GAS_CHAINS[chain as GasChainId]
    if (!chainConfig) throw new AppError('CHAIN_NOT_SUPPORTED', `Chain '${chain}' is not supported`, 400)

    const { platformFeeUsdt, isActive } = await getChainFee(chain as GasChainId)
    if (isActive === false) throw new AppError('CHAIN_NOT_SUPPORTED', `${chain} gas is not currently active`, 400)

    const usdPkrStr = await redis.get('rate:USD_PKR')
    const usdPkrRate = usdPkrStr ? parseFloat(usdPkrStr) : 280
    const nativeUsdRate = await getNativeUsdRate(chain as GasChainId)

    const tiers = Object.entries(chainConfig.nativeTierAmounts).map(([name, nativeAmount]) => {
      const gasValueUsd = nativeAmount * nativeUsdRate
      return {
        id:           name.toLowerCase(),
        name,
        nativeAmount,
        nativeSymbol: chainConfig.nativeSymbol,
        usdtPrice:    (gasValueUsd + platformFeeUsdt).toFixed(2),
        pkrPrice:     ((gasValueUsd + platformFeeUsdt) * usdPkrRate).toFixed(0),
      }
    })

    const chains = await Promise.all(
      SUPPORTED_GAS_CHAINS.map(async (chainId) => {
        const config = GAS_CHAINS[chainId]
        const depositAddress = config.getDepositAddress()
        const isPaused = await redis.get(`gas_wallet_paused:${toDbChain(chainId)}`)
        return {
          id:           chainId,
          nativeSymbol: config.nativeSymbol,
          networkLabel: config.networkLabel,
          isAvailable:  !!(depositAddress && !isPaused),
        }
      }),
    )

    return reply.send({
      success: true,
      data: { chain, tiers, chains, nativePriceUsd: nativeUsdRate, updatedAt: new Date().toISOString() },
    })
  })

  // ── POST /merchant/gas/orders — create gas order (merchant key auth) ──────

  const createOrderSchema = z.object({
    chain:          z.enum(['TRON', 'BSC', 'ETHEREUM']).default('TRON'),
    tier:           z.enum(['SMALL', 'MEDIUM', 'LARGE', 'XLARGE', 'JUMBO']),
    toAddress:      z.string().min(1),
    idempotencyKey: z.string().optional(),
  })

  app.post('/merchant/gas/orders', { preHandler: [merchantAuth] }, async (req, reply) => {
    const parsed = createOrderSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }

    const { chain, tier, toAddress } = parsed.data
    const chainConfig = GAS_CHAINS[chain]
    const merchantKeyId = req.merchantKey!.id

    // DB chain config: enforce isActive + get fixed platform fee
    const { platformFeeUsdt, isActive } = await getChainFee(chain as GasChainId)
    if (isActive === false) {
      throw new AppError('CHAIN_NOT_SUPPORTED', `${chain} gas is not currently active`, 400)
    }

    if (!chainConfig.validateAddress(toAddress)) {
      throw new AppError('INVALID_ADDRESS', `Invalid ${chainConfig.networkLabel} address format`, 400)
    }

    const depositAddress = chainConfig.getDepositAddress()
    if (!depositAddress) {
      throw new AppError('CHAIN_NOT_SUPPORTED', `${chain} gas is not yet available.`, 400)
    }

    const hotWallet = await db.gasHotWallet.findFirst({
      where: { chain: toDbChain(chain), isActive: true },
    })
    const isAutoPaused = await redis.get(`gas_wallet_paused:${chain}`)
    if (!hotWallet || isAutoPaused) {
      throw new AppError('GAS_UNAVAILABLE', `Gas is temporarily unavailable for ${chain}. Please try again later.`, 503)
    }

    // Idempotency check
    const idempotencyKey =
      (req.headers['idempotency-key'] as string | undefined) ?? parsed.data.idempotencyKey
    if (idempotencyKey) {
      const idemKey = `idem:merchant-gasfee:${idempotencyKey}`
      const existingId = await redis.get(idemKey)
      if (existingId) {
        const existing = await db.gasFeeOrder.findUnique({ where: { id: existingId } })
        if (existing) return reply.send({ success: true, data: { ...existing, paymentAddress: depositAddress } })
      }
    }

    const nativeUsdRate = await getNativeUsdRate(chain)
    if (!(nativeUsdRate > 0)) {
      throw new AppError('RATE_UNAVAILABLE', 'Exchange rate temporarily unavailable.', 503)
    }
    const gasAmountNative = chainConfig.nativeTierAmounts[tier]
    if (gasAmountNative === undefined) {
      throw new AppError('VALIDATION_ERROR', `Tier '${tier}' is not supported for chain ${chain}`, 400)
    }

    const gasAmountUSD  = gasAmountNative * nativeUsdRate
    const paymentAmount = gasAmountUSD + platformFeeUsdt
    const orderRef      = generateOrderRef('MG')
    const expiresAt     = new Date(Date.now() + 30 * 60 * 1000) // 30-minute window for merchants

    const order = await db.gasFeeOrder.create({
      data: {
        orderRef,
        merchantApiKeyId: merchantKeyId,
        ipAddress:        req.ip ?? 'merchant',
        chain:            toDbChain(chain),
        tier,
        gasAmountNative,
        gasAmountUSD,
        priceAtOrder:     nativeUsdRate,
        paymentCoin:      'USDT',
        paymentNetwork:   chainConfig.networkLabel,
        paymentAmount,
        toAddress,
        fromHotWallet:    hotWallet.address,
        status:           'payment_pending',
        expiresAt,
      },
    })

    await queues.gasFee.add(
      'expire-order',
      { orderId: order.id },
      { delay: 30 * 60 * 1000, jobId: `gas-expire-${order.id}` },
    )

    if (idempotencyKey) {
      await redis.setex(`idem:merchant-gasfee:${idempotencyKey}`, 86400, order.id)
    }

    logger.info({ orderId: order.id, orderRef, chain, merchantKeyId }, 'Merchant gas order created')

    return reply.code(201).send({
      success: true,
      data: {
        orderRef:        order.orderRef,
        paymentAddress:  depositAddress,
        paymentAmount:   order.paymentAmount.toString(),
        paymentNetwork:  order.paymentNetwork,
        gasAmountNative: order.gasAmountNative.toString(),
        nativeSymbol:    chainConfig.nativeSymbol,
        chain:           order.chain,
        expiresAt:       order.expiresAt.toISOString(),
      },
    })
  })

  // ── GET /merchant/gas/orders/:orderRef — poll order (merchant key auth) ───

  app.get('/merchant/gas/orders/:orderRef', { preHandler: [merchantAuth] }, async (req, reply) => {
    const { orderRef } = req.params as { orderRef: string }
    const merchantKeyId = req.merchantKey!.id

    const order = await db.gasFeeOrder.findFirst({
      where: { orderRef, merchantApiKeyId: merchantKeyId },
      select: {
        orderRef: true, chain: true, tier: true, status: true,
        gasAmountNative: true, paymentAmount: true, paymentNetwork: true,
        toAddress: true, deliveryTxHash: true, refundTxHash: true,
        expiresAt: true, createdAt: true, deliveredAt: true, refundedAt: true,
        failureReason: true,
      },
    })

    if (!order) throw Errors.NOT_FOUND('Gas order')

    return reply.send({ success: true, data: order })
  })

  // ── GET /merchant/gas/orders — list my orders (merchant key auth, paginated)

  app.get('/merchant/gas/orders', { preHandler: [merchantAuth] }, async (req, reply) => {
    const querySchema = z.object({
      page:   z.coerce.number().int().positive().default(1),
      limit:  z.coerce.number().int().min(1).max(100).default(50),
      status: z.string().optional(),
      chain:  z.string().optional(),
    })
    const { page, limit, status, chain } = querySchema.parse(req.query)
    const skip = (page - 1) * limit
    const merchantKeyId = req.merchantKey!.id

    const where = {
      merchantApiKeyId: merchantKeyId,
      ...(status ? { status: status as GasFeeOrderStatus } : {}),
      ...(chain  ? { chain: toDbChain(chain as GasChainId) } : {}),
    }

    const [orders, total] = await Promise.all([
      db.gasFeeOrder.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          orderRef: true, chain: true, tier: true, status: true,
          gasAmountNative: true, paymentAmount: true, toAddress: true,
          deliveryTxHash: true, refundTxHash: true,
          createdAt: true, deliveredAt: true,
        },
      }),
      db.gasFeeOrder.count({ where }),
    ])

    return reply.send({
      success: true,
      data: {
        orders,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      },
    })
  })
}
