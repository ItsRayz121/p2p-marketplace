import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate, optionalAuth } from '../middleware/auth.middleware'
import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { AppError, Errors } from '../lib/errors'
import { generateOrderRef } from '../lib/hash'
import { env } from '../lib/env'
import { queues } from '../queues/definitions'
import { logger } from '../lib/logger'
import { GAS_CHAINS, type GasChainId, toDbChain } from '../lib/gas/gas.chains'
import { getChainCapabilities, isPubliclyVisible, isOrderable, READINESS_BADGE, type ChainReadinessState } from '../lib/gas/chainMeta'

// ── Rate lookup helpers ───────────────────────────────────────────────────────

// Stablecoins pegged 1:1 to USD — always return 1.0 without Redis lookup
const STABLECOIN_SYMBOLS = new Set(['USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'USDP'])

async function getNativeUsdRate(priceSymbol: string): Promise<number> {
  if (STABLECOIN_SYMBOLS.has(priceSymbol.toUpperCase())) return 1.0

  const usdPkrStr = await redis.get('rate:USD_PKR')
  const usdPkrRate = usdPkrStr ? parseFloat(usdPkrStr) : 0

  if (priceSymbol === 'TRX') {
    const trxJson = await redis.get('rate:TRX')
    const trxPkr = trxJson ? (JSON.parse(trxJson) as { rate: number }).rate : 0
    return trxPkr > 0 && usdPkrRate > 0 ? trxPkr / usdPkrRate : 0
  }

  const raw = await redis.get(`rate:${priceSymbol}`)
  const pkrRate = raw ? (JSON.parse(raw) as { rate: number }).rate : 0
  return pkrRate > 0 && usdPkrRate > 0 ? pkrRate / usdPkrRate : 0
}

async function getUsdPkrRate(): Promise<number> {
  const v = await redis.get('rate:USD_PKR')
  return v ? parseFloat(v) : 280
}

// ── Markup helper — DB-driven per-chain platform fee ─────────────────────────

function chainMarkup(platformFeePercent: number): number {
  return 1 + platformFeePercent / 100
}

// Legacy fallback: used only for the old tier-based order flow
function getMarkupForChain(backendChainId: string | null): number {
  if (!backendChainId) return 1.5
  const legacyId = backendChainId === 'ETH' ? 'ETHEREUM' : backendChainId
  const cfg = GAS_CHAINS[legacyId as GasChainId]
  return cfg?.getMarkupMultiplier() ?? 1.5
}

// ── Address validation by addressType field ──────────────────────────────────

const ADDRESS_PATTERNS: Record<string, RegExp> = {
  TRC20: /^T[A-Za-z1-9]{33}$/,
  EVM:   /^0x[0-9a-fA-F]{40}$/,
  SOL:   /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  SUI:   /^0x[0-9a-fA-F]{64}$/,
}

function validateAddress(addr: string, addressType: string): boolean {
  const pattern = ADDRESS_PATTERNS[addressType]
  return pattern ? pattern.test(addr) : addr.length > 5
}

// ── Order schemas ─────────────────────────────────────────────────────────────

// New dynamic format: tokenConfigId + custom amount
const createOrderNewSchema = z.object({
  tokenConfigId:  z.string().min(1),
  amount:         z.number().positive(),
  toAddress:      z.string().min(1),
  idempotencyKey: z.string().optional(),
})

// Legacy format: chain + tier (kept for merchant backward compat)
const createOrderLegacySchema = z.object({
  chain:          z.enum(['TRON', 'BSC', 'ETHEREUM']).default('TRON'),
  tier:           z.enum(['SMALL', 'MEDIUM', 'LARGE', 'XLARGE', 'JUMBO']),
  toAddress:      z.string().min(1),
  idempotencyKey: z.string().optional(),
})

export async function gasFeeRoutes(app: FastifyInstance) {

  // ── GET /api/gas-fee/chains — DB-driven list ───────────────────────────────

  app.get('/gas-fee/chains', async (_req, reply) => {
    const dbChains = await db.gasChainConfig.findMany({
      orderBy: { displayOrder: 'asc' },
      include: { tokens: { where: { isActive: true }, orderBy: { displayOrder: 'asc' } } },
    })

    const chains = await Promise.all(
      dbChains.map(async (c) => {
        const readinessState = (c.readinessState ?? 'inactive') as ChainReadinessState
        const publiclyVisible = isPubliclyVisible(readinessState)
        const orderable       = isOrderable(readinessState)
        const badge           = READINESS_BADGE[readinessState]
        const capabilities    = getChainCapabilities(c.slug)

        // Check operational availability: needs backendChainId, deposit address, not paused
        let isAvailable = false
        if (c.isActive && c.backendChainId && orderable) {
          const legacyId = c.backendChainId === 'ETH' ? 'ETHEREUM' : c.backendChainId
          const chainCfg = GAS_CHAINS[legacyId as GasChainId]
          if (chainCfg) {
            const depositAddress = chainCfg.getDepositAddress()
            const hotWallet = await db.gasHotWallet.findFirst({ where: { chain: toDbChain(legacyId as GasChainId), isActive: true } })
            const isPaused = await redis.get(`gas_wallet_paused:${c.backendChainId}`)
            isAvailable = !!(depositAddress && hotWallet && !isPaused)
          }
        }

        return {
          id:             c.id,
          slug:           c.slug,
          name:           c.name,
          symbol:         c.symbol,
          logoUrl:        c.logoUrl,
          category:       c.category,
          networkLabel:   c.networkLabel,
          addressType:    c.addressType,
          isActive:       c.isActive,
          isAvailable,
          publiclyVisible,
          orderable,
          readinessState,
          badge,
          capabilities,
          tokenCount:     c.tokens.length,
        }
      }),
    )

    // Public endpoint: filter to only visible chains (admin sees all via /admin/gas/chains)
    const visibleChains = chains.filter((c) => c.publiclyVisible)

    return reply.send({ success: true, data: { chains: visibleChains } })
  })

  // ── GET /api/gas-fee/chains/:chainSlug/tokens — tokens with live pricing ───

  app.get('/gas-fee/chains/:chainSlug/tokens', async (req, reply) => {
    const { chainSlug } = req.params as { chainSlug: string }
    const chainCfg = await db.gasChainConfig.findUnique({
      where: { slug: chainSlug.toUpperCase() },
    })
    if (!chainCfg) throw new AppError('CHAIN_NOT_SUPPORTED', `Chain '${chainSlug}' not found`, 404)
    if (!chainCfg.isActive) throw new AppError('CHAIN_NOT_SUPPORTED', `Chain '${chainSlug}' is not currently active`, 400)

    const tokens = await db.gasTokenConfig.findMany({
      where: { chainConfigId: chainCfg.id },
      orderBy: [{ isActive: 'desc' }, { displayOrder: 'asc' }],
    })

    const usdPkrRate = await getUsdPkrRate()
    const markup = chainMarkup(chainCfg.platformFeePercent)

    const tokensWithPricing = await Promise.all(
      tokens.map(async (t) => {
        // Inactive tokens don't need live pricing
        const nativeUsdRate = t.isActive ? await getNativeUsdRate(t.priceSymbol) : 0
        const rateStale = t.isActive && !(nativeUsdRate > 0)

        return {
          id:             t.id,
          name:           t.name,
          symbol:         t.symbol,
          tokenType:      t.tokenType,
          logoUrl:        t.logoUrl,
          priceSymbol:    t.priceSymbol,
          priceUsd:       nativeUsdRate,
          pricePkr:       nativeUsdRate * usdPkrRate,
          markup,
          minAmount:      Number(t.minAmount),
          maxUsdValue:    Number(t.maxUsdValue),
          presetAmounts:  t.presetAmounts as number[],
          isActive:       t.isActive,
          rateStale,
        }
      }),
    )

    return reply.send({
      success: true,
      data: {
        chain: {
          id:           chainCfg.id,
          slug:         chainCfg.slug,
          name:         chainCfg.name,
          symbol:       chainCfg.symbol,
          networkLabel: chainCfg.networkLabel,
          addressType:  chainCfg.addressType,
          explorerBase: chainCfg.explorerBase,
        },
        tokens: tokensWithPricing,
        updatedAt: new Date().toISOString(),
      },
    })
  })

  // ── GET /api/gas-fee/prices — legacy endpoint kept for backward compat ──────
  // Still works for existing merchant integrations using ?chain=TRON/BSC/ETHEREUM

  app.get('/gas-fee/prices', async (req, reply) => {
    const rawChain = ((req.query as { chain?: string }).chain?.toUpperCase()) ?? 'TRON'
    // Map legacy ETHEREUM → ETH slug
    const slug = rawChain === 'ETHEREUM' ? 'ETH' : rawChain
    const chainCfg = await db.gasChainConfig.findUnique({
      where: { slug },
      include: { tokens: { where: { isActive: true }, take: 1, orderBy: { displayOrder: 'asc' } } },
    })

    // Fall back to hardcoded GAS_CHAINS if DB has no entry
    const legacyId = rawChain === 'ETH' ? 'ETHEREUM' : rawChain
    const legacyConfig = GAS_CHAINS[legacyId as GasChainId]
    if (!chainCfg && !legacyConfig) {
      throw new AppError('CHAIN_NOT_SUPPORTED', `Chain '${rawChain}' is not supported`, 400)
    }

    const usdPkrStr = await redis.get('rate:USD_PKR')
    const usdPkrRate = usdPkrStr ? parseFloat(usdPkrStr) : 280
    const priceSymbol = chainCfg?.tokens[0]?.priceSymbol ?? (legacyId === 'ETHEREUM' ? 'ETH' : legacyId === 'BSC' ? 'BNB' : 'TRX')
    const nativeUsdRate = await getNativeUsdRate(priceSymbol)
    const nativePkrRate = nativeUsdRate * usdPkrRate
    const markup = getMarkupForChain(chainCfg?.backendChainId ?? rawChain)
    const nativeSymbol = chainCfg?.symbol ?? legacyConfig?.nativeSymbol ?? rawChain
    const tierAmounts = legacyConfig?.nativeTierAmounts ?? { SMALL: 10, MEDIUM: 50, LARGE: 100, XLARGE: 200, JUMBO: 500 }
    const rateStale = !(nativeUsdRate > 0)

    if (rateStale) {
      logger.warn({ chain: rawChain }, 'rate missing/zero on /gas-fee/prices — is the rate-updater job running?')
    }

    const tiers = Object.entries(tierAmounts).map(([name, nativeAmount]) => ({
      id:           name.toLowerCase(),
      name,
      nativeAmount,
      nativeSymbol,
      usdtPrice:    (nativeAmount * nativeUsdRate * markup).toFixed(2),
      pkrPrice:     (nativeAmount * nativePkrRate * markup).toFixed(0),
    }))

    return reply.send({
      success: true,
      data: {
        chain: rawChain,
        tiers,
        nativePriceUsd: nativeUsdRate,
        rateStale,
        updatedAt: new Date().toISOString(),
      },
    })
  })

  // ── POST /api/gas-fee/orders — new dynamic format + legacy ─────────────────

  app.post('/gas-fee/orders', { preHandler: [optionalAuth] }, async (req, reply) => {
    const body = req.body as Record<string, unknown>

    // Detect new vs legacy format
    const isNewFormat = typeof body.tokenConfigId === 'string'

    if (isNewFormat) {
      return handleNewOrderFormat(req, reply, body)
    } else {
      return handleLegacyOrderFormat(req, reply, body)
    }
  })

  // ── New order format handler ───────────────────────────────────────────────

  async function handleNewOrderFormat(req: Parameters<typeof handleLegacyOrderFormat>[0], reply: Parameters<typeof handleLegacyOrderFormat>[1], body: Record<string, unknown>) {
    const parsed = createOrderNewSchema.safeParse(body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }
    const { tokenConfigId, amount, toAddress, idempotencyKey } = parsed.data

    // Load token config + chain config
    const tokenCfg = await db.gasTokenConfig.findUnique({
      where: { id: tokenConfigId },
      include: { chain: true },
    })
    if (!tokenCfg || !tokenCfg.isActive) {
      throw new AppError('CHAIN_NOT_SUPPORTED', 'Gas token not found or inactive', 404)
    }
    const chainCfg = tokenCfg.chain
    if (!chainCfg.isActive) {
      throw new AppError('CHAIN_NOT_SUPPORTED', `${chainCfg.name} gas is not active`, 400)
    }
    if (!chainCfg.backendChainId) {
      throw new AppError('CHAIN_NOT_SUPPORTED', `${chainCfg.name} gas delivery is coming soon`, 400)
    }

    // Validate address
    if (!validateAddress(toAddress, chainCfg.addressType)) {
      throw new AppError('INVALID_ADDRESS', `Invalid ${chainCfg.networkLabel} address format`, 400)
    }

    // Map to legacy chain infra
    const legacyId = chainCfg.backendChainId === 'ETH' ? 'ETHEREUM' : chainCfg.backendChainId
    const legacyChainConfig = GAS_CHAINS[legacyId as GasChainId]
    if (!legacyChainConfig) {
      throw new AppError('CHAIN_NOT_SUPPORTED', `${chainCfg.name} gas delivery not configured`, 400)
    }

    const depositAddress = legacyChainConfig.getDepositAddress()
    if (!depositAddress) {
      throw new AppError('CHAIN_NOT_SUPPORTED', `${chainCfg.name} gas is not yet available`, 400)
    }

    const hotWallet = await db.gasHotWallet.findFirst({
      where: { chain: toDbChain(legacyId as GasChainId), isActive: true },
    })
    const isAutoPaused = await redis.get(`gas_wallet_paused:${chainCfg.backendChainId}`)
    if (!hotWallet || isAutoPaused) {
      throw new AppError('GAS_UNAVAILABLE', `Gas is temporarily unavailable for ${chainCfg.name}. Please try again later.`, 503)
    }

    // Validate amount bounds
    const minAmount = Number(tokenCfg.minAmount)
    const maxUsdValue = Number(tokenCfg.maxUsdValue)
    if (amount < minAmount) {
      throw new AppError('VALIDATION_ERROR', `Minimum amount is ${minAmount} ${tokenCfg.symbol}`, 400)
    }

    // Rate + USD value check
    const nativeUsdRate = await getNativeUsdRate(tokenCfg.priceSymbol)
    if (!(nativeUsdRate > 0)) {
      logger.error({ chain: chainCfg.slug }, 'native USD rate missing — cannot create gas order')
      throw new AppError('RATE_UNAVAILABLE', 'Exchange rate is temporarily unavailable. Please try again in a moment.', 503)
    }

    const markup = chainMarkup(chainCfg.platformFeePercent)
    const gasAmountUSD  = amount * nativeUsdRate
    const paymentAmount = gasAmountUSD * markup

    if (gasAmountUSD > maxUsdValue) {
      throw new AppError('VALIDATION_ERROR', `Maximum order value is $${maxUsdValue} USD. Reduce the amount.`, 400)
    }

    // IP rate limit
    const clientIp = req.ip ?? 'unknown'
    const clockHour = Math.floor(Date.now() / 3_600_000)
    const rlKey = `gas_rl:${clientIp}:${clockHour}`
    const rlCount = await redis.incr(rlKey)
    if (rlCount === 1) await redis.expire(rlKey, 3600)
    if (rlCount > 3) {
      throw new AppError('RATE_LIMITED', 'Maximum 3 gas fee orders per hour per IP', 429)
    }

    // Idempotency
    const idempKey = (req.headers['idempotency-key'] as string | undefined) ?? idempotencyKey
    if (idempKey) {
      const idemRedisKey = `idem:gasfee:${idempKey}`
      const existingId = await redis.get(idemRedisKey)
      if (existingId) {
        const existing = await db.gasFeeOrder.findUnique({ where: { id: existingId } })
        if (existing) {
          return reply.send({ success: true, data: { ...existing, paymentAddress: depositAddress } })
        }
      }
    }

    const userId = req.user?.id ?? null

    // Guest daily spend check
    if (!userId) {
      const today    = new Date().toISOString().slice(0, 10)
      const spendKey = `gas_guest_spend:${clientIp}:${today}`
      const currentSpend = parseFloat((await redis.get(spendKey)) ?? '0')
      if (currentSpend + paymentAmount > env.GAS_GUEST_DAILY_LIMIT_USD) {
        throw new AppError(
          'GUEST_LIMIT_EXCEEDED',
          `Guest orders are limited to $${env.GAS_GUEST_DAILY_LIMIT_USD} per day. Please create an account for higher limits.`,
          400,
        )
      }
    }

    // Same-destination daily limit (guests)
    if (!userId) {
      const todayStart = new Date()
      todayStart.setHours(0, 0, 0, 0)
      const destCount = await db.gasFeeOrder.count({ where: { toAddress, createdAt: { gte: todayStart } } })
      if (destCount >= 2) {
        throw new AppError('DEST_LIMIT_EXCEEDED', 'Maximum 2 gas orders to the same destination per day for guest users.', 400)
      }
    }

    // Create order — use chain enum from backendChainId
    const dbChainEnum = chainCfg.backendChainId as 'TRON' | 'BSC' | 'ETH' | 'SOL' | 'MATIC' | 'ARB' | 'BASE' | 'TON'
    const orderRef  = generateOrderRef('GF')
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000)

    const order = await db.gasFeeOrder.create({
      data: {
        orderRef,
        ...(userId ? { userId } : {}),
        ipAddress:       clientIp,
        chain:           dbChainEnum,
        tier:            null,
        gasTokenConfigId: tokenCfg.id,
        gasAmountNative: amount,
        gasAmountUSD,
        priceAtOrder:   nativeUsdRate,
        paymentCoin:    'USDT',
        paymentNetwork:  legacyChainConfig.networkLabel,
        paymentAmount,
        toAddress,
        fromHotWallet:  hotWallet.address,
        status:         'payment_pending',
        expiresAt,
      },
    })

    await queues.gasFee.add('expire-order', { orderId: order.id }, { delay: 5 * 60 * 1000, jobId: `gas-expire-${order.id}` })

    if (!userId) {
      const today    = new Date().toISOString().slice(0, 10)
      const spendKey = `gas_guest_spend:${clientIp}:${today}`
      await redis.incrbyfloat(spendKey, paymentAmount)
      await redis.expire(spendKey, 86400)
    }
    if (idempKey) {
      await redis.setex(`idem:gasfee:${idempKey}`, 86400, order.id)
    }

    return reply.code(201).send({
      success: true,
      data: {
        orderRef:        order.orderRef,
        paymentAddress:  depositAddress,
        paymentAmount:   order.paymentAmount.toString(),
        paymentNetwork:  order.paymentNetwork,
        gasAmountNative: order.gasAmountNative.toString(),
        nativeSymbol:    tokenCfg.symbol,
        chain:           order.chain,
        expiresAt:       order.expiresAt.toISOString(),
      },
    })
  }

  // ── Legacy order format handler ────────────────────────────────────────────

  async function handleLegacyOrderFormat(req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply, body: Record<string, unknown>) {
    const parsed = createOrderLegacySchema.safeParse(body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }
    const { chain, tier, toAddress } = parsed.data
    const chainConfig = GAS_CHAINS[chain]

    const idempotencyKey =
      (req.headers['idempotency-key'] as string | undefined) ??
      (body.idempotencyKey as string | undefined)

    if (!chainConfig.validateAddress(toAddress)) {
      throw new AppError('INVALID_ADDRESS', `Invalid ${chainConfig.networkLabel} address format`, 400)
    }

    const depositAddress = chainConfig.getDepositAddress()
    if (!depositAddress) {
      throw new AppError('CHAIN_NOT_SUPPORTED', `${chain} gas is not yet available.`, 400)
    }

    const hotWallet = await db.gasHotWallet.findFirst({ where: { chain: toDbChain(chain), isActive: true } })
    const isAutoPaused = await redis.get(`gas_wallet_paused:${toDbChain(chain)}`)
    if (!hotWallet || isAutoPaused) {
      throw new AppError('GAS_UNAVAILABLE', `Gas is temporarily unavailable for ${chain}. Please try again later.`, 503)
    }

    const clientIp = req.ip ?? 'unknown'
    const clockHour = Math.floor(Date.now() / 3_600_000)
    const rlKey = `gas_rl:${clientIp}:${clockHour}`
    const rlCount = await redis.incr(rlKey)
    if (rlCount === 1) await redis.expire(rlKey, 3600)
    if (rlCount > 3) throw new AppError('RATE_LIMITED', 'Maximum 3 gas fee orders per hour per IP', 429)

    if (idempotencyKey) {
      const idemRedisKey = `idem:gasfee:${idempotencyKey}`
      const existingId = await redis.get(idemRedisKey)
      if (existingId) {
        const existing = await db.gasFeeOrder.findUnique({ where: { id: existingId } })
        if (existing) return reply.send({ success: true, data: { ...existing, paymentAddress: depositAddress } })
      }
    }

    const priceSymbol = chain === 'TRON' ? 'TRX' : chain === 'BSC' ? 'BNB' : 'ETH'
    const nativeUsdRate = await getNativeUsdRate(priceSymbol)
    if (!(nativeUsdRate > 0)) {
      logger.error({ chain }, 'native USD rate missing — cannot create gas order')
      throw new AppError('RATE_UNAVAILABLE', 'Exchange rate is temporarily unavailable. Please try again in a moment.', 503)
    }
    const markup = chainConfig.getMarkupMultiplier()
    const gasAmountNative = chainConfig.nativeTierAmounts[tier]
    if (gasAmountNative === undefined) throw new AppError('VALIDATION_ERROR', `Tier '${tier}' is not supported for chain ${chain}`, 400)

    const gasAmountUSD  = gasAmountNative * nativeUsdRate
    const priceAtOrder  = nativeUsdRate
    const paymentAmount = gasAmountUSD * markup

    const userId = req.user?.id ?? null
    if (!userId) {
      const today    = new Date().toISOString().slice(0, 10)
      const spendKey = `gas_guest_spend:${clientIp}:${today}`
      const currentSpend = parseFloat((await redis.get(spendKey)) ?? '0')
      if (currentSpend + paymentAmount > env.GAS_GUEST_DAILY_LIMIT_USD) {
        throw new AppError('GUEST_LIMIT_EXCEEDED', `Guest orders are limited to $${env.GAS_GUEST_DAILY_LIMIT_USD} per day.`, 400)
      }
      const todayStart = new Date()
      todayStart.setHours(0, 0, 0, 0)
      const destCount = await db.gasFeeOrder.count({ where: { toAddress, createdAt: { gte: todayStart } } })
      if (destCount >= 2) throw new AppError('DEST_LIMIT_EXCEEDED', 'Maximum 2 gas orders to the same destination per day for guest users.', 400)
    }

    const orderRef  = generateOrderRef('GF')
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000)

    const order = await db.gasFeeOrder.create({
      data: {
        orderRef,
        ...(userId ? { userId } : {}),
        ipAddress:      clientIp,
        chain:          toDbChain(chain),
        tier,
        gasAmountNative,
        gasAmountUSD,
        priceAtOrder,
        paymentCoin:    'USDT',
        paymentNetwork: chainConfig.networkLabel,
        paymentAmount,
        toAddress,
        fromHotWallet:  hotWallet.address,
        status:         'payment_pending',
        expiresAt,
      },
    })

    await queues.gasFee.add('expire-order', { orderId: order.id }, { delay: 5 * 60 * 1000, jobId: `gas-expire-${order.id}` })

    if (!userId) {
      const today    = new Date().toISOString().slice(0, 10)
      const spendKey = `gas_guest_spend:${clientIp}:${today}`
      await redis.incrbyfloat(spendKey, paymentAmount)
      await redis.expire(spendKey, 86400)
    }
    if (idempotencyKey) {
      await redis.setex(`idem:gasfee:${idempotencyKey}`, 86400, order.id)
    }

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
  }

  // ── GET /api/gas-fee/orders/history — requires auth, paginated ───────────

  app.get('/gas-fee/orders/history', { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id
    const querySchema = z.object({
      page:  z.coerce.number().int().positive().default(1),
      limit: z.coerce.number().int().min(1).max(50).default(20),
    })
    const { page, limit } = querySchema.parse(req.query)
    const skip = (page - 1) * limit

    const [orders, total] = await Promise.all([
      db.gasFeeOrder.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          orderRef:        true,
          chain:           true,
          tier:            true,
          gasAmountNative: true,
          paymentAmount:   true,
          paymentNetwork:  true,
          toAddress:       true,
          deliveryTxHash:  true,
          refundTxHash:    true,
          status:          true,
          createdAt:       true,
          deliveredAt:     true,
          refundedAt:      true,
          gasTokenConfig:  { select: { name: true, symbol: true } },
        },
      }),
      db.gasFeeOrder.count({ where: { userId } }),
    ])

    return reply.send({
      success: true,
      data: {
        orders,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      },
    })
  })

  // ── GET /gas-fee/pkr-methods — admin-configured PKR payment accounts ────────

  app.get('/gas-fee/pkr-methods', async (_req, reply) => {
    const keys = [
      'gas_pkr_bank_name', 'gas_pkr_bank_account_name', 'gas_pkr_bank_iban', 'gas_pkr_bank_account_number',
      'gas_pkr_easypaisa_number', 'gas_pkr_easypaisa_name',
      'gas_pkr_jazzcash_number', 'gas_pkr_jazzcash_name',
    ]
    const configs = await db.platformConfig.findMany({ where: { key: { in: keys } } })
    const map: Record<string, string> = {}
    configs.forEach(c => { map[c.key] = c.value })
    return reply.send({
      success: true,
      data: {
        bank: {
          bankName:      map['gas_pkr_bank_name'] ?? null,
          accountName:   map['gas_pkr_bank_account_name'] ?? null,
          iban:          map['gas_pkr_bank_iban'] ?? null,
          accountNumber: map['gas_pkr_bank_account_number'] ?? null,
        },
        easypaisa: {
          number: map['gas_pkr_easypaisa_number'] ?? null,
          name:   map['gas_pkr_easypaisa_name'] ?? null,
        },
        jazzcash: {
          number: map['gas_pkr_jazzcash_number'] ?? null,
          name:   map['gas_pkr_jazzcash_name'] ?? null,
        },
      },
    })
  })

  // ── GET /gas-fee/crypto-methods — admin-configured USDT deposit addresses ──

  app.get('/gas-fee/crypto-methods', async (_req, reply) => {
    const configs = await db.platformConfig.findMany({
      where: { key: { in: ['gas_usdt_bep20_address', 'gas_usdt_aptos_address'] } },
    })
    const map: Record<string, string> = {}
    configs.forEach(c => { map[c.key] = c.value })
    return reply.send({
      success: true,
      data: {
        bep20: { address: map['gas_usdt_bep20_address'] ?? null, network: 'BEP20', fee: '~$0.29' },
        aptos: { address: map['gas_usdt_aptos_address'] ?? null, network: 'APTOS', fee: '~$0.01' },
      },
    })
  })

  // ── POST /gas-fee/orders/pkr — create PKR fiat payment gas order ───────────

  const createPkrOrderSchema = z.object({
    tokenConfigId:    z.string().min(1),
    amount:           z.number().positive(),
    toAddress:        z.string().min(1),
    pkrPaymentMethod: z.enum(['bank_transfer', 'easypaisa', 'jazzcash']),
    idempotencyKey:   z.string().optional(),
  })

  app.post('/gas-fee/orders/pkr', { preHandler: [authenticate] }, async (req, reply) => {
    const parsed = createPkrOrderSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }
    const { tokenConfigId, amount, toAddress, pkrPaymentMethod, idempotencyKey } = parsed.data
    const userId = req.user!.id

    const tokenCfg = await db.gasTokenConfig.findUnique({ where: { id: tokenConfigId }, include: { chain: true } })
    if (!tokenCfg || !tokenCfg.isActive) throw new AppError('CHAIN_NOT_SUPPORTED', 'Gas token not found or inactive', 404)
    const chainCfg = tokenCfg.chain
    if (!chainCfg.isActive) throw new AppError('CHAIN_NOT_SUPPORTED', `${chainCfg.name} gas is not active`, 400)
    if (!chainCfg.backendChainId) throw new AppError('CHAIN_NOT_SUPPORTED', `${chainCfg.name} gas delivery is coming soon`, 400)

    if (!validateAddress(toAddress, chainCfg.addressType)) {
      throw new AppError('INVALID_ADDRESS', `Invalid ${chainCfg.networkLabel} address format`, 400)
    }

    const legacyId = chainCfg.backendChainId === 'ETH' ? 'ETHEREUM' : chainCfg.backendChainId
    const legacyChainConfig = GAS_CHAINS[legacyId as GasChainId]
    if (!legacyChainConfig) throw new AppError('CHAIN_NOT_SUPPORTED', `${chainCfg.name} gas delivery not configured`, 400)

    const hotWallet = await db.gasHotWallet.findFirst({ where: { chain: toDbChain(legacyId as GasChainId), isActive: true } })
    const isAutoPaused = await redis.get(`gas_wallet_paused:${chainCfg.backendChainId}`)
    if (!hotWallet || isAutoPaused) throw new AppError('GAS_UNAVAILABLE', `Gas is temporarily unavailable for ${chainCfg.name}. Please try again later.`, 503)

    const minAmount = Number(tokenCfg.minAmount)
    if (amount < minAmount) throw new AppError('VALIDATION_ERROR', `Minimum amount is ${minAmount} ${tokenCfg.symbol}`, 400)

    const nativeUsdRate = await getNativeUsdRate(tokenCfg.priceSymbol)
    if (!(nativeUsdRate > 0)) throw new AppError('RATE_UNAVAILABLE', 'Exchange rate is temporarily unavailable. Please try again.', 503)

    const usdPkrRate = await getUsdPkrRate()
    const markup = chainMarkup(chainCfg.platformFeePercent)
    const gasAmountUSD  = amount * nativeUsdRate
    const maxUsdValue   = Number(tokenCfg.maxUsdValue)
    if (gasAmountUSD > maxUsdValue) throw new AppError('VALIDATION_ERROR', `Maximum order value is $${maxUsdValue} USD. Reduce the amount.`, 400)

    const paymentAmountUsd = gasAmountUSD * markup
    const pkrAmount        = paymentAmountUsd * usdPkrRate

    const idempKey = (req.headers['idempotency-key'] as string | undefined) ?? idempotencyKey
    if (idempKey) {
      const existingId = await redis.get(`idem:gasfee:pkr:${idempKey}`)
      if (existingId) {
        const existing = await db.gasFeeOrder.findUnique({ where: { id: existingId } })
        if (existing) return reply.send({ success: true, data: existing })
      }
    }

    const dbChainEnum = chainCfg.backendChainId as 'TRON' | 'BSC' | 'ETH' | 'SOL' | 'MATIC' | 'ARB' | 'BASE' | 'TON'
    const orderRef   = generateOrderRef('GF')
    const expiresAt  = new Date(Date.now() + 24 * 60 * 60 * 1000)

    const order = await db.gasFeeOrder.create({
      data: {
        orderRef,
        userId,
        ipAddress:        req.ip ?? 'unknown',
        chain:            dbChainEnum,
        gasTokenConfigId: tokenCfg.id,
        gasAmountNative:  amount,
        gasAmountUSD,
        priceAtOrder:     nativeUsdRate,
        paymentCoin:      'PKR',
        paymentNetwork:   pkrPaymentMethod.toUpperCase(),
        paymentAmount:    paymentAmountUsd,
        pkrAmount,
        pkrPaymentMethod,
        fromHotWallet:    hotWallet.address,
        toAddress,
        status:           'payment_pending',
        expiresAt,
      },
    })

    if (idempKey) await redis.setex(`idem:gasfee:pkr:${idempKey}`, 86400, order.id)
    await queues.gasFee.add('expire-order', { orderId: order.id }, { delay: 24 * 60 * 60 * 1000, jobId: `gas-expire-${order.id}` })

    logger.info({ orderId: order.id, userId, pkrAmount, pkrPaymentMethod }, 'PKR gas order created')

    return reply.code(201).send({
      success: true,
      data: {
        orderRef:        order.orderRef,
        paymentCoin:     'PKR',
        paymentNetwork:  pkrPaymentMethod,
        paymentAmount:   paymentAmountUsd.toFixed(2),
        pkrAmount:       pkrAmount.toFixed(0),
        gasAmountNative: order.gasAmountNative.toString(),
        nativeSymbol:    tokenCfg.symbol,
        chain:           order.chain,
        status:          order.status,
        expiresAt:       order.expiresAt.toISOString(),
      },
    })
  })

  // ── POST /gas-fee/orders/crypto — create USDT order with BEP20 or Aptos ────

  const createCryptoOrderSchema = z.object({
    tokenConfigId:   z.string().min(1),
    amount:          z.number().positive(),
    toAddress:       z.string().min(1),
    paymentNetwork:  z.enum(['BEP20', 'APTOS']),
    idempotencyKey:  z.string().optional(),
  })

  app.post('/gas-fee/orders/crypto', { preHandler: [optionalAuth] }, async (req, reply) => {
    const parsed = createCryptoOrderSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }
    const { tokenConfigId, amount, toAddress, paymentNetwork, idempotencyKey } = parsed.data

    const configKey = paymentNetwork === 'BEP20' ? 'gas_usdt_bep20_address' : 'gas_usdt_aptos_address'
    const depositConfig = await db.platformConfig.findUnique({ where: { key: configKey } })
    if (!depositConfig?.value) {
      throw new AppError('CHAIN_NOT_SUPPORTED', `USDT ${paymentNetwork} payment is not configured yet`, 400)
    }
    const depositAddress = depositConfig.value

    const tokenCfg = await db.gasTokenConfig.findUnique({ where: { id: tokenConfigId }, include: { chain: true } })
    if (!tokenCfg || !tokenCfg.isActive) throw new AppError('CHAIN_NOT_SUPPORTED', 'Gas token not found or inactive', 404)
    const chainCfg = tokenCfg.chain
    if (!chainCfg.isActive) throw new AppError('CHAIN_NOT_SUPPORTED', `${chainCfg.name} gas is not active`, 400)
    if (!chainCfg.backendChainId) throw new AppError('CHAIN_NOT_SUPPORTED', `${chainCfg.name} gas delivery is coming soon`, 400)

    if (!validateAddress(toAddress, chainCfg.addressType)) {
      throw new AppError('INVALID_ADDRESS', `Invalid ${chainCfg.networkLabel} address format`, 400)
    }

    const legacyId = chainCfg.backendChainId === 'ETH' ? 'ETHEREUM' : chainCfg.backendChainId
    const legacyChainConfig = GAS_CHAINS[legacyId as GasChainId]
    if (!legacyChainConfig) throw new AppError('CHAIN_NOT_SUPPORTED', `${chainCfg.name} gas delivery not configured`, 400)

    const hotWallet = await db.gasHotWallet.findFirst({ where: { chain: toDbChain(legacyId as GasChainId), isActive: true } })
    const isAutoPaused = await redis.get(`gas_wallet_paused:${chainCfg.backendChainId}`)
    if (!hotWallet || isAutoPaused) throw new AppError('GAS_UNAVAILABLE', `Gas is temporarily unavailable for ${chainCfg.name}. Please try again later.`, 503)

    const minAmount = Number(tokenCfg.minAmount)
    if (amount < minAmount) throw new AppError('VALIDATION_ERROR', `Minimum amount is ${minAmount} ${tokenCfg.symbol}`, 400)

    const nativeUsdRate = await getNativeUsdRate(tokenCfg.priceSymbol)
    if (!(nativeUsdRate > 0)) throw new AppError('RATE_UNAVAILABLE', 'Exchange rate is temporarily unavailable. Please try again.', 503)

    const markup = chainMarkup(chainCfg.platformFeePercent)
    const gasAmountUSD  = amount * nativeUsdRate
    const maxUsdValue   = Number(tokenCfg.maxUsdValue)
    if (gasAmountUSD > maxUsdValue) throw new AppError('VALIDATION_ERROR', `Maximum order value is $${maxUsdValue} USD. Reduce the amount.`, 400)
    const paymentAmount = gasAmountUSD * markup

    // IP rate limit
    const clientIp  = req.ip ?? 'unknown'
    const clockHour = Math.floor(Date.now() / 3_600_000)
    const rlKey     = `gas_rl:${clientIp}:${clockHour}`
    const rlCount   = await redis.incr(rlKey)
    if (rlCount === 1) await redis.expire(rlKey, 3600)
    if (rlCount > 3) throw new AppError('RATE_LIMITED', 'Maximum 3 gas fee orders per hour per IP', 429)

    const idempKey = (req.headers['idempotency-key'] as string | undefined) ?? idempotencyKey
    if (idempKey) {
      const existingId = await redis.get(`idem:gasfee:crypto:${idempKey}`)
      if (existingId) {
        const existing = await db.gasFeeOrder.findUnique({ where: { id: existingId } })
        if (existing) return reply.send({ success: true, data: { ...existing, paymentAddress: depositAddress } })
      }
    }

    const userId = req.user?.id ?? null
    if (!userId) {
      const today    = new Date().toISOString().slice(0, 10)
      const spendKey = `gas_guest_spend:${clientIp}:${today}`
      const cur = parseFloat((await redis.get(spendKey)) ?? '0')
      if (cur + paymentAmount > env.GAS_GUEST_DAILY_LIMIT_USD) {
        throw new AppError('GUEST_LIMIT_EXCEEDED', `Guest orders are limited to $${env.GAS_GUEST_DAILY_LIMIT_USD} per day.`, 400)
      }
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
      const destCount = await db.gasFeeOrder.count({ where: { toAddress, createdAt: { gte: todayStart } } })
      if (destCount >= 2) throw new AppError('DEST_LIMIT_EXCEEDED', 'Maximum 2 gas orders to the same destination per day for guest users.', 400)
    }

    const dbChainEnum = chainCfg.backendChainId as 'TRON' | 'BSC' | 'ETH' | 'SOL' | 'MATIC' | 'ARB' | 'BASE' | 'TON'
    const orderRef   = generateOrderRef('GF')
    const expiresAt  = new Date(Date.now() + 15 * 60 * 1000)

    const order = await db.gasFeeOrder.create({
      data: {
        orderRef,
        ...(userId ? { userId } : {}),
        ipAddress:        clientIp,
        chain:            dbChainEnum,
        gasTokenConfigId: tokenCfg.id,
        gasAmountNative:  amount,
        gasAmountUSD,
        priceAtOrder:     nativeUsdRate,
        paymentCoin:      'USDT',
        paymentNetwork,
        paymentAmount,
        fromHotWallet:    hotWallet.address,
        toAddress,
        status:           'payment_pending',
        expiresAt,
      },
    })

    if (idempKey) await redis.setex(`idem:gasfee:crypto:${idempKey}`, 86400, order.id)
    if (!userId) {
      const today    = new Date().toISOString().slice(0, 10)
      const spendKey = `gas_guest_spend:${clientIp}:${today}`
      await redis.incrbyfloat(spendKey, paymentAmount)
      await redis.expire(spendKey, 86400)
    }
    await queues.gasFee.add('expire-order', { orderId: order.id }, { delay: 15 * 60 * 1000, jobId: `gas-expire-${order.id}` })

    return reply.code(201).send({
      success: true,
      data: {
        orderRef:        order.orderRef,
        paymentAddress:  depositAddress,
        paymentAmount:   order.paymentAmount.toString(),
        paymentNetwork,
        gasAmountNative: order.gasAmountNative.toString(),
        nativeSymbol:    tokenCfg.symbol,
        chain:           order.chain,
        status:          order.status,
        expiresAt:       order.expiresAt.toISOString(),
      },
    })
  })

  // ── POST /gas-fee/orders/:orderRef/proof — submit PKR payment proof ─────────

  const proofSchema = z.object({ proofUrl: z.string().url().min(1) })

  // Only accept Cloudinary-hosted proof screenshots
  function isAllowedProofUrl(url: string): boolean {
    try {
      const { hostname } = new URL(url)
      return hostname === 'res.cloudinary.com' || hostname.endsWith('.cloudinary.com')
    } catch { return false }
  }

  app.post('/gas-fee/orders/:orderRef/proof', { preHandler: [authenticate] }, async (req, reply) => {
    const { orderRef } = req.params as { orderRef: string }
    const parsed = proofSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'proofUrl is required', 400)

    if (!isAllowedProofUrl(parsed.data.proofUrl)) {
      throw new AppError('VALIDATION_ERROR', 'Payment proof must be uploaded via the platform uploader (invalid URL domain)', 400)
    }

    const order = await db.gasFeeOrder.findUnique({ where: { orderRef } })
    if (!order) throw Errors.NOT_FOUND('Gas fee order')
    if (order.userId !== req.user!.id) throw new AppError('FORBIDDEN', 'Not your order', 403)

    if (order.paymentCoin !== 'PKR') {
      throw new AppError('INVALID_STATUS', 'Proof upload is only for PKR payment orders', 400)
    }
    if (order.expiresAt < new Date()) {
      throw new AppError('ORDER_EXPIRED', 'This order has expired. Please create a new order.', 400)
    }
    if (order.status !== 'payment_pending') {
      throw new AppError('INVALID_STATUS', `Cannot submit proof for order in status ${order.status}`, 400)
    }

    const updated = await db.gasFeeOrder.update({
      where: { orderRef },
      data: { status: 'payment_uploaded', paymentProofUrl: parsed.data.proofUrl },
    })

    logger.info({ orderRef, userId: req.user!.id }, 'PKR payment proof submitted')

    return reply.send({ success: true, data: { orderRef: updated.orderRef, status: updated.status } })
  })

  // ── POST /api/gas-fee/orders/wallet — REMOVED (was BKR wallet deduction) ───
  // Replaced by /orders/pkr (PKR fiat) and /orders/crypto (USDT BEP20/Aptos)

  app.post('/gas-fee/orders/wallet', async (_req, reply) => {
    return reply.code(410).send({ success: false, error: { code: 'GONE', message: 'Use /gas-fee/orders/pkr or /gas-fee/orders/crypto instead.' } })
  })


  // ── POST /gas-fee/custom-request — admin notification for unsupported chains ─

  const customRequestSchema = z.object({
    blockchainName: z.string().min(1).max(100),
    token:          z.string().min(1).max(50),
    amount:         z.string().optional(),
    purpose:        z.string().min(1),
    urgency:        z.enum(['low', 'normal', 'urgent']),
    details:        z.string().max(500).optional(),
    contactEmail:   z.string().email().optional(),
  })

  app.post('/gas-fee/custom-request', async (req, reply) => {
    const parsed = customRequestSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }

    // Rate limit: 3 custom requests per IP per day
    const clientIp = req.ip ?? 'unknown'
    const today = new Date().toISOString().slice(0, 10)
    const rlKey = `gas_custom_req:${clientIp}:${today}`
    const rlCount = await redis.incr(rlKey)
    if (rlCount === 1) await redis.expire(rlKey, 86400)
    if (rlCount > 3) {
      throw new AppError('RATE_LIMITED', 'Maximum 3 custom requests per day', 429)
    }

    const request = await db.gasCustomRequest.create({
      data: {
        blockchainName: parsed.data.blockchainName,
        token:          parsed.data.token,
        amount:         parsed.data.amount ?? null,
        purpose:        parsed.data.purpose,
        urgency:        parsed.data.urgency,
        details:        parsed.data.details ?? null,
        contactEmail:   parsed.data.contactEmail ?? null,
        ipAddress:      clientIp,
      },
    })

    logger.info({ customGasRequestId: request.id, blockchainName: request.blockchainName }, 'Custom gas fee request saved')
    return reply.code(201).send({ success: true, data: { message: 'Request received. Our team will review and contact you within 24 hours.' } })
  })

  // ── GET /api/gas-fee/orders/:orderRef — no auth ───────────────────────────

  app.get('/gas-fee/orders/:orderRef', async (req, reply) => {
    const { orderRef } = req.params as { orderRef: string }
    const order = await db.gasFeeOrder.findUnique({
      where: { orderRef },
      include: { gasTokenConfig: { select: { name: true, symbol: true, logoUrl: true } } },
    })
    if (!order) throw Errors.NOT_FOUND('Gas fee order')
    return reply.send({ success: true, data: order })
  })

  // ── GET /api/gas-fee/orders/:orderRef/refund-status — no auth ─────────────

  app.get('/gas-fee/orders/:orderRef/refund-status', async (req, reply) => {
    const { orderRef } = req.params as { orderRef: string }
    const order = await db.gasFeeOrder.findUnique({
      where: { orderRef },
      select: { orderRef: true, status: true, refundedAt: true, failureReason: true },
    })
    if (!order) throw Errors.NOT_FOUND('Gas fee order')
    return reply.send({
      success: true,
      data: {
        orderRef:      order.orderRef,
        status:        order.status,
        isRefunded:    order.status === 'refunded',
        refundedAt:    order.refundedAt,
        failureReason: order.failureReason,
      },
    })
  })
}
