import { db } from '../lib/prisma'
import { AppError } from '../lib/errors'
import { Prisma } from '@prisma/client'
import { FLAGS, isFlagEnabled, getNumberConfig } from './platformFlags.service'
import { notify } from '../lib/notify'
import { validateAddressForNetwork } from '../lib/addressValidation'
import { checkPriceMargin, marginRejectionMessage } from '../lib/priceGuardrail'
import { getUsdtMarketInsight } from './marketplace.service'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CreateAdInput {
  side: 'buy' | 'sell'
  coin: string
  network: string
  networks?: string[]
  priceType: 'fixed' | 'float'
  price: number
  floatOffset?: number
  totalAmount?: number
  minOrder: number
  maxOrder: number
  paymentMethods: string[]
  tokenDeliveryTypes?: string[]
  settlementMethod?: string
  tradeWindow?: number
  terms?: string
}

export interface UpdateAdInput {
  price?: number
  floatOffset?: number
  minOrder?: number
  maxOrder?: number
  availableAmount?: number
  paymentMethods?: string[]
  tradeWindow?: number
  terms?: string
}

export interface GetUserAdsParams {
  status?: string
  page?: number
  limit?: number
}

// ─── Service Functions ────────────────────────────────────────────────────────

export async function createAd(userId: string, data: CreateAdInput) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { kycStatus: true, kycLevel: true },
  })

  if (!user) throw new AppError('NOT_FOUND', 'User not found', 404)
  if (user.kycStatus !== 'approved') {
    throw new AppError('KYC_REQUIRED', 'KYC approval required to post ads', 403)
  }
  // Non-custodial trust model: Level 2 (enhanced) makers post unlimited ads;
  // Level 1 (basic) makers get the privilege of a limited number of active ads
  // at a time (default 1) so a scammer can't run a storefront. Flag OFF
  // preserves the original behavior (any approved user can post freely).
  if (user.kycLevel !== 'enhanced' && (await isFlagEnabled(FLAGS.NONCUSTODIAL_P2P))) {
    const l1Row = await db.platformConfig.findUnique({ where: { key: 'noncustodial_l1_max_ads' } })
    const l1Max = l1Row ? parseInt(l1Row.value, 10) : 1
    const activeCount = await db.ad.count({ where: { userId, status: { in: ['active', 'paused'] } } })
    if (activeCount >= l1Max) {
      throw new AppError(
        'KYC_LEVEL2_REQUIRED',
        `Level 1 users can have ${l1Max} active ad${l1Max === 1 ? '' : 's'} at a time. Upgrade to Level 2 (enhanced) KYC to post more.`,
        403,
      )
    }
  }

  if (data.minOrder > data.maxOrder) {
    throw new AppError('VALIDATION_ERROR', 'minOrder must be less than or equal to maxOrder', 400)
  }
  if (data.minOrder <= 0 || data.maxOrder <= 0) {
    throw new AppError('VALIDATION_ERROR', 'Amounts must be positive', 400)
  }

  // Resolve the full network set. A wallet-delivery ad may offer several on-chain
  // networks (BEP20 + Aptos); `network` is kept as the primary (first) for
  // back-compat. Falls back to [network] when no explicit set is given.
  const effectiveNetworks = data.networks?.length ? data.networks : [data.network]
  const primaryNetwork = effectiveNetworks[0] ?? data.network

  // Validate the maker's receiving address (buy ads) against the network/venue
  // it will be used with, so a malformed destination can never be persisted.
  // Wallet delivery → must be valid for EVERY on-chain network offered;
  // exchange-only delivery → validate against the selected venue's UID format.
  if (data.settlementMethod && data.settlementMethod.trim()) {
    const settlement = data.settlementMethod.trim()
    const deliveryTypes = data.tokenDeliveryTypes ?? []
    const usesWallet = deliveryTypes.includes('wallet_blockchain')
    if (usesWallet) {
      for (const net of effectiveNetworks) {
        const res = validateAddressForNetwork(settlement, net)
        if (!res.valid) {
          throw new AppError('VALIDATION_ERROR', res.reason ?? 'Invalid receiving address', 400)
        }
      }
    } else {
      const venue = deliveryTypes.find((t) => t !== 'wallet_blockchain') ?? ''
      if (venue) {
        const res = validateAddressForNetwork(settlement, venue)
        if (!res.valid) {
          throw new AppError('VALIDATION_ERROR', res.reason ?? 'Invalid receiving address', 400)
        }
      }
    }
  }

  // Price-margin guardrail (fixed-price USDT ads): the price must stay within
  // ±usdt_price_margin_pct of OUR marketplace average. Disabled when there's no
  // reference yet (bootstrapping) or the admin sets the margin to 0. Float ads are
  // inherently bounded by the market rate + offset, so they're exempt here.
  if (data.priceType === 'fixed' && data.coin.toUpperCase() === 'USDT') {
    const marginPct = await getNumberConfig('usdt_price_margin_pct', 5)
    const insight = await getUsdtMarketInsight()
    const check = checkPriceMargin(data.price, insight.avg, marginPct)
    if (!check.ok && check.min != null && check.max != null) {
      throw new AppError('PRICE_OUT_OF_RANGE', marginRejectionMessage({ unitLabel: 'USDT', marginPct, min: check.min, max: check.max }), 400)
    }
  }

  const totalAmount = data.totalAmount ?? 0

  // For sell ads: verify the user has enough balance in their wallet.
  //
  // Non-custodial mode (flag OFF by default): the platform holds no USDT, so a
  // sell ad no longer requires pre-funded/locked on-platform balance — the asset
  // settles off-platform and protection shifts to KYC + identity + reputation +
  // dispute. With the flag OFF, the original custodial balance check is enforced
  // unchanged, so production behavior is identical until a super-admin flips
  // `noncustodial_p2p_enabled`.
  if (data.side === 'sell') {
    if (totalAmount <= 0) {
      throw new AppError('VALIDATION_ERROR', 'Total available amount is required for sell listings', 400)
    }
    const nonCustodial = await isFlagEnabled(FLAGS.NONCUSTODIAL_P2P)
    if (!nonCustodial) {
      const wallet = await db.wallet.findFirst({
        where: { userId, coin: data.coin.toUpperCase() },
        select: { balance: true, lockedBalance: true },
      })
      const available = wallet
        ? new Prisma.Decimal(wallet.balance).sub(new Prisma.Decimal(wallet.lockedBalance))
        : new Prisma.Decimal(0)
      if (new Prisma.Decimal(totalAmount).gt(available)) {
        throw new AppError(
          'INSUFFICIENT_BALANCE',
          `Insufficient ${data.coin} balance. Available: ${available.toFixed(8)}, Required: ${totalAmount}`,
          400,
        )
      }
    }
  }

  const ad = await db.ad.create({
    data: {
      userId,
      side: data.side as 'buy' | 'sell',
      coin: data.coin,
      network: primaryNetwork,
      networks: effectiveNetworks,
      priceType: data.priceType as 'fixed' | 'float',
      price: new Prisma.Decimal(data.price),
      floatOffset: data.floatOffset != null ? new Prisma.Decimal(data.floatOffset) : new Prisma.Decimal(0),
      totalAmount: new Prisma.Decimal(totalAmount),
      availableAmount: new Prisma.Decimal(totalAmount),
      minOrder: new Prisma.Decimal(data.minOrder),
      maxOrder: new Prisma.Decimal(data.maxOrder),
      paymentMethods: data.paymentMethods,
      tokenDeliveryTypes: data.tokenDeliveryTypes ?? [],
      settlementMethod: data.settlementMethod ?? null,
      tradeWindow: data.tradeWindow ?? 30,
      terms: data.terms ?? '',
      status: 'active',
    },
  })

  // Confirmation notification (bell + push, no Telegram) so the maker sees their
  // listing went live — previously creating an ad produced no notification.
  const sideLabel = ad.side === 'sell' ? 'Sell' : 'Buy'
  notify(
    userId,
    'listing_created',
    'Listing created ✓',
    `Your ${sideLabel} ${ad.coin} listing is now live on the marketplace.`,
    { adId: ad.id, side: ad.side, coin: ad.coin },
    undefined,
    '/my-ads',
  )

  return ad
}

export async function getUserAds(userId: string, params: GetUserAdsParams) {
  const page = params.page ?? 1
  const limit = Math.min(params.limit ?? 20, 50)
  const skip = (page - 1) * limit

  const where: Prisma.AdWhereInput = {
    userId,
    ...(params.status ? { status: params.status as 'active' | 'paused' | 'completed' } : {}),
  }

  const [items, total] = await Promise.all([
    db.ad.findMany({ where, skip, take: limit, orderBy: { createdAt: 'desc' } }),
    db.ad.count({ where }),
  ])

  return { items, total, page, limit, totalPages: Math.ceil(total / limit) }
}

export async function updateAd(userId: string, adId: string, data: UpdateAdInput) {
  const ad = await db.ad.findUnique({ where: { id: adId } })
  if (!ad) throw new AppError('NOT_FOUND', 'Ad not found', 404)
  if (ad.userId !== userId) throw new AppError('FORBIDDEN', 'You do not own this ad', 403)
  if (ad.status === 'completed') throw new AppError('CONFLICT', 'Cannot update a completed ad', 409)

  const updateData: Prisma.AdUpdateInput = {}
  if (data.price != null) updateData.price = new Prisma.Decimal(data.price)
  if (data.floatOffset != null) updateData.floatOffset = new Prisma.Decimal(data.floatOffset)
  if (data.minOrder != null) updateData.minOrder = new Prisma.Decimal(data.minOrder)
  if (data.maxOrder != null) updateData.maxOrder = new Prisma.Decimal(data.maxOrder)
  if (data.availableAmount != null) updateData.availableAmount = new Prisma.Decimal(data.availableAmount)
  if (data.paymentMethods != null) updateData.paymentMethods = data.paymentMethods
  if (data.tradeWindow != null) updateData.tradeWindow = data.tradeWindow
  if (data.terms != null) updateData.terms = data.terms

  const minOrder = data.minOrder ?? Number(ad.minOrder)
  const maxOrder = data.maxOrder ?? Number(ad.maxOrder)
  if (minOrder > maxOrder) {
    throw new AppError('VALIDATION_ERROR', 'minOrder must be less than or equal to maxOrder', 400)
  }

  // Re-apply the price-margin guardrail on a price edit (fixed-price USDT ads),
  // so an ad can't be edited to a deceptive off-market price after creation.
  if (data.price != null && ad.priceType === 'fixed' && ad.coin.toUpperCase() === 'USDT') {
    const marginPct = await getNumberConfig('usdt_price_margin_pct', 5)
    const insight = await getUsdtMarketInsight()
    const check = checkPriceMargin(data.price, insight.avg, marginPct)
    if (!check.ok && check.min != null && check.max != null) {
      throw new AppError('PRICE_OUT_OF_RANGE', marginRejectionMessage({ unitLabel: 'USDT', marginPct, min: check.min, max: check.max }), 400)
    }
  }

  return db.ad.update({ where: { id: adId }, data: updateData })
}

export async function toggleAdStatus(userId: string, adId: string, status: 'active' | 'paused') {
  const ad = await db.ad.findUnique({ where: { id: adId } })
  if (!ad) throw new AppError('NOT_FOUND', 'Ad not found', 404)
  if (ad.userId !== userId) throw new AppError('FORBIDDEN', 'You do not own this ad', 403)
  if (ad.status === 'completed') throw new AppError('CONFLICT', 'Cannot change status of a completed ad', 409)

  return db.ad.update({ where: { id: adId }, data: { status } })
}

export async function deleteAd(userId: string, adId: string) {
  const ad = await db.ad.findUnique({ where: { id: adId } })
  if (!ad) throw new AppError('NOT_FOUND', 'Ad not found', 404)
  if (ad.userId !== userId) throw new AppError('FORBIDDEN', 'You do not own this ad', 403)

  // Check no active trades
  const activeTradeCount = await db.trade.count({
    where: {
      adId,
      status: { in: ['payment_pending', 'payment_uploaded', 'payment_confirmed', 'crypto_sent'] },
    },
  })
  if (activeTradeCount > 0) {
    throw new AppError('CONFLICT', 'Cannot delete ad with active trades', 409)
  }

  return db.ad.update({ where: { id: adId }, data: { status: 'completed' } })
}
