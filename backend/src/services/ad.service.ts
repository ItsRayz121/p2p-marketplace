import { db } from '../lib/prisma'
import { AppError } from '../lib/errors'
import { Prisma } from '@prisma/client'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CreateAdInput {
  side: 'buy' | 'sell'
  coin: string
  network: string
  priceType: 'fixed' | 'float'
  price: number
  floatOffset?: number
  totalAmount: number
  minOrder: number
  maxOrder: number
  paymentMethods: string[]
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
  // Validate KYC status
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { kycStatus: true, completedSellTrades: true, collateralLocks: { where: { status: 'locked' }, take: 1 } },
  })

  if (!user) throw new AppError('NOT_FOUND', 'User not found', 404)
  if (user.kycStatus !== 'approved') {
    throw new AppError('KYC_REQUIRED', 'KYC approval required to post ads', 403)
  }

  // Sell ads require either 3+ completed sell trades OR active collateral
  if (data.side === 'sell') {
    const hasCollateral = user.collateralLocks.length > 0
    if (!hasCollateral && user.completedSellTrades < 3) {
      throw new AppError(
        'SELL_ELIGIBILITY',
        'You must complete 3 sell trades or lock collateral before posting sell ads',
        403,
      )
    }
  }

  if (data.minOrder > data.maxOrder) {
    throw new AppError('VALIDATION_ERROR', 'minOrder must be less than or equal to maxOrder', 400)
  }
  if (data.minOrder <= 0 || data.maxOrder <= 0 || data.totalAmount <= 0) {
    throw new AppError('VALIDATION_ERROR', 'Amounts must be positive', 400)
  }

  const ad = await db.ad.create({
    data: {
      userId,
      side: data.side as 'buy' | 'sell',
      coin: data.coin,
      network: data.network,
      priceType: data.priceType as 'fixed' | 'float',
      price: new Prisma.Decimal(data.price),
      floatOffset: data.floatOffset != null ? new Prisma.Decimal(data.floatOffset) : new Prisma.Decimal(0),
      totalAmount: new Prisma.Decimal(data.totalAmount),
      availableAmount: new Prisma.Decimal(data.totalAmount),
      minOrder: new Prisma.Decimal(data.minOrder),
      maxOrder: new Prisma.Decimal(data.maxOrder),
      paymentMethods: data.paymentMethods,
      tradeWindow: data.tradeWindow ?? 30,
      terms: data.terms ?? '',
      status: 'active',
    },
  })

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
