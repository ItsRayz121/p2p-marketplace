import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate, optionalAuth, requireRole } from '../middleware/auth.middleware'
import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { AppError, Errors } from '../lib/errors'
import { generateOrderRef, generateTrackingToken } from '../lib/hash'
import { timingSafeEqual } from 'node:crypto'
import { env } from '../lib/env'
import { queues } from '../queues/definitions'
import { logger } from '../lib/logger'
import { GAS_CHAINS, type GasChainId, toDbChain } from '../lib/gas/gas.chains'
import { getChainCapabilities, isPubliclyVisible, isOrderable, READINESS_BADGE, type ChainReadinessState } from '../lib/gas/chainMeta'
import { flagIfRisky } from '../lib/gas/gas.risk'
import { getUsdtNetworkFeeUsd } from '../lib/gas/gas.fees'
import { tokenDeliverySupported } from '../lib/gas/gas.delivery'
import { getAptosHotWalletAddress } from '../lib/gas/aptosWalletService'
import { notifyMerchantWebhook } from '../lib/gas/gas.merchant'
import { isRefundEligible, refundWaitRemainingMs } from '../lib/gas/gas.refundWindow'
import {
  gasCancelIdentity,
  assertNotInGasCooldown,
  previewCancelPenalty,
  recordCancellation,
} from '../lib/gas/gas.cancellation'
import {
  reservePromo,
  recordRedemption,
  releaseReservation,
  previewPromo,
  promoIdentity,
  type PromoResolution,
} from '../lib/gas/gas.promo'
import { isFlagEnabled, FLAGS } from '../services/platformFlags.service'
import { bindReferral, getReferralSummary, withdrawReferralEarnings, setOwnCodeLabel } from '../lib/gas/gas.referral'
import {
  getAffiliateQuote,
  applyForAffiliate,
  getAffiliateOverview,
  createAffiliateLink,
  updateAffiliateLink,
  createOwnCustomLink,
  deleteOwnCustomLink,
} from '../lib/gas/gas.affiliate'

// Reserve a promo slot for an order about to be created. Returns null when no code
// was supplied or the promo system is off. Throws AppError (clear message) on an
// invalid/exhausted code. Caller MUST recordRedemption after a successful create,
// or releaseReservation if the create throws.
async function reserveOrderPromo(
  promoCode: string | undefined,
  orderUsd: number,
  marginUsdt: number,
  identity: string,
): Promise<PromoResolution | null> {
  if (!promoCode) return null
  if (!(await isFlagEnabled(FLAGS.GAS_PROMO))) {
    throw new AppError('PROMO_DISABLED', 'Promo codes are not available right now.', 400)
  }
  return reservePromo({ code: promoCode, orderUsd, marginUsdt, identity })
}

// Affiliate buyer auto-discount for an order. Fills the margin REMAINING after any promo
// discount, so a stacked promo is always honored in full and the combined discount can
// never exceed the margin (→ never below base gas cost). Returns the affiliate portion in
// USDT (0 when no affiliate binding / flag off / no room left). Margin-only, like promo.
async function affiliateOrderDiscount(
  buyerUserId: string | null,
  marginUsdt: number,
  promoDiscountUsdt: number,
): Promise<{ discountUsdt: number; referrer: string | null }> {
  if (!buyerUserId) return { discountUsdt: 0, referrer: null }
  const room = Math.max(0, Math.round((marginUsdt - promoDiscountUsdt) * 100) / 100)
  if (room <= 0) return { discountUsdt: 0, referrer: null }
  // getAffiliateQuote resolves the same discount AND the referrer's display name, so we
  // can snapshot the label onto the order for the post-refresh banner.
  const quote = await getAffiliateQuote(buyerUserId, marginUsdt)
  if (!quote) return { discountUsdt: 0, referrer: null }
  return { discountUsdt: Math.min(quote.discountUsdt, room), referrer: quote.referrerLabel }
}

// ── Guest tracking token validator ────────────────────────────────────────────

function isTrackingTokenValid(candidate: string | undefined, stored: string | null): boolean {
  if (!stored || !candidate) return false
  const a = Buffer.from(candidate, 'utf8')
  const b = Buffer.from(stored, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

// Orderability gate:
//   native token → only on chains with a native-delivery config (GAS_CHAINS), plus
//     Aptos: APT is not in GAS_CHAINS (it is an inbound rail) but native APT delivery
//     is implemented via 0x1::aptos_account::transfer, so native APT is allowed here.
//   non-native token → chain has a token-delivery impl AND a super-admin flipped
//     it live (after funding the hot wallet).
function isTokenOrderable(backendChainId: string | null, token: { tokenType: string; deliveryLive?: boolean }): boolean {
  if (!backendChainId) return false
  if (token.tokenType === 'native') {
    if (backendChainId === 'APT') return true
    const legacyId = backendChainId === 'ETH' ? 'ETHEREUM' : backendChainId
    return !!GAS_CHAINS[legacyId as GasChainId]
  }
  return tokenDeliverySupported(backendChainId) && token.deliveryLive === true
}

// ── Token config resolution (token override → chain default → system fallback) ─

const FALLBACK_PLATFORM_FEE  = 0.25
const FALLBACK_MIN_AMOUNT    = 0.1
const FALLBACK_MAX_USD_VALUE = 10

function resolveTokenConfig(
  token: { platformFeeUsdt: number | null; minAmount: unknown; maxUsdValue: unknown },
  chain: { platformFeeUsdt: number; defaultMinAmount: unknown; defaultMaxUsdValue: unknown },
) {
  return {
    platformFeeUsdt: token.platformFeeUsdt ?? chain.platformFeeUsdt ?? FALLBACK_PLATFORM_FEE,
    minAmount:       Number(token.minAmount   ?? chain.defaultMinAmount   ?? FALLBACK_MIN_AMOUNT),
    maxUsdValue:     Number(token.maxUsdValue ?? chain.defaultMaxUsdValue ?? FALLBACK_MAX_USD_VALUE),
  }
}

// ── Rate lookup helpers ───────────────────────────────────────────────────────

// Stablecoins pegged 1:1 to USD — always return 1.0 without Redis lookup
const STABLECOIN_SYMBOLS = new Set(['USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'USDP'])

interface NativeRateInfo {
  usdPrice: number
  source: string
  updatedAt: string | null
}

async function getNativeRateInfo(priceSymbol: string): Promise<NativeRateInfo> {
  const sym = priceSymbol.toUpperCase()
  if (STABLECOIN_SYMBOLS.has(sym)) {
    return { usdPrice: 1.0, source: 'hardcoded-stable', updatedAt: null }
  }

  const raw = await redis.get(`rate:${sym}`)
  if (!raw) return { usdPrice: 0, source: 'missing', updatedAt: null }

  const parsed = JSON.parse(raw) as { rate: number; usdPrice?: number; source?: string; updatedAt?: string }

  // Only accept new-format keys that carry usdPrice directly.
  // Legacy format (only `rate` in PKR) is NOT used — dividing an old PKR rate by
  // a changed USD/PKR rate yields wrong USD values (root cause of stale inflated prices).
  if (parsed.usdPrice !== undefined && parsed.usdPrice > 0) {
    return {
      usdPrice:  parsed.usdPrice,
      source:    parsed.source ?? 'cache',
      updatedAt: parsed.updatedAt ?? null,
    }
  }

  logger.warn({ sym }, 'getNativeRateInfo: legacy Redis key (no usdPrice) — returning 0 to force rate-stale UI')
  return { usdPrice: 0, source: 'legacy-key', updatedAt: null }
}

async function getNativeUsdRate(priceSymbol: string): Promise<number> {
  return (await getNativeRateInfo(priceSymbol)).usdPrice
}

async function getUsdPkrRate(): Promise<number> {
  const v = await redis.get('rate:USD_PKR')
  return v ? parseFloat(v) : 0
}

// ── Legacy fallback multiplier — kept only for the old tier-based merchant flow ─

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
  TON:   /^0:[0-9a-f]{64}$|^[UE][Qq][A-Za-z0-9+/\-_]{46}$/,
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
  promoCode:      z.string().trim().min(1).max(40).optional(),
})

// Legacy format: chain + tier (kept for merchant backward compat)
const createOrderLegacySchema = z.object({
  chain:          z.enum(['TRON', 'BSC', 'ETHEREUM']).default('TRON'),
  tier:           z.enum(['SMALL', 'MEDIUM', 'LARGE', 'XLARGE', 'JUMBO']),
  toAddress:      z.string().min(1),
  idempotencyKey: z.string().optional(),
})

// One unpaid order at a time: a user may not open a new gas order while they still
// have an abandonable `payment_pending` one. They must pay it (→ advances) or cancel
// it first. This stops the "awaiting payment" pileup from clicking New Order repeatedly.
// `payment_pending` is the only blocking state — it's the one the user can resolve
// themselves (uploaded/detected orders are already past their control).
async function assertNoUnpaidGasOrder(userId: string | null | undefined): Promise<void> {
  if (!userId) return
  const existing = await db.gasFeeOrder.findFirst({
    where: { userId, status: 'payment_pending' },
    orderBy: { createdAt: 'desc' },
    select: { orderRef: true },
  })
  if (existing) {
    throw new AppError(
      'UNPAID_ORDER_EXISTS',
      `You already have an unpaid gas order (${existing.orderRef}). Please pay or cancel it before starting a new one.`,
      409,
    )
  }
}

export async function gasFeeRoutes(app: FastifyInstance) {

  // ── GET /api/gas-fee/chains — DB-driven list ───────────────────────────────

  app.get('/gas-fee/chains', async (_req, reply) => {
    const dbChains = await db.gasChainConfig.findMany({
      where: { isVisibleToUsers: true, isArchived: false },
      orderBy: { displayOrder: 'asc' },
      include: { tokens: { where: { isActive: true, isVisibleToUsers: true, isArchived: false }, orderBy: { displayOrder: 'asc' } } },
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
          if (c.backendChainId === 'APT') {
            // Aptos has no GAS_CHAINS native-delivery config — it's reachable for
            // (live) fungible-asset token delivery via its derived hot wallet.
            const aptosAddr = getAptosHotWalletAddress()
            const isPaused  = await redis.get('gas_wallet_paused:APT')
            isAvailable = !!(aptosAddr && !isPaused)
          } else {
            const legacyId = c.backendChainId === 'ETH' ? 'ETHEREUM' : c.backendChainId
            const chainCfg = GAS_CHAINS[legacyId as GasChainId]
            if (chainCfg) {
              const depositAddress = chainCfg.getDepositAddress()
              const hotWallet = await db.gasHotWallet.findFirst({ where: { chain: toDbChain(legacyId as GasChainId), isActive: true } })
              const isPaused = await redis.get(`gas_wallet_paused:${c.backendChainId}`)
              isAvailable = !!(depositAddress && hotWallet && !isPaused)
            }
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
          platformFeeUsdt: c.platformFeeUsdt,
          tokenCount:     c.tokens.length,
        }
      }),
    )

    // Public endpoint: filter to only visible chains (admin sees all via /admin/gas/chains)
    const visibleChains = chains.filter((c) => c.publiclyVisible)

    // Surface the promo/referral master switches so the UI only renders those
    // entry points when live (default OFF = hidden, production unchanged).
    const [promoEnabled, referralEnabled] = await Promise.all([
      isFlagEnabled(FLAGS.GAS_PROMO),
      isFlagEnabled(FLAGS.GAS_REFERRAL),
    ])

    return reply.send({ success: true, data: { chains: visibleChains, promoEnabled, referralEnabled } })
  })

  // ── GET /api/gas-fee/chains/:chainSlug/tokens — tokens with live pricing ───

  app.get('/gas-fee/chains/:chainSlug/tokens', async (req, reply) => {
    const { chainSlug } = req.params as { chainSlug: string }
    const chainCfg = await db.gasChainConfig.findUnique({
      where: { slug: chainSlug.toUpperCase() },
    })
    if (!chainCfg) throw new AppError('CHAIN_NOT_SUPPORTED', `Chain '${chainSlug}' not found`, 404)
    if (!chainCfg.isActive) throw new AppError('CHAIN_NOT_SUPPORTED', `Chain '${chainSlug}' is not currently active`, 400)
    if (!chainCfg.isVisibleToUsers) throw new AppError('CHAIN_NOT_SUPPORTED', `Chain '${chainSlug}' is not available`, 400)
    if (chainCfg.isArchived) throw new AppError('CHAIN_NOT_SUPPORTED', `Chain '${chainSlug}' is not available`, 400)

    const tokens = await db.gasTokenConfig.findMany({
      where: { chainConfigId: chainCfg.id, isVisibleToUsers: true, isArchived: false },
      orderBy: [{ isActive: 'desc' }, { displayOrder: 'asc' }],
    })

    const usdPkrRate = await getUsdPkrRate()

    const tokensWithPricing = await Promise.all(
      tokens.map(async (t) => {
        // Native coins are always deliverable; non-native tokens become orderable
        // only once delivery is implemented for the chain AND a super-admin has
        // flipped the token live. Otherwise they surface as "coming soon".
        const deliverable = isTokenOrderable(chainCfg.backendChainId, t)
        // Inactive tokens don't need live pricing
        const rateInfo = t.isActive ? await getNativeRateInfo(t.priceSymbol) : { usdPrice: 0, source: 'inactive', updatedAt: null }
        const rawUsdPrice = rateInfo.usdPrice
        const rateStale   = t.isActive && deliverable && !(rawUsdPrice > 0)

        const resolved = resolveTokenConfig(t, chainCfg)

        return {
          id:              t.id,
          name:            t.name,
          symbol:          t.symbol,
          tokenType:       t.tokenType,
          logoUrl:         t.logoUrl,
          priceSymbol:     t.priceSymbol,
          // rawUsdPrice = live market rate, no markup applied
          rawUsdPrice,
          // priceUsd kept for backward compat — equals rawUsdPrice
          priceUsd:        rawUsdPrice,
          pricePkr:        rawUsdPrice * usdPkrRate,
          platformFeeUsdt: resolved.platformFeeUsdt,
          priceSource:     rateInfo.source,
          priceUpdatedAt:  rateInfo.updatedAt,
          minAmount:       resolved.minAmount,
          maxUsdValue:     resolved.maxUsdValue,
          presetAmounts:   t.presetAmounts as number[],
          isActive:        t.isActive && deliverable,
          comingSoon:      t.isActive && !deliverable,
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

  // ── GET /api/gas-fee/chains/:chainSlug/network-fee — live on-chain gas estimate ─
  // Returns the current network gas price and estimated cost for a standard transfer.
  // Cached in Redis for 30 s so we don't hammer RPCs on every page load.

  app.get('/gas-fee/chains/:chainSlug/network-fee', async (req, reply) => {
    const { chainSlug } = req.params as { chainSlug: string }
    const slug = chainSlug.toUpperCase()

    const cacheKey = `gas_network_fee:${slug}`
    const cached = await redis.get(cacheKey)
    if (cached) {
      return reply.send({ success: true, data: JSON.parse(cached) as object })
    }

    const chainCfg = await db.gasChainConfig.findUnique({
      where: { slug },
      include: { tokens: { where: { tokenType: 'native', isActive: true }, take: 1, orderBy: { displayOrder: 'asc' } } },
    })

    if (!chainCfg || !chainCfg.backendChainId) {
      return reply.send({ success: true, data: { supported: false } })
    }

    const dbChain = chainCfg.backendChainId

    // TRON: bandwidth-based, not gas-based
    if (dbChain === 'TRON') {
      const trxUsdPrice = await getNativeUsdRate('TRX')
      const feeTrx = 0.267 // typical cost when no bandwidth is available
      const data = {
        supported: true,
        model: 'bandwidth',
        symbol: 'TRX',
        estimatedFeeNative: feeTrx,
        estimatedFeeUsd: trxUsdPrice > 0 ? feeTrx * trxUsdPrice : null,
        note: 'TRON uses bandwidth instead of gas. Each transfer consumes ~270 bandwidth (free if you have 1,500+ TRX staked, otherwise ~0.267 TRX is burned).',
      }
      await redis.set(cacheKey, JSON.stringify(data), 'EX', 30)
      return reply.send({ success: true, data })
    }

    // EVM chains
    const legacyId = dbChain === 'ETH' ? 'ETHEREUM' : dbChain
    const gasChain = GAS_CHAINS[legacyId as GasChainId]
    if (!gasChain) return reply.send({ success: true, data: { supported: false } })

    try {
      const { getEvmGasPrice } = await import('../lib/evmRpc')
      const gasPriceWei = await getEvmGasPrice(gasChain.getRpcUrl(), dbChain)
      const feeWei = gasPriceWei * 21_000n
      const feeNative = Number(feeWei) / 1e18

      const priceSymbol = chainCfg.tokens[0]?.priceSymbol ?? gasChain.nativeSymbol
      const usdPrice = await getNativeUsdRate(priceSymbol)
      const feeUsd = usdPrice > 0 ? feeNative * usdPrice : null
      const gasPriceGwei = Number(gasPriceWei) / 1e9

      const data = {
        supported: true,
        model: 'gas',
        symbol: gasChain.nativeSymbol,
        gasPriceGwei,
        gasLimit: 21_000,
        estimatedFeeNative: feeNative,
        estimatedFeeUsd: feeUsd,
        note: `Standard transfer (21,000 gas × ${gasPriceGwei.toFixed(3)} Gwei)`,
      }
      await redis.set(cacheKey, JSON.stringify(data), 'EX', 30)
      return reply.send({ success: true, data })
    } catch {
      return reply.send({ success: true, data: { supported: false } })
    }
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
    await assertNotInGasCooldown(gasCancelIdentity(req.user?.id ?? null, req.ip))
    await assertNoUnpaidGasOrder(req.user?.id ?? null)
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
    const { tokenConfigId, amount, toAddress, idempotencyKey, promoCode } = parsed.data

    // Load token config + chain config
    const tokenCfg = await db.gasTokenConfig.findUnique({
      where: { id: tokenConfigId },
      include: { chain: true },
    })
    if (!tokenCfg || !tokenCfg.isActive) {
      throw new AppError('CHAIN_NOT_SUPPORTED', 'Gas token not found or inactive', 404)
    }
    // Non-native tokens are orderable only once delivery is implemented for the
    // chain AND the token has been flipped live by a super-admin.
    if (!isTokenOrderable(tokenCfg.chain.backendChainId, tokenCfg)) {
      throw new AppError('CHAIN_NOT_SUPPORTED', `${tokenCfg.symbol} delivery is coming soon`, 400)
    }
    const chainCfg = tokenCfg.chain
    if (!chainCfg.isActive) {
      throw new AppError('CHAIN_NOT_SUPPORTED', `${chainCfg.name} gas is not active`, 400)
    }
    // Archived chains/tokens are retired — not orderable even via a stale client.
    if (tokenCfg.isArchived || chainCfg.isArchived) {
      throw new AppError('CHAIN_NOT_SUPPORTED', `${tokenCfg.symbol} is no longer available`, 400)
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

    // Resolve config: token override → chain default → fallback
    const resolved = resolveTokenConfig(tokenCfg, chainCfg)
    if (amount < resolved.minAmount) {
      throw new AppError('VALIDATION_ERROR', `Minimum amount is ${resolved.minAmount} ${tokenCfg.symbol}`, 400)
    }

    // Rate + USD value check
    const nativeUsdRate = await getNativeUsdRate(tokenCfg.priceSymbol)
    if (!(nativeUsdRate > 0)) {
      logger.error({ chain: chainCfg.slug }, 'native USD rate missing — cannot create gas order')
      throw new AppError('RATE_UNAVAILABLE', 'Exchange rate is temporarily unavailable. Please try again in a moment.', 503)
    }

    const gasAmountUSD    = amount * nativeUsdRate
    const platformFeeUsdt = resolved.platformFeeUsdt
    // Round to 2 decimal places so users see and pay a clean amount (e.g. 0.16, not 0.1644)
    const paymentAmount   = Math.round((gasAmountUSD + platformFeeUsdt) * 100) / 100

    if (gasAmountUSD > resolved.maxUsdValue) {
      throw new AppError('VALIDATION_ERROR', `Maximum order value is $${resolved.maxUsdValue} USD. Reduce the amount.`, 400)
    }

    // IP rate limit
    const clientIp = req.ip ?? 'unknown'
    const clockHour = Math.floor(Date.now() / 3_600_000)
    const rlKey = `gas_rl:${clientIp}:${clockHour}`
    const rlCount = await redis.incr(rlKey)
    if (rlCount === 1) await redis.expire(rlKey, 3600)
    if (rlCount > 10) {
      throw new AppError('RATE_LIMITED', 'Maximum 10 gas fee orders per hour per IP', 429)
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
    const dbChainEnum = chainCfg.backendChainId as 'TRON' | 'BSC' | 'ETH' | 'SOL' | 'MATIC' | 'ARB' | 'BASE' | 'OP' | 'AVAX' | 'TON' | 'SUI'
    const orderRef      = generateOrderRef('GF')
    const trackingToken = generateTrackingToken()
    const expiresAt     = new Date(Date.now() + 5 * 60 * 1000)

    // Promo: reserve a margin-only discount and bake it into the amount the user
    // pays, BEFORE the order is persisted. Floored at the margin, so the final
    // amount can never drop below the base gas cost (gasAmountUSD).
    const promoIdent = promoIdentity(userId, clientIp)
    const promoRes = await reserveOrderPromo(promoCode, paymentAmount, platformFeeUsdt, promoIdent)
    const promoDisc = promoRes?.discountUsdt ?? 0
    const aff = await affiliateOrderDiscount(userId, platformFeeUsdt, promoDisc)
    const affDisc = aff.discountUsdt
    const totalDiscount = Math.round((promoDisc + affDisc) * 100) / 100
    const finalPaymentAmount = Math.round((paymentAmount - totalDiscount) * 100) / 100

    const order = await (async () => {
      try {
        return await db.gasFeeOrder.create({
          data: {
            orderRef,
            trackingToken,
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
            paymentAmount:   finalPaymentAmount,
            platformMarginUsdt: platformFeeUsdt,
            discountUsdt:    totalDiscount,
            affiliateDiscountUsdt: affDisc,
            affiliateReferrer:     aff.referrer,
            ...(promoRes ? { promoCodeId: promoRes.promoCodeId } : {}),
            toAddress,
            fromHotWallet:  hotWallet.address,
            status:         'payment_pending',
            expiresAt,
          },
        })
      } catch (e) {
        if (promoRes) await releaseReservation(promoRes)
        throw e
      }
    })()

    if (promoRes) {
      await recordRedemption({ resolution: promoRes, orderId: order.id, identity: promoIdent, userId })
        .catch((e) => logger.error({ err: e, orderId: order.id }, 'gas promo redemption row failed (discount stands)'))
    }

    await queues.gasFee.add('expire-order', { orderId: order.id }, { delay: 5 * 60 * 1000, jobId: `gas-expire-${order.id}` })

    if (!userId) {
      const today    = new Date().toISOString().slice(0, 10)
      const spendKey = `gas_guest_spend:${clientIp}:${today}`
      await redis.incrbyfloat(spendKey, finalPaymentAmount)
      await redis.expire(spendKey, 86400)
    }
    if (idempKey) {
      await redis.setex(`idem:gasfee:${idempKey}`, 86400, order.id)
    }

    // Fire-and-forget risk scoring (non-blocking)
    flagIfRisky(order, clientIp).catch(() => {})

    return reply.code(201).send({
      success: true,
      data: {
        orderRef:        order.orderRef,
        trackingToken:   order.trackingToken,
        paymentAddress:  depositAddress,
        paymentAmount:   order.paymentAmount.toString(),
        paymentNetwork:  order.paymentNetwork,
        gasAmountNative: order.gasAmountNative.toString(),
        nativeSymbol:    tokenCfg.symbol,
        chain:           order.chain,
        expiresAt:       order.expiresAt.toISOString(),
        // Transparent price breakdown
        gasValueUsd:     gasAmountUSD.toFixed(4),
        platformFeeUsdt: platformFeeUsdt.toFixed(4),
        discountUsdt:    totalDiscount.toFixed(4),
        promoCode:       promoRes?.code ?? null,
        priceAtOrder:    nativeUsdRate.toFixed(4),
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
    if (rlCount > 10) throw new AppError('RATE_LIMITED', 'Maximum 10 gas fee orders per hour per IP', 429)

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
    const paymentAmount = Math.round(gasAmountUSD * markup * 100) / 100
    // This tier path folds the margin into a markup multiplier, so the margin is
    // implicit: recover it as (payment - base), floored at 0.
    const platformMarginUsdt = Math.max(0, Math.round((paymentAmount - gasAmountUSD) * 100) / 100)

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

    const orderRef      = generateOrderRef('GF')
    const trackingToken = generateTrackingToken()
    const expiresAt     = new Date(Date.now() + 5 * 60 * 1000)

    const order = await db.gasFeeOrder.create({
      data: {
        orderRef,
        trackingToken,
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
        platformMarginUsdt,
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

    flagIfRisky(order, clientIp ?? req.ip ?? 'unknown').catch(() => {})

    return reply.code(201).send({
      success: true,
      data: {
        orderRef:        order.orderRef,
        trackingToken:   order.trackingToken,
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
      'gas_pkr_bank_name', 'gas_pkr_bank_account_name', 'gas_pkr_bank_iban', 'gas_pkr_bank_account_number', 'gas_pkr_bank_logo',
      'gas_pkr_easypaisa_number', 'gas_pkr_easypaisa_name', 'gas_pkr_easypaisa_logo',
      'gas_pkr_jazzcash_number', 'gas_pkr_jazzcash_name', 'gas_pkr_jazzcash_logo',
      'gas_pkr_nayapay_number', 'gas_pkr_nayapay_name', 'gas_pkr_nayapay_logo',
      'gas_pkr_sadapay_number', 'gas_pkr_sadapay_name', 'gas_pkr_sadapay_logo',
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
          logoUrl:       map['gas_pkr_bank_logo'] || null,
        },
        easypaisa: {
          number:  map['gas_pkr_easypaisa_number'] ?? null,
          name:    map['gas_pkr_easypaisa_name'] ?? null,
          logoUrl: map['gas_pkr_easypaisa_logo'] || null,
        },
        jazzcash: {
          number:  map['gas_pkr_jazzcash_number'] ?? null,
          name:    map['gas_pkr_jazzcash_name'] ?? null,
          logoUrl: map['gas_pkr_jazzcash_logo'] || null,
        },
        nayapay: {
          number:  map['gas_pkr_nayapay_number'] ?? null,
          name:    map['gas_pkr_nayapay_name'] ?? null,
          logoUrl: map['gas_pkr_nayapay_logo'] || null,
        },
        sadapay: {
          number:  map['gas_pkr_sadapay_number'] ?? null,
          name:    map['gas_pkr_sadapay_name'] ?? null,
          logoUrl: map['gas_pkr_sadapay_logo'] || null,
        },
      },
    })
  })

  // ── GET /gas-fee/crypto-methods — USDT deposit addresses + live network fees ──
  // Address resolution: platformConfig DB override → env var → mnemonic-derived
  // Fee resolution:     admin DB override → live RPC (gas.fees.ts) → default fallback

  app.get('/gas-fee/crypto-methods', async (_req, reply) => {
    const configs = await db.platformConfig.findMany({
      where: {
        key: {
          in: [
            'gas_usdt_trc20_address',
            'gas_usdt_bep20_address',
            'gas_usdt_erc20_address',
            'gas_usdt_aptos_address',
            'gas_trc20_network_fee_usdt',
            'gas_bep20_network_fee_usdt',
            'gas_erc20_network_fee_usdt',
            'gas_aptos_network_fee_usdt',
            'gas_bep20_logo_url',
            'gas_aptos_logo_url',
          ],
        },
      },
    })
    const map: Record<string, string> = {}
    configs.forEach(c => { map[c.key] = c.value })

    const trc20Address = map['gas_usdt_trc20_address'] ?? GAS_CHAINS.TRON.getDepositAddress() ?? null
    const bep20Address = map['gas_usdt_bep20_address'] ?? GAS_CHAINS.BSC.getDepositAddress() ?? null
    const erc20Address = map['gas_usdt_erc20_address'] ?? GAS_CHAINS.ETHEREUM.getDepositAddress() ?? null
    const aptosAddress = map['gas_usdt_aptos_address'] ?? getAptosHotWalletAddress() ?? null

    // TRC20 fee: admin override → live via gas.fees.ts
    let trc20Fee = await getUsdtNetworkFeeUsd('TRON')
    const trc20AdminOverride = map['gas_trc20_network_fee_usdt']
    if (trc20AdminOverride) {
      const v = parseFloat(trc20AdminOverride)
      if (v > 0) trc20Fee = { ...trc20Fee, feeUsd: v, feeDisplay: `~$${v.toFixed(2)}`, isLive: false }
    }

    // BEP20 fee: admin override → live via gas.fees.ts
    let bep20Fee = await getUsdtNetworkFeeUsd('BSC')
    const bep20AdminOverride = map['gas_bep20_network_fee_usdt']
    if (bep20AdminOverride) {
      const v = parseFloat(bep20AdminOverride)
      if (v > 0) bep20Fee = { ...bep20Fee, feeUsd: v, feeDisplay: `~$${v.toFixed(2)}`, isLive: false }
    }

    // ERC20 fee: admin override → live via gas.fees.ts
    let erc20Fee = await getUsdtNetworkFeeUsd('ETHEREUM')
    const erc20AdminOverride = map['gas_erc20_network_fee_usdt']
    if (erc20AdminOverride) {
      const v = parseFloat(erc20AdminOverride)
      if (v > 0) erc20Fee = { ...erc20Fee, feeUsd: v, feeDisplay: `~$${v.toFixed(2)}`, isLive: false }
    }

    // Aptos fee: admin override → live via gas.fees.ts
    let aptosFee = await getUsdtNetworkFeeUsd('APTOS')
    const aptosAdminOverride = map['gas_aptos_network_fee_usdt']
    if (aptosAdminOverride) {
      const v = parseFloat(aptosAdminOverride)
      if (v > 0) aptosFee = { ...aptosFee, feeUsd: v, feeDisplay: `~$${v.toFixed(2)}`, isLive: false }
    }

    return reply.send({
      success: true,
      data: {
        trc20: {
          address:          trc20Address,
          network:          'TRC20',
          fee:              trc20Fee.feeDisplay,
          feeNativeDisplay: trc20Fee.feeNativeDisplay,
          feeUsd:           trc20Fee.feeUsd,
          feeIsLive:        trc20Fee.isLive,
        },
        bep20: {
          address:          bep20Address,
          network:          'BEP20',
          fee:              bep20Fee.feeDisplay,
          feeNativeDisplay: bep20Fee.feeNativeDisplay,
          feeUsd:           bep20Fee.feeUsd,
          feeIsLive:        bep20Fee.isLive,
          logoUrl:          map['gas_bep20_logo_url'] ?? null,
        },
        erc20: {
          address:          erc20Address,
          network:          'ERC20',
          fee:              erc20Fee.feeDisplay,
          feeNativeDisplay: erc20Fee.feeNativeDisplay,
          feeUsd:           erc20Fee.feeUsd,
          feeIsLive:        erc20Fee.isLive,
        },
        aptos: {
          address:          aptosAddress,
          network:          'APTOS',
          fee:              aptosFee.feeDisplay,
          feeNativeDisplay: aptosFee.feeNativeDisplay,
          feeUsd:           aptosFee.feeUsd,
          feeIsLive:        aptosFee.isLive,
          logoUrl:          map['gas_aptos_logo_url'] ?? null,
        },
      },
    })
  })

  // ── POST /gas-fee/orders/pkr — create PKR fiat payment gas order ───────────

  const createPkrOrderSchema = z.object({
    tokenConfigId:    z.string().min(1),
    amount:           z.number().positive(),
    toAddress:        z.string().min(1),
    pkrPaymentMethod: z.enum(['bank_transfer', 'easypaisa', 'jazzcash', 'nayapay', 'sadapay']),
    idempotencyKey:   z.string().optional(),
    promoCode:        z.string().trim().min(1).max(40).optional(),
  })

  app.post('/gas-fee/orders/pkr', { preHandler: [authenticate] }, async (req, reply) => {
    const parsed = createPkrOrderSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }
    const { tokenConfigId, amount, toAddress, pkrPaymentMethod, idempotencyKey, promoCode } = parsed.data
    const userId = req.user!.id
    await assertNotInGasCooldown(gasCancelIdentity(userId, req.ip))
    await assertNoUnpaidGasOrder(userId)

    const tokenCfg = await db.gasTokenConfig.findUnique({ where: { id: tokenConfigId }, include: { chain: true } })
    if (!tokenCfg || !tokenCfg.isActive) throw new AppError('CHAIN_NOT_SUPPORTED', 'Gas token not found or inactive', 404)
    const chainCfg = tokenCfg.chain
    if (!chainCfg.isActive) throw new AppError('CHAIN_NOT_SUPPORTED', `${chainCfg.name} gas is not active`, 400)
    // Archived chains/tokens are retired — not orderable even via a stale client.
    if (tokenCfg.isArchived || chainCfg.isArchived) throw new AppError('CHAIN_NOT_SUPPORTED', `${tokenCfg.symbol} is no longer available`, 400)
    if (!chainCfg.backendChainId) throw new AppError('CHAIN_NOT_SUPPORTED', `${chainCfg.name} gas delivery is coming soon`, 400)
    if (!isTokenOrderable(chainCfg.backendChainId, tokenCfg)) {
      throw new AppError('CHAIN_NOT_SUPPORTED', `${tokenCfg.symbol} delivery is coming soon`, 400)
    }

    if (!validateAddress(toAddress, chainCfg.addressType)) {
      throw new AppError('INVALID_ADDRESS', `Invalid ${chainCfg.networkLabel} address format`, 400)
    }

    const legacyId = chainCfg.backendChainId === 'ETH' ? 'ETHEREUM' : chainCfg.backendChainId
    const legacyChainConfig = GAS_CHAINS[legacyId as GasChainId]
    // Aptos (APT) is an inbound rail with no GAS_CHAINS native-delivery config, but
    // it supports fungible-asset (USDT/USDC) delivery — allow it through.
    if (!legacyChainConfig && chainCfg.backendChainId !== 'APT') throw new AppError('CHAIN_NOT_SUPPORTED', `${chainCfg.name} gas delivery not configured`, 400)

    const dbHotWallet = await db.gasHotWallet.findFirst({ where: { chain: toDbChain(legacyId as GasChainId), isActive: true } })
    // Aptos has no GasHotWallet row — its hot wallet is the derived FA address.
    const aptosHotAddr = chainCfg.backendChainId === 'APT' ? getAptosHotWalletAddress() : null
    const hotWallet: { address: string } | null = dbHotWallet ?? (aptosHotAddr ? { address: aptosHotAddr } : null)
    const isAutoPaused = await redis.get(`gas_wallet_paused:${chainCfg.backendChainId}`)
    if (!hotWallet || isAutoPaused) throw new AppError('GAS_UNAVAILABLE', `Gas is temporarily unavailable for ${chainCfg.name}. Please try again later.`, 503)

    const resolvedPkr = resolveTokenConfig(tokenCfg, chainCfg)
    if (amount < resolvedPkr.minAmount) throw new AppError('VALIDATION_ERROR', `Minimum amount is ${resolvedPkr.minAmount} ${tokenCfg.symbol}`, 400)

    const nativeUsdRate = await getNativeUsdRate(tokenCfg.priceSymbol)
    if (!(nativeUsdRate > 0)) throw new AppError('RATE_UNAVAILABLE', 'Exchange rate is temporarily unavailable. Please try again.', 503)

    const usdPkrRate = await getUsdPkrRate()
    if (!(usdPkrRate > 0)) throw new AppError('RATE_UNAVAILABLE', 'PKR exchange rate is temporarily unavailable. Please try again in a moment.', 503)
    const gasAmountUSD    = amount * nativeUsdRate
    const platformFeeUsdt = resolvedPkr.platformFeeUsdt
    if (gasAmountUSD > resolvedPkr.maxUsdValue) throw new AppError('VALIDATION_ERROR', `Maximum order value is $${resolvedPkr.maxUsdValue} USD. Reduce the amount.`, 400)

    const paymentAmountUsd = gasAmountUSD + platformFeeUsdt

    const idempKey = (req.headers['idempotency-key'] as string | undefined) ?? idempotencyKey
    if (idempKey) {
      const existingId = await redis.get(`idem:gasfee:pkr:${idempKey}`)
      if (existingId) {
        const existing = await db.gasFeeOrder.findUnique({ where: { id: existingId } })
        if (existing) return reply.send({ success: true, data: existing })
      }
    }

    const dbChainEnum   = chainCfg.backendChainId as 'TRON' | 'BSC' | 'ETH' | 'SOL' | 'MATIC' | 'ARB' | 'BASE' | 'OP' | 'AVAX' | 'TON' | 'SUI'
    const orderRef      = generateOrderRef('GF')
    const trackingToken = generateTrackingToken()
    const expiresAt     = new Date(Date.now() + 24 * 60 * 60 * 1000)

    // Promo: reserve a margin-only discount, then bake it into both the USD charge and
    // the derived PKR amount, BEFORE persisting. Floored at the margin → never below base.
    const promoIdent = promoIdentity(userId, req.ip ?? 'unknown')
    const promoRes = await reserveOrderPromo(promoCode, paymentAmountUsd, platformFeeUsdt, promoIdent)
    const promoDisc = promoRes?.discountUsdt ?? 0
    const aff = await affiliateOrderDiscount(userId, platformFeeUsdt, promoDisc)
    const affDisc = aff.discountUsdt
    const totalDiscount = Math.round((promoDisc + affDisc) * 100) / 100
    const finalPaymentUsd = Math.round((paymentAmountUsd - totalDiscount) * 100) / 100
    const finalPkrAmount = finalPaymentUsd * usdPkrRate

    const order = await (async () => {
      try {
        return await db.gasFeeOrder.create({
          data: {
            orderRef,
            trackingToken,
            userId,
            ipAddress:        req.ip ?? 'unknown',
            chain:            dbChainEnum,
            gasTokenConfigId: tokenCfg.id,
            gasAmountNative:  amount,
            gasAmountUSD,
            priceAtOrder:     nativeUsdRate,
            paymentCoin:      'PKR',
            paymentNetwork:   pkrPaymentMethod.toUpperCase(),
            paymentAmount:    finalPaymentUsd,
            platformMarginUsdt: platformFeeUsdt,
            discountUsdt:     totalDiscount,
            affiliateDiscountUsdt: affDisc,
            affiliateReferrer:     aff.referrer,
            ...(promoRes ? { promoCodeId: promoRes.promoCodeId } : {}),
            pkrAmount:        finalPkrAmount,
            pkrPaymentMethod,
            fromHotWallet:    hotWallet.address,
            toAddress,
            status:           'payment_pending',
            expiresAt,
          },
        })
      } catch (e) {
        if (promoRes) await releaseReservation(promoRes)
        throw e
      }
    })()

    if (promoRes) {
      await recordRedemption({ resolution: promoRes, orderId: order.id, identity: promoIdent, userId })
        .catch((e) => logger.error({ err: e, orderId: order.id }, 'gas promo redemption row failed (discount stands)'))
    }

    if (idempKey) await redis.setex(`idem:gasfee:pkr:${idempKey}`, 86400, order.id)
    await queues.gasFee.add('expire-order', { orderId: order.id }, { delay: 24 * 60 * 60 * 1000, jobId: `gas-expire-${order.id}` })

    flagIfRisky(order, req.ip ?? 'unknown').catch(() => {})
    logger.info({ orderId: order.id, userId, pkrAmount: finalPkrAmount, pkrPaymentMethod }, 'PKR gas order created')

    return reply.code(201).send({
      success: true,
      data: {
        orderRef:        order.orderRef,
        trackingToken:   order.trackingToken,
        paymentCoin:     'PKR',
        paymentNetwork:  pkrPaymentMethod,
        paymentAmount:   finalPaymentUsd.toFixed(2),
        pkrAmount:       finalPkrAmount.toFixed(0),
        gasAmountNative: order.gasAmountNative.toString(),
        nativeSymbol:    tokenCfg.symbol,
        chain:           order.chain,
        status:          order.status,
        expiresAt:       order.expiresAt.toISOString(),
        // Transparent price breakdown (consistent with USDT orders)
        gasValueUsd:     gasAmountUSD.toFixed(4),
        platformFeeUsdt: platformFeeUsdt.toFixed(4),
        discountUsdt:    totalDiscount.toFixed(4),
        promoCode:       promoRes?.code ?? null,
        priceAtOrder:    nativeUsdRate.toFixed(4),
      },
    })
  })

  // ── POST /gas-fee/orders/crypto — create USDT order with BEP20 or Aptos ────

  // Assign a UNIQUE payment amount so two concurrent orders never share one.
  // This lets the matchers attribute a payment to exactly one order even when
  // many users request the same gas size. The amount is snapped to a 0.001 grid
  // (rounded up so we never undercharge) and bumped by 0.001 until it doesn't
  // collide with any live order on the same payment network. Surcharge is 0 in
  // the common no-collision case and at most a fraction of a cent otherwise.
  const UNIQUE_AMOUNT_STEP = 0.001
  async function assignUniqueGasPaymentAmount(paymentNetwork: string, base: number): Promise<number> {
    const ceil3 = (n: number) => Math.ceil(n * 1000) / 1000
    const live = await db.gasFeeOrder.findMany({
      where: {
        paymentNetwork,
        status: { in: ['payment_pending', 'payment_uploaded'] },
        expiresAt: { gt: new Date() },
      },
      select: { paymentAmount: true },
    })
    const used = new Set(live.map((o) => (Math.round(Number(o.paymentAmount) * 1000) / 1000).toFixed(3)))
    let candidate = ceil3(base)
    for (let k = 0; k < 500 && used.has(candidate.toFixed(3)); k++) {
      candidate = Math.round((candidate + UNIQUE_AMOUNT_STEP) * 1000) / 1000
    }
    return candidate
  }

  const createCryptoOrderSchema = z.object({
    tokenConfigId:   z.string().min(1),
    amount:          z.number().positive(),
    toAddress:       z.string().min(1),
    paymentNetwork:  z.enum(['TRC20', 'BEP20', 'ERC20', 'APTOS']),
    idempotencyKey:  z.string().optional(),
    promoCode:       z.string().trim().min(1).max(40).optional(),
  })

  app.post('/gas-fee/orders/crypto', { preHandler: [optionalAuth] }, async (req, reply) => {
    const parsed = createCryptoOrderSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    }
    const { tokenConfigId, amount, toAddress, paymentNetwork, idempotencyKey, promoCode } = parsed.data
    await assertNotInGasCooldown(gasCancelIdentity(req.user?.id ?? null, req.ip))
    await assertNoUnpaidGasOrder(req.user?.id ?? null)

    const configKeyMap: Record<string, string> = {
      TRC20:  'gas_usdt_trc20_address',
      BEP20:  'gas_usdt_bep20_address',
      ERC20:  'gas_usdt_erc20_address',
      APTOS:  'gas_usdt_aptos_address',
    }
    const configKey = configKeyMap[paymentNetwork]
    const depositConfig = configKey ? await db.platformConfig.findUnique({ where: { key: configKey } }) : null
    const fallbackAddress =
      paymentNetwork === 'TRC20' ? (GAS_CHAINS.TRON.getDepositAddress() ?? null)
      : paymentNetwork === 'BEP20' ? (GAS_CHAINS.BSC.getDepositAddress() ?? null)
      : paymentNetwork === 'ERC20' ? (GAS_CHAINS.ETHEREUM.getDepositAddress() ?? null)
      : paymentNetwork === 'APTOS' ? (getAptosHotWalletAddress() ?? null)
      : null
    const depositAddress = depositConfig?.value ?? fallbackAddress
    if (!depositAddress) {
      throw new AppError('CHAIN_NOT_SUPPORTED', `USDT ${paymentNetwork} payment is not configured yet`, 400)
    }

    const tokenCfg = await db.gasTokenConfig.findUnique({ where: { id: tokenConfigId }, include: { chain: true } })
    if (!tokenCfg || !tokenCfg.isActive) throw new AppError('CHAIN_NOT_SUPPORTED', 'Gas token not found or inactive', 404)
    const chainCfg = tokenCfg.chain
    if (!chainCfg.isActive) throw new AppError('CHAIN_NOT_SUPPORTED', `${chainCfg.name} gas is not active`, 400)
    // Archived chains/tokens are retired — not orderable even via a stale client.
    if (tokenCfg.isArchived || chainCfg.isArchived) throw new AppError('CHAIN_NOT_SUPPORTED', `${tokenCfg.symbol} is no longer available`, 400)
    if (!chainCfg.backendChainId) throw new AppError('CHAIN_NOT_SUPPORTED', `${chainCfg.name} gas delivery is coming soon`, 400)
    if (!isTokenOrderable(chainCfg.backendChainId, tokenCfg)) {
      throw new AppError('CHAIN_NOT_SUPPORTED', `${tokenCfg.symbol} delivery is coming soon`, 400)
    }

    if (!validateAddress(toAddress, chainCfg.addressType)) {
      throw new AppError('INVALID_ADDRESS', `Invalid ${chainCfg.networkLabel} address format`, 400)
    }

    const legacyId = chainCfg.backendChainId === 'ETH' ? 'ETHEREUM' : chainCfg.backendChainId
    const legacyChainConfig = GAS_CHAINS[legacyId as GasChainId]
    // Aptos (APT) is an inbound rail with no GAS_CHAINS native-delivery config, but
    // it supports fungible-asset (USDT/USDC) delivery — allow it through.
    if (!legacyChainConfig && chainCfg.backendChainId !== 'APT') throw new AppError('CHAIN_NOT_SUPPORTED', `${chainCfg.name} gas delivery not configured`, 400)

    const dbHotWallet = await db.gasHotWallet.findFirst({ where: { chain: toDbChain(legacyId as GasChainId), isActive: true } })
    // Aptos has no GasHotWallet row — its hot wallet is the derived FA address.
    const aptosHotAddr = chainCfg.backendChainId === 'APT' ? getAptosHotWalletAddress() : null
    const hotWallet: { address: string } | null = dbHotWallet ?? (aptosHotAddr ? { address: aptosHotAddr } : null)
    const isAutoPaused = await redis.get(`gas_wallet_paused:${chainCfg.backendChainId}`)
    if (!hotWallet || isAutoPaused) throw new AppError('GAS_UNAVAILABLE', `Gas is temporarily unavailable for ${chainCfg.name}. Please try again later.`, 503)

    const resolvedCrypto = resolveTokenConfig(tokenCfg, chainCfg)
    if (amount < resolvedCrypto.minAmount) throw new AppError('VALIDATION_ERROR', `Minimum amount is ${resolvedCrypto.minAmount} ${tokenCfg.symbol}`, 400)

    const nativeUsdRate = await getNativeUsdRate(tokenCfg.priceSymbol)
    if (!(nativeUsdRate > 0)) throw new AppError('RATE_UNAVAILABLE', 'Exchange rate is temporarily unavailable. Please try again.', 503)

    const gasAmountUSD    = amount * nativeUsdRate
    const platformFeeUsdt = resolvedCrypto.platformFeeUsdt
    if (gasAmountUSD > resolvedCrypto.maxUsdValue) throw new AppError('VALIDATION_ERROR', `Maximum order value is $${resolvedCrypto.maxUsdValue} USD. Reduce the amount.`, 400)
    // Pre-discount charge — the unique discounted amount is assigned later, after all
    // validation passes and the promo slot is reserved, so payment-matching operates
    // on the exact final figure.
    const baseCharge = gasAmountUSD + platformFeeUsdt

    // IP rate limit
    const clientIp  = req.ip ?? 'unknown'
    const clockHour = Math.floor(Date.now() / 3_600_000)
    const rlKey     = `gas_rl:${clientIp}:${clockHour}`
    const rlCount   = await redis.incr(rlKey)
    if (rlCount === 1) await redis.expire(rlKey, 3600)
    if (rlCount > 10) throw new AppError('RATE_LIMITED', 'Maximum 10 gas fee orders per hour per IP', 429)

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
      if (cur + baseCharge > env.GAS_GUEST_DAILY_LIMIT_USD) {
        throw new AppError('GUEST_LIMIT_EXCEEDED', `Guest orders are limited to $${env.GAS_GUEST_DAILY_LIMIT_USD} per day.`, 400)
      }
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
      const destCount = await db.gasFeeOrder.count({ where: { toAddress, createdAt: { gte: todayStart } } })
      if (destCount >= 2) throw new AppError('DEST_LIMIT_EXCEEDED', 'Maximum 2 gas orders to the same destination per day for guest users.', 400)
    }

    const dbChainEnum   = chainCfg.backendChainId as 'TRON' | 'BSC' | 'ETH' | 'SOL' | 'MATIC' | 'ARB' | 'BASE' | 'OP' | 'AVAX' | 'TON' | 'SUI'
    const orderRef      = generateOrderRef('GF')
    const trackingToken = generateTrackingToken()
    const expiresAt     = new Date(Date.now() + 15 * 60 * 1000)

    // Promo: reserve a margin-only discount, apply it to the base charge, THEN assign
    // the unique payment amount on the discounted figure (so verify ±1% + matching use
    // the exact amount the user is told to pay). Floored at the margin → never below base.
    const promoIdent = promoIdentity(userId, clientIp)
    const promoRes = await reserveOrderPromo(promoCode, baseCharge, platformFeeUsdt, promoIdent)
    const promoDisc = promoRes?.discountUsdt ?? 0
    const aff = await affiliateOrderDiscount(userId, platformFeeUsdt, promoDisc)
    const affDisc = aff.discountUsdt
    const totalDiscount = Math.round((promoDisc + affDisc) * 100) / 100
    const discountedBase = Math.round((baseCharge - totalDiscount) * 100) / 100
    // Assign the unique amount AND create the order inside the same guarded block, so
    // ANY failure after the promo reservation (incl. assignUnique) releases the slot.
    const order = await (async () => {
      try {
        const paymentAmount = await assignUniqueGasPaymentAmount(paymentNetwork, discountedBase)
        return await db.gasFeeOrder.create({
          data: {
            orderRef,
            trackingToken,
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
            platformMarginUsdt: platformFeeUsdt,
            discountUsdt:     totalDiscount,
            affiliateDiscountUsdt: affDisc,
            affiliateReferrer:     aff.referrer,
            ...(promoRes ? { promoCodeId: promoRes.promoCodeId } : {}),
            fromHotWallet:    hotWallet.address,
            toAddress,
            status:           'payment_pending',
            expiresAt,
          },
        })
      } catch (e) {
        if (promoRes) await releaseReservation(promoRes)
        throw e
      }
    })()

    if (promoRes) {
      await recordRedemption({ resolution: promoRes, orderId: order.id, identity: promoIdent, userId })
        .catch((e) => logger.error({ err: e, orderId: order.id }, 'gas promo redemption row failed (discount stands)'))
    }

    if (idempKey) await redis.setex(`idem:gasfee:crypto:${idempKey}`, 86400, order.id)
    if (!userId) {
      const today    = new Date().toISOString().slice(0, 10)
      const spendKey = `gas_guest_spend:${clientIp}:${today}`
      await redis.incrbyfloat(spendKey, Number(order.paymentAmount))
      await redis.expire(spendKey, 86400)
    }
    await queues.gasFee.add('expire-order', { orderId: order.id }, { delay: 15 * 60 * 1000, jobId: `gas-expire-${order.id}` })

    flagIfRisky(order, clientIp).catch(() => {})
    logger.info({ orderId: order.id, paymentNetwork, gasAmountNative: amount }, 'Crypto gas order created')

    return reply.code(201).send({
      success: true,
      data: {
        orderRef:        order.orderRef,
        trackingToken:   order.trackingToken,
        paymentAddress:  depositAddress,
        paymentAmount:   order.paymentAmount.toString(),
        paymentNetwork,
        gasAmountNative: order.gasAmountNative.toString(),
        nativeSymbol:    tokenCfg.symbol,
        chain:           order.chain,
        status:          order.status,
        expiresAt:       order.expiresAt.toISOString(),
        // Transparent price breakdown
        gasValueUsd:     gasAmountUSD.toFixed(4),
        platformFeeUsdt: platformFeeUsdt.toFixed(4),
        discountUsdt:    totalDiscount.toFixed(4),
        promoCode:       promoRes?.code ?? null,
        priceAtOrder:    nativeUsdRate.toFixed(4),
      },
    })
  })

  // ── POST /gas-fee/promo/preview — validate a promo code for an order (no reserve) ──
  // Cosmetic preview for the payment page. The real discount is re-validated and
  // reserved server-side at order creation, so a tampered preview cannot grant value.
  const promoPreviewSchema = z.object({
    promoCode:     z.string().trim().min(1).max(40),
    tokenConfigId: z.string().min(1),
    amount:        z.number().positive(),
  })
  app.post('/gas-fee/promo/preview', { preHandler: [optionalAuth] }, async (req, reply) => {
    const parsed = promoPreviewSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    const { promoCode, tokenConfigId, amount } = parsed.data

    const tokenCfg = await db.gasTokenConfig.findUnique({ where: { id: tokenConfigId }, include: { chain: true } })
    if (!tokenCfg || !tokenCfg.isActive) throw new AppError('CHAIN_NOT_SUPPORTED', 'Gas token not found or inactive', 404)
    const resolved = resolveTokenConfig(tokenCfg, tokenCfg.chain)
    const nativeUsdRate = await getNativeUsdRate(tokenCfg.priceSymbol)
    if (!(nativeUsdRate > 0)) throw new AppError('RATE_UNAVAILABLE', 'Exchange rate is temporarily unavailable. Please try again.', 503)
    const gasAmountUSD = amount * nativeUsdRate
    const marginUsdt   = resolved.platformFeeUsdt
    const orderUsd     = Math.round((gasAmountUSD + marginUsdt) * 100) / 100

    const identity = promoIdentity(req.user?.id ?? null, req.ip ?? 'unknown')
    const preview = await previewPromo({ code: promoCode, orderUsd, marginUsdt, identity })
    return reply.send({ success: true, data: preview })
  })

  // ── GET /gas-fee/referral/me — referral dashboard summary (own code + earnings) ──
  app.get('/gas-fee/referral/me', { preHandler: [authenticate] }, async (req, reply) => {
    const summary = await getReferralSummary(req.user!.id)
    return reply.send({ success: true, data: summary })
  })

  // ── POST /gas-fee/referral/apply — bind the caller to a referrer (first-touch) ──
  const referralApplySchema = z.object({ code: z.string().trim().min(2).max(40) })
  app.post('/gas-fee/referral/apply', { preHandler: [authenticate] }, async (req, reply) => {
    if (!(await isFlagEnabled(FLAGS.GAS_REFERRAL))) {
      throw new AppError('REFERRAL_DISABLED', 'Referrals are not available right now.', 400)
    }
    const parsed = referralApplySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    const result = await bindReferral(req.user!.id, parsed.data.code)
    return reply.send({ success: true, data: result })
  })

  // ── POST /gas-fee/referral/label — set a vanity label/alias on your own code ──
  const referralLabelSchema = z.object({ label: z.string().trim().max(60).nullable() })
  app.post('/gas-fee/referral/label', { preHandler: [authenticate], config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = referralLabelSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    const result = await setOwnCodeLabel(req.user!.id, parsed.data.label)
    return reply.send({ success: true, data: result })
  })

  // ── POST /gas-fee/referral/withdraw — move withdrawable earnings to USDT balance ──
  app.post('/gas-fee/referral/withdraw', { preHandler: [authenticate], config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const result = await withdrawReferralEarnings(req.user!.id)
    return reply.send({ success: true, data: result })
  })

  // ── Self-service custom links (any user; standard split, capped + cooldown) ──

  // POST /gas-fee/referral/custom-links — mint a named custom link (standard 5/5 split).
  const customLinkCreateSchema = z.object({
    label: z.string().trim().max(60).nullable().optional(),
    code:  z.string().trim().max(20).optional(),
  })
  app.post('/gas-fee/referral/custom-links', { preHandler: [authenticate], config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = customLinkCreateSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    const data = await createOwnCustomLink(req.user!.id, parsed.data.label ?? null, parsed.data.code ?? null)
    return reply.code(201).send({ success: true, data })
  })

  // DELETE /gas-fee/referral/custom-links/:codeId — soft-delete a custom link.
  app.delete('/gas-fee/referral/custom-links/:codeId', { preHandler: [authenticate], config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { codeId } = req.params as { codeId: string }
    const data = await deleteOwnCustomLink(req.user!.id, codeId)
    return reply.send({ success: true, data })
  })

  // ── Affiliate program (self-service, extends referrals) ──────────────────────

  // GET /gas-fee/affiliate/me — application status, caps, links + earnings.
  app.get('/gas-fee/affiliate/me', { preHandler: [authenticate] }, async (req, reply) => {
    const data = await getAffiliateOverview(req.user!.id)
    return reply.send({ success: true, data })
  })

  // GET /gas-fee/affiliate/quote — buyer's auto-discount preview for the checkout
  // breakdown (margin-only, read-only). Returns null when nothing applies.
  const affiliateQuoteSchema = z.object({ tokenConfigId: z.string().min(1) })
  app.get('/gas-fee/affiliate/quote', { preHandler: [authenticate] }, async (req, reply) => {
    const parsed = affiliateQuoteSchema.safeParse(req.query)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    const tokenCfg = await db.gasTokenConfig.findUnique({ where: { id: parsed.data.tokenConfigId }, include: { chain: true } })
    if (!tokenCfg || !tokenCfg.isActive) throw new AppError('CHAIN_NOT_SUPPORTED', 'Gas token not found or inactive', 404)
    const resolved = resolveTokenConfig(tokenCfg, tokenCfg.chain)
    const quote = await getAffiliateQuote(req.user!.id, resolved.platformFeeUsdt)
    return reply.send({ success: true, data: quote })
  })

  // POST /gas-fee/affiliate/apply — submit/re-submit an affiliate application.
  const affiliateApplySchema = z.object({
    socials: z.record(z.string().trim().max(300)).refine((o) => Object.keys(o).length > 0, 'Provide at least one social profile.'),
    note:    z.string().trim().max(1000).optional(),
  })
  app.post('/gas-fee/affiliate/apply', { preHandler: [authenticate], config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = affiliateApplySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    const data = await applyForAffiliate(req.user!.id, parsed.data.socials, parsed.data.note ?? null)
    return reply.send({ success: true, data })
  })

  // POST /gas-fee/affiliate/links — create a new affiliate link with a chosen split.
  const affiliateLinkCreateSchema = z.object({
    label:           z.string().trim().max(60).optional(),
    code:            z.string().trim().max(20).optional(),
    userDiscountPct: z.number().min(0).max(100),
    commissionPct:   z.number().min(0).max(100),
  })
  app.post('/gas-fee/affiliate/links', { preHandler: [authenticate] }, async (req, reply) => {
    const parsed = affiliateLinkCreateSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    const data = await createAffiliateLink(req.user!.id, {
      label: parsed.data.label ?? null,
      code: parsed.data.code ?? null,
      userDiscountPct: parsed.data.userDiscountPct,
      commissionPct: parsed.data.commissionPct,
    })
    return reply.code(201).send({ success: true, data })
  })

  // PATCH /gas-fee/affiliate/links/:codeId — update a link's split/label/active state.
  const affiliateLinkUpdateSchema = z.object({
    label:           z.string().trim().max(60).nullable().optional(),
    userDiscountPct: z.number().min(0).max(100).optional(),
    commissionPct:   z.number().min(0).max(100).optional(),
    isActive:        z.boolean().optional(),
  })
  app.patch('/gas-fee/affiliate/links/:codeId', { preHandler: [authenticate] }, async (req, reply) => {
    const { codeId } = req.params as { codeId: string }
    const parsed = affiliateLinkUpdateSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    const data = await updateAffiliateLink(req.user!.id, codeId, parsed.data)
    return reply.send({ success: true, data })
  })

  // ── POST /gas-fee/admin/free-deliver — admin-issued, platform-funded free gas ──
  // Super-admin only + flag-gated (gas_free_grant_enabled). Creates a fully-covered
  // order (paymentAmount 0; platform funds base + margin) already in payment_detected,
  // so it routes through the EXACT SAME proven delivery worker as a normal paid order.
  // A failed free delivery has no paymentTxHash → enterRefundWindow sends it to
  // 'failed' (never a 0-USDT refund). Curated tool for a small set of users.
  const freeDeliverSchema = z.object({
    tokenConfigId: z.string().min(1),
    amount:        z.number().positive(),
    toAddress:     z.string().min(1),
    userId:        z.string().min(1).optional(),
    note:          z.string().trim().max(200).optional(),
  })
  // Shared: create a fully platform-funded ($0) gas order and route it to the normal
  // delivery worker (status payment_detected). Used by the admin free-deliver endpoint
  // AND the giveaway draw. Throws AppError on any resolution failure; the caller
  // decides how to surface it (the draw catches per-winner so one bad address doesn't
  // abort the whole draw).
  async function issueFreeGasOrder(args: { tokenConfigId: string; amount: number; toAddress: string; userId: string | null }): Promise<{ orderId: string; orderRef: string; gasAmountUSD: number; fullCoverUsdt: number; chain: string }> {
    const tokenCfg = await db.gasTokenConfig.findUnique({ where: { id: args.tokenConfigId }, include: { chain: true } })
    if (!tokenCfg || !tokenCfg.isActive) throw new AppError('CHAIN_NOT_SUPPORTED', 'Gas token not found or inactive', 404)
    const chainCfg = tokenCfg.chain
    if (!chainCfg.backendChainId) throw new AppError('CHAIN_NOT_SUPPORTED', `${chainCfg.name} gas delivery is coming soon`, 400)
    if (!isTokenOrderable(chainCfg.backendChainId, tokenCfg)) throw new AppError('CHAIN_NOT_SUPPORTED', `${tokenCfg.symbol} delivery is coming soon`, 400)
    if (!validateAddress(args.toAddress, chainCfg.addressType)) throw new AppError('INVALID_ADDRESS', `Invalid ${chainCfg.networkLabel} address format`, 400)

    const resolved = resolveTokenConfig(tokenCfg, chainCfg)
    if (args.amount < resolved.minAmount) throw new AppError('VALIDATION_ERROR', `Minimum amount is ${resolved.minAmount} ${tokenCfg.symbol}`, 400)
    const nativeUsdRate = await getNativeUsdRate(tokenCfg.priceSymbol)
    if (!(nativeUsdRate > 0)) throw new AppError('RATE_UNAVAILABLE', 'Exchange rate is temporarily unavailable. Please try again.', 503)
    const gasAmountUSD = args.amount * nativeUsdRate
    if (gasAmountUSD > resolved.maxUsdValue) throw new AppError('VALIDATION_ERROR', `Maximum order value is $${resolved.maxUsdValue} USD.`, 400)
    const platformFeeUsdt = resolved.platformFeeUsdt
    const fullCoverUsdt = Math.round((gasAmountUSD + platformFeeUsdt) * 100) / 100

    const legacyId = chainCfg.backendChainId === 'ETH' ? 'ETHEREUM' : chainCfg.backendChainId
    const dbHotWallet = await db.gasHotWallet.findFirst({ where: { chain: toDbChain(legacyId as GasChainId), isActive: true } })
    const aptosHotAddr = chainCfg.backendChainId === 'APT' ? getAptosHotWalletAddress() : null
    const hotWallet: { address: string } | null = dbHotWallet ?? (aptosHotAddr ? { address: aptosHotAddr } : null)
    if (!hotWallet) throw new AppError('GAS_UNAVAILABLE', `Gas is temporarily unavailable for ${chainCfg.name}.`, 503)

    const dbChainEnum = chainCfg.backendChainId as 'TRON' | 'BSC' | 'ETH' | 'SOL' | 'MATIC' | 'ARB' | 'BASE' | 'OP' | 'AVAX' | 'TON' | 'SUI'
    const orderRef = generateOrderRef('GF')
    const order = await db.gasFeeOrder.create({
      data: {
        orderRef,
        ...(args.userId ? { userId: args.userId } : {}),
        ipAddress:          'admin',
        chain:              dbChainEnum,
        gasTokenConfigId:   tokenCfg.id,
        gasAmountNative:    args.amount,
        gasAmountUSD,
        priceAtOrder:       nativeUsdRate,
        paymentCoin:        'FREE',
        paymentNetwork:     chainCfg.networkLabel,
        paymentAmount:      0,
        platformMarginUsdt: platformFeeUsdt,
        discountUsdt:       fullCoverUsdt,
        isFreeGrant:        true,
        toAddress:          args.toAddress,
        fromHotWallet:      hotWallet.address,
        status:             'payment_detected', // routes straight to the delivery worker
        expiresAt:          new Date(Date.now() + 60 * 60 * 1000),
      },
    })
    await queues.gasFee.add('deliver', { orderId: order.id }, { priority: 1 })
    logger.info({ orderRef, gasAmountUSD, fullCoverUsdt, targetUserId: args.userId ?? null }, 'free-gas delivery issued')
    return { orderId: order.id, orderRef, gasAmountUSD, fullCoverUsdt, chain: order.chain }
  }

  app.post('/gas-fee/admin/free-deliver', { preHandler: [authenticate, requireRole('super_admin')] }, async (req, reply) => {
    if (!(await isFlagEnabled(FLAGS.GAS_FREE_GRANT))) {
      throw new AppError('FREE_GRANT_DISABLED', 'Free-gas delivery is not enabled.', 400)
    }
    const parsed = freeDeliverSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    const { tokenConfigId, amount, toAddress, userId, note } = parsed.data
    if (userId) {
      const u = await db.user.findUnique({ where: { id: userId }, select: { id: true } })
      if (!u) throw Errors.NOT_FOUND('User')
    }
    const res = await issueFreeGasOrder({ tokenConfigId, amount, toAddress, userId: userId ?? null })
    await db.auditLog.create({
      data: {
        actorId:    req.user!.id,
        action:     'GAS_FREE_DELIVER',
        targetType: 'GasFeeOrder',
        targetId:   res.orderId,
        metadata:   { orderRef: res.orderRef, tokenConfigId, amount, toAddress, gasAmountUSD: res.gasAmountUSD, fullCoverUsdt: res.fullCoverUsdt, targetUserId: userId ?? null, note: note ?? null } as never,
        ipAddress:  req.ip ?? null,
        userAgent:  (req.headers['user-agent'] as string | undefined)?.slice(0, 500) ?? null,
      },
    })
    return reply.code(201).send({
      success: true,
      data: { orderRef: res.orderRef, gasAmountNative: amount, gasAmountUSD: res.gasAmountUSD.toFixed(4), fullCoverUsdt: res.fullCoverUsdt.toFixed(4), chain: res.chain },
    })
  })

  // ── GAS GIVEAWAYS (KOL campaigns: entry pool → admin draw → free gas to winners) ──

  // GET /gas-fee/giveaway/:code — public campaign info + whether the caller entered.
  app.get('/gas-fee/giveaway/:code', { preHandler: [optionalAuth] }, async (req, reply) => {
    if (!(await isFlagEnabled(FLAGS.GAS_GIVEAWAY))) throw new AppError('GIVEAWAY_DISABLED', 'Giveaways are not available right now.', 400)
    const { code } = req.params as { code: string }
    const campaign = await db.gasGiveawayCampaign.findUnique({ where: { code: code.trim().toUpperCase() } })
    if (!campaign || !campaign.isActive) throw Errors.NOT_FOUND('Giveaway')
    const tokenCfg = await db.gasTokenConfig.findUnique({ where: { id: campaign.gasTokenConfigId }, include: { chain: true } })
    const entryCount = await db.gasGiveawayEntry.count({ where: { campaignId: campaign.id } })
    const alreadyEntered = req.user
      ? !!(await db.gasGiveawayEntry.findUnique({ where: { campaignId_userId: { campaignId: campaign.id, userId: req.user.id } } }))
      : false
    const open = campaign.status === 'open' && (!campaign.entryDeadline || campaign.entryDeadline.getTime() > Date.now())
    return reply.send({
      success: true,
      data: {
        code: campaign.code,
        kolLabel: campaign.kolLabel,
        tokenSymbol: tokenCfg?.symbol ?? '',
        networkLabel: tokenCfg?.chain.networkLabel ?? '',
        addressType: tokenCfg?.chain.addressType ?? '',
        amountNative: campaign.amountNative.toString(),
        winnerCount: campaign.winnerCount,
        entryCount,
        entryDeadline: campaign.entryDeadline?.toISOString() ?? null,
        requireKyc: campaign.requireKyc,
        status: campaign.status,
        open,
        alreadyEntered,
      },
    })
  })

  // POST /gas-fee/giveaway/enter — enter a campaign (login + KYC1). One entry per user.
  const giveawayEnterSchema = z.object({
    code:             z.string().trim().min(2).max(40),
    receivingAddress: z.string().min(1),
    email:            z.string().email().optional(),
  })
  app.post('/gas-fee/giveaway/enter', { preHandler: [authenticate], config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!(await isFlagEnabled(FLAGS.GAS_GIVEAWAY))) throw new AppError('GIVEAWAY_DISABLED', 'Giveaways are not available right now.', 400)
    const parsed = giveawayEnterSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    const { code, receivingAddress, email } = parsed.data

    const campaign = await db.gasGiveawayCampaign.findUnique({ where: { code: code.trim().toUpperCase() } })
    if (!campaign || !campaign.isActive) throw new AppError('GIVEAWAY_INVALID', 'This giveaway code is not valid.', 400)
    if (campaign.status !== 'open') throw new AppError('GIVEAWAY_CLOSED', 'This giveaway is no longer accepting entries.', 400)
    if (campaign.entryDeadline && campaign.entryDeadline.getTime() < Date.now()) throw new AppError('GIVEAWAY_CLOSED', 'This giveaway has closed.', 400)

    const tokenCfg = await db.gasTokenConfig.findUnique({ where: { id: campaign.gasTokenConfigId }, include: { chain: true } })
    if (!tokenCfg) throw new AppError('GIVEAWAY_INVALID', 'This giveaway is misconfigured.', 400)
    if (!validateAddress(receivingAddress, tokenCfg.chain.addressType)) {
      throw new AppError('INVALID_ADDRESS', `Invalid ${tokenCfg.chain.networkLabel} address format`, 400)
    }

    // Load the account (identity gate + capture email for winner contact). Entry requires a
    // real platform identity: a set username always, plus KYC1 when the campaign requires it.
    const u = await db.user.findUnique({ where: { id: req.user!.id }, select: { kycLevel: true, email: true, username: true } })
    if (!u || !u.username || !u.username.trim()) {
      throw new AppError('USERNAME_REQUIRED', 'Set a platform username to enter this giveaway.', 403)
    }
    if (campaign.requireKyc && u.kycLevel === 'none') {
      throw new AppError('KYC_REQUIRED', 'Complete identity verification (KYC) to enter this giveaway.', 403)
    }
    const contactEmail = email ?? u?.email ?? null

    // One entry per user per campaign; re-entering updates the receiving address.
    await db.gasGiveawayEntry.upsert({
      where: { campaignId_userId: { campaignId: campaign.id, userId: req.user!.id } },
      create: { campaignId: campaign.id, userId: req.user!.id, receivingAddress, ...(contactEmail ? { email: contactEmail } : {}) },
      update: { receivingAddress, ...(contactEmail ? { email: contactEmail } : {}) },
    })
    return reply.send({ success: true, data: { entered: true } })
  })

  const giveawayCreateSchema = z.object({
    code:          z.string().trim().min(2).max(40),
    kolLabel:      z.string().trim().min(1).max(120),
    tokenConfigId: z.string().min(1),
    amountNative:  z.number().positive(),
    winnerCount:   z.number().int().positive().max(100000),
    entryDeadline: z.string().datetime().optional(),
    requireKyc:    z.boolean().default(true),
  })

  // POST /gas-fee/admin/giveaways — create a campaign (super-admin)
  app.post('/gas-fee/admin/giveaways', { preHandler: [authenticate, requireRole('super_admin')] }, async (req, reply) => {
    const parsed = giveawayCreateSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    const p = parsed.data
    const code = p.code.toUpperCase()
    const tokenCfg = await db.gasTokenConfig.findUnique({ where: { id: p.tokenConfigId }, include: { chain: true } })
    if (!tokenCfg) throw Errors.NOT_FOUND('Gas token')
    // Enforce the per-winner amount against the token/chain minimum at CREATION time, so a
    // misconfigured campaign fails here rather than silently at the much-later send step
    // (where it previously surfaced as "Minimum amount is 0.0001 ETH" after a draw).
    const resolvedMin = resolveTokenConfig(tokenCfg, tokenCfg.chain)
    if (p.amountNative < resolvedMin.minAmount) {
      throw new AppError('VALIDATION_ERROR', `Amount per winner must be at least ${resolvedMin.minAmount} ${tokenCfg.symbol} on ${tokenCfg.chain.name}.`, 400)
    }
    const existing = await db.gasGiveawayCampaign.findUnique({ where: { code } })
    if (existing) throw new AppError('CONFLICT', `Giveaway code '${code}' already exists`, 409)
    const created = await db.gasGiveawayCampaign.create({
      data: {
        code, kolLabel: p.kolLabel, gasTokenConfigId: p.tokenConfigId,
        amountNative: p.amountNative, winnerCount: p.winnerCount, requireKyc: p.requireKyc,
        createdById: req.user!.id,
        ...(p.entryDeadline ? { entryDeadline: new Date(p.entryDeadline) } : {}),
      },
    })
    await db.auditLog.create({ data: { actorId: req.user!.id, action: 'GAS_GIVEAWAY_CREATE', targetType: 'GasGiveawayCampaign', targetId: created.id, metadata: { code, winnerCount: p.winnerCount, amountNative: p.amountNative } as never, ipAddress: req.ip ?? null, userAgent: (req.headers['user-agent'] as string | undefined)?.slice(0, 500) ?? null } })
    return reply.code(201).send({ success: true, data: created })
  })

  // GET /gas-fee/admin/giveaways — list campaigns with entry counts (admin)
  app.get('/gas-fee/admin/giveaways', { preHandler: [authenticate, requireRole('admin', 'super_admin')] }, async (_req, reply) => {
    const campaigns = await db.gasGiveawayCampaign.findMany({ orderBy: { createdAt: 'desc' }, include: { _count: { select: { entries: true } } } })
    // Per-campaign entry-status counts so the UI can show "selected (awaiting send)"
    // vs "delivered" without loading the full entry list for every card.
    const byStatus = await db.gasGiveawayEntry.groupBy({ by: ['campaignId', 'status'], _count: { _all: true } })
    const selectedCounts = new Map<string, number>()
    const sentCounts = new Map<string, number>()
    for (const row of byStatus) {
      if (row.status === 'selected') selectedCounts.set(row.campaignId, row._count._all)
      else if (row.status === 'won') sentCounts.set(row.campaignId, row._count._all)
    }
    return reply.send({ success: true, data: campaigns.map((c) => ({
      id: c.id, code: c.code, kolLabel: c.kolLabel, gasTokenConfigId: c.gasTokenConfigId,
      amountNative: c.amountNative.toString(), winnerCount: c.winnerCount, drawnCount: c.drawnCount,
      selectedCount: selectedCounts.get(c.id) ?? 0, sentCount: sentCounts.get(c.id) ?? 0,
      entryCount: c._count.entries, entryDeadline: c.entryDeadline, requireKyc: c.requireKyc,
      status: c.status, isActive: c.isActive, createdAt: c.createdAt,
    })) })
  })

  // GET /gas-fee/admin/giveaways/:id/entries — entries for a campaign (admin), enriched
  // with each winner's delivery status so admins can see who actually received the prize.
  app.get('/gas-fee/admin/giveaways/:id/entries', { preHandler: [authenticate, requireRole('admin', 'super_admin')] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const entries = await db.gasGiveawayEntry.findMany({ where: { campaignId: id }, orderBy: { createdAt: 'desc' }, take: 500 })
    const orderIds = entries.map((e) => e.orderId).filter((x): x is string => !!x)
    const orders = orderIds.length
      ? await db.gasFeeOrder.findMany({ where: { id: { in: orderIds } }, select: { id: true, status: true, orderRef: true } })
      : []
    const orderMap = new Map(orders.map((o) => [o.id, o]))
    return reply.send({ success: true, data: entries.map((e) => {
      const o = e.orderId ? orderMap.get(e.orderId) : undefined
      return {
        id: e.id, userId: e.userId, email: e.email, receivingAddress: e.receivingAddress,
        status: e.status, orderId: e.orderId, createdAt: e.createdAt,
        orderStatus: o?.status ?? null, orderRef: o?.orderRef ?? null,
      }
    }) })
  })

  // POST /gas-fee/admin/giveaways/:id/draw — randomly SELECT winners (no funds move yet).
  // Selection and delivery are split into two steps: draw picks winners into the
  // `selected` state, then POST .../send delivers free gas to them. This gives the
  // admin a chance to review who won before real on-chain funds are released.
  const giveawayDrawSchema = z.object({ count: z.number().int().positive().max(10000).optional() })
  app.post('/gas-fee/admin/giveaways/:id/draw', { preHandler: [authenticate, requireRole('super_admin')] }, async (req, reply) => {
    if (!(await isFlagEnabled(FLAGS.GAS_GIVEAWAY))) throw new AppError('GIVEAWAY_DISABLED', 'Giveaways are not enabled.', 400)
    const { id } = req.params as { id: string }
    const parsed = giveawayDrawSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    const campaign = await db.gasGiveawayCampaign.findUnique({ where: { id } })
    if (!campaign) throw Errors.NOT_FOUND('Giveaway')
    const remainingSlots = campaign.winnerCount - campaign.drawnCount
    if (remainingSlots <= 0) throw new AppError('GIVEAWAY_FULL', 'All winners for this campaign have already been drawn.', 400)

    const pool = await db.gasGiveawayEntry.findMany({ where: { campaignId: id, status: 'entered' }, select: { id: true } })
    const drawCount = Math.min(parsed.data.count ?? remainingSlots, remainingSlots, pool.length)
    if (drawCount <= 0) throw new AppError('NO_ENTRIES', 'There are no eligible entries to draw.', 400)

    // Fisher-Yates shuffle, then take the first drawCount.
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[pool[i], pool[j]] = [pool[j]!, pool[i]!]
    }
    const winners = pool.slice(0, drawCount)

    // CAS-claim each winner `entered → selected` so a concurrent draw can't double-select.
    let selected = 0
    for (const w of winners) {
      const claimed = await db.gasGiveawayEntry.updateMany({ where: { id: w.id, status: 'entered' }, data: { status: 'selected' } })
      if (claimed.count > 0) selected++
    }
    const newDrawn = campaign.drawnCount + selected
    await db.gasGiveawayCampaign.update({
      where: { id },
      data: { drawnCount: newDrawn, ...(newDrawn >= campaign.winnerCount ? { status: 'drawn' } : {}) },
    })
    await db.auditLog.create({ data: { actorId: req.user!.id, action: 'GAS_GIVEAWAY_DRAW', targetType: 'GasGiveawayCampaign', targetId: id, metadata: { requested: drawCount, selected } as never, ipAddress: req.ip ?? null, userAgent: (req.headers['user-agent'] as string | undefined)?.slice(0, 500) ?? null } })
    return reply.send({ success: true, data: { selected, attempted: drawCount } })
  })

  // POST /gas-fee/admin/giveaways/:id/send — deliver free gas to all `selected` winners.
  // Step 2 of the draw→send flow. Each winner that delivers moves `selected → won`;
  // failures stay `selected` so the admin can press Send again to retry just those.
  app.post('/gas-fee/admin/giveaways/:id/send', { preHandler: [authenticate, requireRole('super_admin')] }, async (req, reply) => {
    if (!(await isFlagEnabled(FLAGS.GAS_GIVEAWAY))) throw new AppError('GIVEAWAY_DISABLED', 'Giveaways are not enabled.', 400)
    const { id } = req.params as { id: string }

    const campaign = await db.gasGiveawayCampaign.findUnique({ where: { id } })
    if (!campaign) throw Errors.NOT_FOUND('Giveaway')

    const pending = await db.gasGiveawayEntry.findMany({ where: { campaignId: id, status: 'selected' }, select: { id: true, userId: true, receivingAddress: true } })
    if (pending.length === 0) throw new AppError('NOTHING_TO_SEND', 'There are no selected winners awaiting delivery.', 400)

    const results: Array<{ entryId: string; ok: boolean; orderRef?: string; error?: string }> = []
    for (const w of pending) {
      // CAS-claim `selected → won` so a concurrent send can't double-pay the same entry.
      const claimed = await db.gasGiveawayEntry.updateMany({ where: { id: w.id, status: 'selected' }, data: { status: 'won' } })
      if (claimed.count === 0) continue
      try {
        const res = await issueFreeGasOrder({ tokenConfigId: campaign.gasTokenConfigId, amount: Number(campaign.amountNative), toAddress: w.receivingAddress, userId: w.userId })
        await db.gasGiveawayEntry.update({ where: { id: w.id }, data: { orderId: res.orderId } })
        results.push({ entryId: w.id, ok: true, orderRef: res.orderRef })
      } catch (e) {
        // Revert so this winner stays selected and can be retried on the next Send.
        await db.gasGiveawayEntry.updateMany({ where: { id: w.id, status: 'won' }, data: { status: 'selected' } })
        results.push({ entryId: w.id, ok: false, error: e instanceof Error ? e.message : 'delivery failed' })
      }
    }
    const successful = results.filter((r) => r.ok).length

    // Mark the campaign `sent` once every selected winner has been delivered and the
    // full winner slate has been drawn (nothing left selected, drawn quota reached).
    const stillSelected = await db.gasGiveawayEntry.count({ where: { campaignId: id, status: 'selected' } })
    if (stillSelected === 0 && campaign.drawnCount >= campaign.winnerCount) {
      await db.gasGiveawayCampaign.update({ where: { id }, data: { status: 'sent' } })
    }
    await db.auditLog.create({ data: { actorId: req.user!.id, action: 'GAS_GIVEAWAY_SEND', targetType: 'GasGiveawayCampaign', targetId: id, metadata: { attempted: pending.length, successful, results } as never, ipAddress: req.ip ?? null, userAgent: (req.headers['user-agent'] as string | undefined)?.slice(0, 500) ?? null } })
    return reply.send({ success: true, data: { sent: successful, attempted: pending.length, results } })
  })

  // POST /gas-fee/admin/giveaways/:id/close — instantly close a campaign (super-admin).
  // Stops new entries and marks it done, even when fewer than winnerCount were drawn —
  // e.g. a KOL campaign you want to wrap up early after delivering the prizes you wanted.
  // Idempotent: already-sent/closed campaigns return their current status unchanged.
  app.post('/gas-fee/admin/giveaways/:id/close', { preHandler: [authenticate, requireRole('super_admin')] }, async (req, reply) => {
    if (!(await isFlagEnabled(FLAGS.GAS_GIVEAWAY))) throw new AppError('GIVEAWAY_DISABLED', 'Giveaways are not enabled.', 400)
    const { id } = req.params as { id: string }
    const campaign = await db.gasGiveawayCampaign.findUnique({ where: { id } })
    if (!campaign) throw Errors.NOT_FOUND('Giveaway')
    if (campaign.status === 'closed' || campaign.status === 'sent') {
      return reply.send({ success: true, data: { status: campaign.status } })
    }
    await db.gasGiveawayCampaign.update({ where: { id }, data: { status: 'closed' } })
    await db.auditLog.create({ data: { actorId: req.user!.id, action: 'GAS_GIVEAWAY_CLOSE', targetType: 'GasGiveawayCampaign', targetId: id, metadata: { previousStatus: campaign.status } as never, ipAddress: req.ip ?? null, userAgent: (req.headers['user-agent'] as string | undefined)?.slice(0, 500) ?? null } })
    return reply.send({ success: true, data: { status: 'closed' } })
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

  // ── GET /api/gas-fee/orders/:orderRef ────────────────────────────────────
  // Access control:
  //   - Admin/super_admin          → full data
  //   - Authenticated owner        → full data
  //   - Valid guest trackingToken  → order data minus internal fields
  //   - Otherwise                  → 403 FORBIDDEN
  //
  // paymentAddress is re-derived on every fetch so the QR screen stays correct.

  app.get('/gas-fee/orders/:orderRef', { preHandler: [optionalAuth] }, async (req, reply) => {
    const { orderRef } = req.params as { orderRef: string }
    const { token }    = req.query as { token?: string }

    const order = await db.gasFeeOrder.findUnique({
      where: { orderRef },
      include: { gasTokenConfig: { select: { name: true, symbol: true, logoUrl: true } } },
    })
    if (!order) throw Errors.NOT_FOUND('Gas fee order')

    const isAdmin  = req.user?.role === 'admin' || req.user?.role === 'super_admin'
    const isOwner  = !!(req.user && order.userId && req.user.id === order.userId)
    const hasToken = isTrackingTokenValid(token, order.trackingToken)

    if (!isAdmin && !isOwner && !hasToken) {
      throw new AppError('FORBIDDEN', 'Access denied. Use the original order tracking link.', 403)
    }

    let paymentAddress: string | null = null
    if (order.paymentCoin === 'USDT') {
      if (order.paymentNetwork === 'TRC20') {
        const dbOverride = await db.platformConfig.findUnique({ where: { key: 'gas_usdt_trc20_address' } })
        paymentAddress = dbOverride?.value ?? GAS_CHAINS.TRON.getDepositAddress() ?? null
      } else if (order.paymentNetwork === 'BEP20') {
        const dbOverride = await db.platformConfig.findUnique({ where: { key: 'gas_usdt_bep20_address' } })
        paymentAddress = dbOverride?.value ?? GAS_CHAINS.BSC.getDepositAddress() ?? null
      } else if (order.paymentNetwork === 'ERC20') {
        const dbOverride = await db.platformConfig.findUnique({ where: { key: 'gas_usdt_erc20_address' } })
        paymentAddress = dbOverride?.value ?? GAS_CHAINS.ETHEREUM.getDepositAddress() ?? null
      } else if (order.paymentNetwork === 'APTOS') {
        const dbOverride = await db.platformConfig.findUnique({ where: { key: 'gas_usdt_aptos_address' } })
        paymentAddress = dbOverride?.value ?? getAptosHotWalletAddress() ?? null
      }
    }

    if (isAdmin) {
      return reply.send({ success: true, data: { ...order, paymentAddress } })
    }

    // Strip internal fields from non-admin responses
    const {
      userId: _userId,
      ipAddress: _ip,
      riskScore: _risk,
      fromHotWallet: _hot,
      merchantApiKeyId: _merchant,
      trackingToken: _token,
      ...publicOrder
    } = order

    return reply.send({ success: true, data: { ...publicOrder, paymentAddress } })
  })

  // ── GET /gas-fee/orders/:orderRef/cancel-preview — penalty preview ──────────
  // Lets the UI show the next-cancel penalty in the confirm dialog before the
  // user commits. Access mirrors the order GET (owner / admin / tracking token).
  app.get('/gas-fee/orders/:orderRef/cancel-preview', { preHandler: [optionalAuth] }, async (req, reply) => {
    const { orderRef } = req.params as { orderRef: string }
    const { token }    = req.query as { token?: string }

    const order = await db.gasFeeOrder.findUnique({ where: { orderRef } })
    if (!order) throw Errors.NOT_FOUND('Gas fee order')

    const isAdmin  = req.user?.role === 'admin' || req.user?.role === 'super_admin'
    const isOwner  = !!(req.user && order.userId && req.user.id === order.userId)
    const hasToken = isTrackingTokenValid(token, order.trackingToken)
    if (!isAdmin && !isOwner && !hasToken) {
      throw new AppError('FORBIDDEN', 'Access denied. Use the original order tracking link.', 403)
    }

    const cancellable = order.status === 'payment_pending' && !order.paymentTxHash
    const ident   = gasCancelIdentity(order.userId, order.ipAddress ?? req.ip)
    const preview = await previewCancelPenalty(ident)
    return reply.send({ success: true, data: { cancellable, ...preview } })
  })

  // ── POST /gas-fee/orders/:orderRef/cancel — user-initiated cancellation ─────
  // Only allowed while still `payment_pending` with no payment claimed. Once a
  // tx hash is attached (or the order advances), it must go through the refund
  // path instead. Each cancel is logged and feeds the escalating cooldown ladder.
  app.post('/gas-fee/orders/:orderRef/cancel', { preHandler: [optionalAuth] }, async (req, reply) => {
    const { orderRef } = req.params as { orderRef: string }
    const { token }    = (req.body ?? {}) as { token?: string }

    const order = await db.gasFeeOrder.findUnique({ where: { orderRef } })
    if (!order) throw Errors.NOT_FOUND('Gas fee order')

    const isAdmin  = req.user?.role === 'admin' || req.user?.role === 'super_admin'
    const isOwner  = !!(req.user && order.userId && req.user.id === order.userId)
    const hasToken = isTrackingTokenValid(token, order.trackingToken)
    if (!isAdmin && !isOwner && !hasToken) {
      throw new AppError('FORBIDDEN', 'Access denied. Use the original order tracking link.', 403)
    }

    if (order.status !== 'payment_pending' || order.paymentTxHash) {
      throw new AppError('INVALID_STATUS', `This order can no longer be cancelled (status: ${order.status}).`, 409)
    }

    // Atomic transition guards against a payment landing between the read above
    // and the write (the poller could flip status concurrently).
    const cancelled = await db.gasFeeOrder.updateMany({
      where: { id: order.id, status: 'payment_pending', paymentTxHash: null },
      data:  { status: 'cancelled', cancelledAt: new Date(), cancelReason: 'user_cancelled' },
    })
    if (cancelled.count === 0) {
      const fresh = await db.gasFeeOrder.findUnique({ where: { id: order.id }, select: { status: true } })
      throw new AppError('INVALID_STATUS', `This order can no longer be cancelled (status: ${fresh?.status ?? order.status}).`, 409)
    }

    // The pending expire job is now moot — drop it (best-effort).
    try { await queues.gasFee.remove(`gas-expire-${order.id}`) } catch { /* non-fatal */ }

    const ident   = gasCancelIdentity(order.userId, order.ipAddress ?? req.ip)
    const penalty = await recordCancellation(ident, { id: order.id, orderRef: order.orderRef })

    logger.info({ orderRef, cancelNumber: penalty.cancelNumber, cooldownMs: penalty.cooldownMs }, 'Gas order cancelled by user')
    return reply.send({
      success: true,
      data: {
        orderRef,
        status:        'cancelled',
        cancelNumber:  penalty.cancelNumber,
        cooldownLabel: penalty.cooldownLabel,
        cooldownUntil: penalty.cooldownUntil,
      },
    })
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

  // ── POST /gas-fee/orders/:orderRef/request-refund — user-initiated refund ───
  // For a PAID order that's stuck before delivery (e.g. the hot wallet is empty
  // so delivery is paused/failing). Allowed once the order has been stuck past a
  // short grace window, or as soon as a delivery failure is recorded. Moves the
  // order to refund_pending and enqueues the same automated refund job the system
  // uses on delivery failure — the USDT goes back to the wallet it was paid from.
  const STUCK_REFUND_THRESHOLD_MS = 7 * 60_000

  app.post('/gas-fee/orders/:orderRef/request-refund', { preHandler: [optionalAuth] }, async (req, reply) => {
    const { orderRef } = req.params as { orderRef: string }
    const { token }    = (req.body ?? {}) as { token?: string }

    const order = await db.gasFeeOrder.findUnique({ where: { orderRef } })
    if (!order) throw Errors.NOT_FOUND('Gas fee order')

    const isAdmin  = req.user?.role === 'admin' || req.user?.role === 'super_admin'
    const isOwner  = !!(req.user && order.userId && req.user.id === order.userId)
    const hasToken = isTrackingTokenValid(token, order.trackingToken)
    if (!isAdmin && !isOwner && !hasToken) {
      throw new AppError('FORBIDDEN', 'Access denied. Use the original order tracking link.', 403)
    }

    // Two refundable shapes, both PAID:
    //   • payment_detected — stuck BEFORE delivery (e.g. empty hot wallet). Gated by
    //     a stuck grace window / a recorded failure / admin.
    //   • awaiting_refund  — delivery FAILED and we're in the interactive refund
    //     window. Gated by refundEligibleAt (the 5-min button-unlock) / admin.
    // We deliberately exclude 'sending': the worker has claimed the order and a
    // transfer may be in flight — refunding then could double-spend.
    if (order.status !== 'payment_detected' && order.status !== 'awaiting_refund') {
      throw new AppError('INVALID_STATUS', `This order can't be refunded from here (status: ${order.status}).`, 409)
    }
    if (!order.paymentTxHash) {
      throw new AppError('NO_PAYMENT', 'No payment is recorded for this order yet, so there is nothing to refund.', 409)
    }

    if (order.status === 'awaiting_refund') {
      // Delivery failed — refundable once the window has elapsed.
      if (!isAdmin && !isRefundEligible(order.refundEligibleAt)) {
        const waitS = Math.ceil(refundWaitRemainingMs(order.refundEligibleAt) / 1000)
        throw new AppError('TOO_EARLY', `We're still trying to deliver your gas. You can request a refund in about ${waitS}s if it hasn't arrived.`, 429)
      }
    } else {
      // payment_detected — stuck before delivery: only once it's failed or sat past the grace window.
      const stuckMs = Date.now() - new Date(order.createdAt).getTime()
      const eligible = isAdmin || !!order.failureReason || stuckMs >= STUCK_REFUND_THRESHOLD_MS
      if (!eligible) {
        const waitS = Math.ceil((STUCK_REFUND_THRESHOLD_MS - stuckMs) / 1000)
        throw new AppError('TOO_EARLY', `Please wait a little longer — a refund can be requested in about ${waitS}s if delivery hasn't completed.`, 429)
      }
    }

    // CAS transition from whichever refundable state the order is in. Races the
    // delivery worker's claim (→ sending) and the auto-refund safety net; only one
    // transition can win, so we never refund a claimed/already-refunding order.
    const moved = await db.gasFeeOrder.updateMany({
      where: { id: order.id, status: order.status },
      data:  { status: 'refund_pending', failureReason: order.failureReason ?? 'User requested refund (delivery delayed)' },
    })
    if (moved.count === 0) {
      const fresh = await db.gasFeeOrder.findUnique({ where: { id: order.id }, select: { status: true } })
      throw new AppError('INVALID_STATUS', `This order can no longer be refunded from here (status: ${fresh?.status ?? order.status}).`, 409)
    }

    // Drop the pending safety-net auto-refund — the user beat it to the punch.
    try { await queues.gasFee.remove(`gas-auto-refund-${order.id}`) } catch { /* non-fatal */ }

    const jobId = `gas-refund-${order.id}`
    try { await queues.gasFee.remove(jobId) } catch { /* active or absent — add() stays a safe no-op */ }
    await queues.gasFee.add(
      'process-refund',
      { orderId: order.id },
      { jobId, attempts: 5, backoff: { type: 'exponential', delay: 30_000 } },
    )
    await notifyMerchantWebhook(order.id, 'refund_pending')

    logger.info({ orderRef }, 'Gas order refund requested by user')
    return reply.send({ success: true, data: { orderRef, status: 'refund_pending' } })
  })

  // ── POST /gas-fee/orders/:orderRef/verify-payment — user self-reports txHash ─
  // Lets the user submit their on-chain txHash when automatic detection failed.
  // We verify the tx on-chain (correct recipient, token, amount, confirmations),
  // then attribute the order without waiting for Moralis.
  // Rate-limited to 5 attempts per order to prevent RPC abuse.

  const verifyPaymentSchema = z.object({ txHash: z.string().min(10).max(100) })

  // EVM tx hash: 0x followed by 64 hex chars
  const EVM_TX_REGEX = /^0x[0-9a-fA-F]{64}$/
  const EVM_NETWORKS = new Set(['BEP20', 'ERC20'])

  app.post('/gas-fee/orders/:orderRef/verify-payment', async (req, reply) => {
    const { orderRef } = req.params as { orderRef: string }
    const parsed = verifyPaymentSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'txHash is required', 400)

    const { txHash } = parsed.data

    // Rate limit: 5 verify attempts per order per 10 minutes
    const rlKey = `gas_verify_rl:${orderRef}`
    const attempts = await redis.incr(rlKey)
    if (attempts === 1) await redis.expire(rlKey, 600)
    if (attempts > 5) throw new AppError('RATE_LIMITED', 'Too many verification attempts. Please wait 10 minutes.', 429)

    const order = await db.gasFeeOrder.findUnique({ where: { orderRef } })
    if (!order) throw Errors.NOT_FOUND('Gas fee order')

    // Only allow verification for USDT crypto orders (not PKR fiat orders)
    if (order.paymentCoin !== 'USDT') {
      throw new AppError('INVALID_STATUS', 'Manual verification is only available for USDT payment orders', 400)
    }

    // Validate tx hash format for EVM chains
    if (EVM_NETWORKS.has(order.paymentNetwork) && !EVM_TX_REGEX.test(txHash)) {
      throw new AppError('VALIDATION_ERROR', `Invalid transaction hash format for ${order.paymentNetwork}. Expected a 0x-prefixed 64-character hex string.`, 400)
    }

    // Accept payment_pending or recently-expired orders (15-min grace window)
    const GRACE_MS = 15 * 60 * 1000
    const isExpiredInGrace = order.status === 'expired' && order.expiresAt.getTime() >= Date.now() - GRACE_MS
    if (order.status !== 'payment_pending' && !isExpiredInGrace) {
      const msg = order.status === 'expired'
        ? 'Order expired too long ago to verify. Please create a new order.'
        : `Order is already in status '${order.status}'.`
      throw new AppError('INVALID_STATUS', msg, 409)
    }

    // Duplicate txHash guard
    const alreadyUsed = await db.gasFeeOrder.findFirst({ where: { paymentTxHash: txHash } })
    if (alreadyUsed) {
      if (alreadyUsed.orderRef === orderRef) {
        return reply.send({ success: true, data: { status: alreadyUsed.status, message: 'Transaction already attributed to this order.' } })
      }
      throw new AppError('CONFLICT', 'This transaction hash is already linked to another order.', 409)
    }

    // ── On-chain verification ────────────────────────────────────────────────
    // Resolve the correct RPC and USDT contract for this order's payment network.
    const { createPublicClient, http: viemHttp } = await import('viem')
    const viemChains = await import('viem/chains')

    type NetworkDef = {
      viemChain: import('viem').Chain
      rpcUrl: string
      usdtContract: `0x${string}`
      usdtDecimals: number
      depositAddressDbKey: string
      depositAddressEnvFn: () => string | undefined
      requiredConfirmations: number
    }

    const NETWORK_MAP: Record<string, NetworkDef> = {
      BEP20: {
        viemChain:            viemChains.bsc,
        rpcUrl:               env.BSC_RPC_URL,
        usdtContract:         '0x55d398326f99059fF775485246999027B3197955',
        usdtDecimals:         18,
        depositAddressDbKey:  'gas_usdt_bep20_address',
        depositAddressEnvFn:  () => env.GAS_FEE_DEPOSIT_ADDRESS_BEP20,
        requiredConfirmations: 3,
      },
      ERC20: {
        viemChain:            viemChains.mainnet,
        rpcUrl:               env.ETHEREUM_RPC_URL,
        usdtContract:         '0xdAC17F958D2ee523a2206206994597C13D831ec7',
        usdtDecimals:         6,
        depositAddressDbKey:  'gas_usdt_erc20_address',
        depositAddressEnvFn:  () => env.GAS_FEE_DEPOSIT_ADDRESS_ERC20,
        requiredConfirmations: 12,
      },
    }

    // TRC20 on-chain decode requires TronWeb ABI parsing — the automatic poller handles TRON.
    if (order.paymentNetwork === 'TRC20') {
      throw new AppError('CHAIN_NOT_SUPPORTED', 'Manual verification for TRC20 is not yet available. Please wait for automatic detection or contact support.', 400)
    }

    const netDef = NETWORK_MAP[order.paymentNetwork]
    if (!netDef) throw new AppError('CHAIN_NOT_SUPPORTED', `Payment network '${order.paymentNetwork}' does not support on-chain verification`, 400)

    // Resolve the deposit address (DB override takes precedence)
    const dbDepositOverride = await db.platformConfig.findUnique({ where: { key: netDef.depositAddressDbKey } })
    const depositAddress = (dbDepositOverride?.value ?? netDef.depositAddressEnvFn())?.toLowerCase()

    // If deposit address is not configured we cannot verify on-chain, but we can
    // still accept the txHash and queue the order for manual admin review.
    if (!depositAddress) {
      const claimed = await db.gasFeeOrder.updateMany({
        where: { id: order.id, status: { in: ['payment_pending', 'expired'] }, paymentTxHash: null },
        data:  { status: 'payment_uploaded', paymentTxHash: txHash },
      })
      if (claimed.count === 0) {
        const fresh = await db.gasFeeOrder.findUnique({ where: { id: order.id }, select: { status: true } })
        return reply.send({ success: true, data: { status: fresh?.status ?? order.status, message: 'Payment already recorded.' } })
      }
      logger.warn({ orderRef, txHash, network: order.paymentNetwork }, 'verify-payment: deposit address not configured — txHash queued for admin review')
      return reply.send({ success: true, data: { status: 'payment_uploaded', message: 'Payment submitted for review. An admin will verify and release your gas shortly.' } })
    }

    // ── EVM verification (BSC / ETH) ─────────────────────────────────────────
    const client = createPublicClient({ chain: netDef.viemChain, transport: viemHttp(netDef.rpcUrl, { timeout: 12_000 }) })

    let receipt: Awaited<ReturnType<typeof client.getTransactionReceipt>> | null = null
    try {
      receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` })
    } catch (err) {
      logger.warn({ err, txHash, orderRef }, 'verify-payment: getTransactionReceipt failed')
      throw new AppError('VERIFICATION_ERROR', 'Transaction not found on-chain. It may still be pending — please wait for at least 1 confirmation and try again.', 400)
    }

    if (!receipt || receipt.status !== 'success') {
      throw new AppError('VERIFICATION_ERROR', 'Transaction failed or was reverted on-chain.', 400)
    }

    // Check confirmation count
    const currentBlock = await client.getBlockNumber()
    const confirmations = Number(currentBlock) - Number(receipt.blockNumber)
    if (confirmations < netDef.requiredConfirmations) {
      throw new AppError('VERIFICATION_ERROR', `Transaction needs ${netDef.requiredConfirmations} confirmations but only has ${confirmations}. Please wait a moment and try again.`, 400)
    }

    // Parse ERC20 Transfer logs from the receipt
    const TRANSFER_SIG = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
    const transferLogs = receipt.logs.filter(
      (l) => l.address.toLowerCase() === netDef.usdtContract.toLowerCase() && l.topics[0] === TRANSFER_SIG,
    )

    if (transferLogs.length === 0) {
      throw new AppError('VERIFICATION_ERROR', `No USDT transfer found in this transaction. Make sure you sent USDT on the ${order.paymentNetwork} network.`, 400)
    }

    // Find a Transfer log whose 'to' matches our deposit address and amount is in range
    const paymentAmountFloat = parseFloat(order.paymentAmount.toString())
    const lo = paymentAmountFloat * 0.99
    const hi = paymentAmountFloat * 1.01

    let matchedAmount: number | null = null
    for (const log of transferLogs) {
      if (!log.topics[2]) continue
      const toAddr = '0x' + log.topics[2].slice(26).toLowerCase()
      if (toAddr !== depositAddress) continue

      // Decode uint256 value from data field (guard against empty data on non-standard logs)
      if (!log.data || log.data === '0x') continue
      let rawValue: bigint
      try { rawValue = BigInt(log.data) } catch { continue }
      const humanAmount = Number(rawValue) / Math.pow(10, netDef.usdtDecimals)
      if (humanAmount >= lo && humanAmount <= hi) {
        matchedAmount = humanAmount
        break
      }
    }

    if (matchedAmount === null) {
      // Give the user a useful error: did the 'to' match but amount was wrong?
      const anyToUs = transferLogs.some((l) => l.topics[2] && '0x' + l.topics[2].slice(26).toLowerCase() === depositAddress)
      if (anyToUs) {
        throw new AppError('VERIFICATION_ERROR', `USDT transfer found but the amount doesn't match the order. Expected ~${paymentAmountFloat.toFixed(4)} USDT (±1%).`, 400)
      }
      throw new AppError('VERIFICATION_ERROR', `This transaction does not send USDT to our deposit address. Please check you used the correct address.`, 400)
    }

    // ── Block timestamp vs order expiry (grace window) ───────────────────────
    if (order.status === 'expired') {
      let blockTimestampMs: number | null = null
      try {
        const block = await client.getBlock({ blockNumber: receipt.blockNumber })
        blockTimestampMs = Number(block.timestamp) * 1000
      } catch { /* best effort */ }

      if (blockTimestampMs !== null && blockTimestampMs >= order.expiresAt.getTime()) {
        throw new AppError('VERIFICATION_ERROR', 'Your transaction was confirmed after the order expired. Please create a new order.', 409)
      }
    }

    // ── Attribute order — set payment_verified (admin must Release Gas) ─────────
    const claimed = await db.gasFeeOrder.updateMany({
      where: { id: order.id, status: order.status === 'expired' ? 'expired' : 'payment_pending', paymentTxHash: null },
      data:  {
        status:               'payment_verified',
        paymentTxHash:        txHash,
        paymentVerifiedAt:    new Date(),
        verifiedAmount:       matchedAmount,
        verifiedAsset:        'USDT',
        verifiedConfirmations: confirmations,
      },
    })

    if (claimed.count === 0) {
      // Race condition: another process (webhook / poller) already claimed it
      const fresh = await db.gasFeeOrder.findUnique({ where: { id: order.id }, select: { status: true } })
      return reply.send({ success: true, data: { status: fresh?.status ?? order.status, message: 'Payment already detected.' } })
    }

    logger.info({ orderRef, txHash, amount: matchedAmount, network: order.paymentNetwork, confirmations }, 'verify-payment: user self-reported — payment_verified, awaiting admin release')

    return reply.send({ success: true, data: { status: 'payment_verified', message: 'Payment verified! An admin will release your gas shortly.' } })
  })
}
