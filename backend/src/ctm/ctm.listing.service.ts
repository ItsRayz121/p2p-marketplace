import { db } from '../lib/prisma'
import { AppError } from '../lib/errors'
import { Prisma } from '@prisma/client'
import type { CtmSettlementType, CtmListingStatus, CtmTradeStatus } from '@prisma/client'
import { FLAGS, isFlagEnabled, getNumberConfig } from '../services/platformFlags.service'
import { getBondConfig, computeBondUsdt } from '../services/makerBond.service'

type Tx = Prisma.TransactionClient

const TIER_CAPS: Record<string, number> = {
  new: 5_000,
  basic: 25_000,
  verified: 100_000,
  elite: 1_000_000,
}

export interface CreateListingInput {
  tokenId: string
  side: 'buy' | 'sell'
  settlementType: CtmSettlementType
  pricePerUnit: number
  totalAmount: number
  minOrderTokens: number
  maxOrderTokens: number
  settlementMethod?: string
  tokenDeliveryType?: 'blockchain' | 'email' | 'username'
  settlementNote: string
  paymentMethods: string[]
  tradeWindowMins?: number
  terms?: string
  requiresProof?: boolean
  proofInstructions?: string
  expiresAt?: Date
}

const PM_LABELS: Record<string, string> = {
  jazzcash: 'JazzCash',
  easypaisa: 'Easypaisa',
  sadapay: 'SadaPay',
  nayapay: 'NayaPay',
  bank_transfer: 'Bank Transfer',
}

async function resolvePaymentMethods(ids: string[]) {
  if (ids.length === 0) return []
  const methods = await db.paymentMethod.findMany({
    where: { id: { in: ids } },
    select: { id: true, type: true, accountName: true, bankName: true },
  })
  return ids.map((id) => {
    const m = methods.find((x) => x.id === id)
    if (!m) return { id, type: 'unknown', label: 'Unknown' }
    const label = m.type === 'bank_transfer' ? (m.bankName ?? 'Bank Transfer') : (PM_LABELS[m.type] ?? m.type)
    return { id, type: m.type as string, label }
  })
}

export interface ListingsFilter {
  tokenId?: string
  side?: string
  paymentMethod?: string
  page?: number
  limit?: number
  merchantProfileId?: string
  status?: CtmListingStatus
  adminView?: boolean
  tier?: string
  sortBy?: string
  sortDir?: 'asc' | 'desc'
}

export async function createListing(userId: string, data: CreateListingInput) {
  const merchantProfile = await db.ctmMerchantProfile.findUnique({
    where: { userId },
    include: { merchant: { select: { status: true } } },
  })
  if (!merchantProfile) throw new AppError('FORBIDDEN', 'You must be a registered CTM merchant to create listings', 403)
  if (!merchantProfile.isActive) throw new AppError('FORBIDDEN', 'Your CTM merchant profile is suspended', 403)

  // Non-custodial trust model: Level 2 (enhanced) makers list freely; Level 1
  // (basic) makers may keep a limited number of active listings (default 1).
  // Flag OFF preserves the original behavior.
  if (await isFlagEnabled(FLAGS.NONCUSTODIAL_P2P)) {
    const u = await db.user.findUnique({ where: { id: userId }, select: { kycLevel: true } })
    if (u?.kycLevel !== 'enhanced') {
      const l1Max = Math.floor(await getNumberConfig('noncustodial_l1_max_ads_ctm', 2))
      const activeCount = await db.ctmListing.count({
        where: { merchantProfileId: merchantProfile.id, status: { in: ['active', 'paused'] } },
      })
      if (activeCount >= l1Max) {
        throw new AppError(
          'KYC_LEVEL2_REQUIRED',
          `Level 1 users can have ${l1Max} active listing${l1Max === 1 ? '' : 's'} at a time. Upgrade to Level 2 (enhanced) KYC to list more.`,
          403,
        )
      }
    }
  }

  const token = await db.ctmToken.findUnique({ where: { id: data.tokenId } })
  if (!token) throw new AppError('NOT_FOUND', 'Token not found', 404)
  if (token.status !== 'approved') throw new AppError('FORBIDDEN', 'Token is not approved for listing', 403)
  if (!token.isListingEnabled) throw new AppError('FORBIDDEN', 'Listings are disabled for this token', 403)

  if (data.minOrderTokens <= 0) throw new AppError('VALIDATION_ERROR', 'Minimum tokens per order must be greater than 0', 400)
  if (data.maxOrderTokens < data.minOrderTokens) throw new AppError('VALIDATION_ERROR', 'Maximum tokens per order must be greater than or equal to minimum', 400)
  if (data.maxOrderTokens > data.totalAmount) throw new AppError('VALIDATION_ERROR', 'Maximum tokens per order cannot exceed total listing amount', 400)

  const maxPkrPerTrade = TIER_CAPS[merchantProfile.tier] ?? 5_000
  const maxOrderPkrComputed = data.maxOrderTokens * data.pricePerUnit
  if (maxOrderPkrComputed > maxPkrPerTrade) {
    throw new AppError('FORBIDDEN', `Your merchant tier (${merchantProfile.tier}) allows max PKR ${maxPkrPerTrade} per trade (max tokens × price = ${maxOrderPkrComputed.toFixed(2)})`, 403)
  }

  if (token.maxListingAmount && new Prisma.Decimal(data.totalAmount).gt(token.maxListingAmount)) {
    throw new AppError('VALIDATION_ERROR', `Total amount exceeds token max listing amount of ${token.maxListingAmount}`, 400)
  }

  // Validate payment method IDs — all must belong to this seller
  const savedMethods = await db.paymentMethod.findMany({
    where: { id: { in: data.paymentMethods }, userId },
    select: { id: true },
  })
  if (savedMethods.length !== data.paymentMethods.length) {
    throw new AppError('VALIDATION_ERROR', 'One or more payment methods not found or not yours', 400)
  }

  return db.ctmListing.create({
    data: {
      merchantProfileId: merchantProfile.id,
      tokenId: data.tokenId,
      side: data.side as never,
      settlementType: data.settlementType,
      priceType: 'fixed',
      pricePerUnit: new Prisma.Decimal(data.pricePerUnit),
      totalAmount: new Prisma.Decimal(data.totalAmount),
      availableAmount: new Prisma.Decimal(data.totalAmount),
      minOrderTokens: new Prisma.Decimal(data.minOrderTokens),
      maxOrderTokens: new Prisma.Decimal(data.maxOrderTokens),
      settlementMethod: data.settlementMethod ?? '',
      ...(data.tokenDeliveryType ? { tokenDeliveryType: data.tokenDeliveryType } : {}),
      settlementNote: data.settlementNote,
      paymentMethods: data.paymentMethods,
      tradeWindowMins: data.tradeWindowMins ?? 45,
      terms: data.terms ?? '',
      requiresProof: data.requiresProof ?? true,
      proofInstructions: data.proofInstructions ?? null,
      ...(data.expiresAt ? { expiresAt: data.expiresAt } : {}),
    },
  })
}

export async function getListings(filters: ListingsFilter = {}) {
  const { tokenId, side, paymentMethod, page = 1, limit = 20, merchantProfileId, status, adminView = false, tier, sortBy, sortDir = 'desc' } = filters
  const skip = (page - 1) * limit

  const where: Record<string, unknown> = adminView ? {} : { status: 'active' }
  if (tokenId) where.tokenId = tokenId
  if (side) where.side = side
  if (merchantProfileId) where.merchantProfileId = merchantProfileId
  if (status) where.status = status
  if (paymentMethod) where.paymentMethods = { has: paymentMethod }
  if (tier) where.merchantProfile = { is: { tier: tier as never } }

  const ALLOWED_SORT_FIELDS: Record<string, object> = {
    createdAt: { createdAt: sortDir },
    pricePerUnit: { pricePerUnit: sortDir },
    ctmAvgRating: { merchantProfile: { ctmAvgRating: sortDir } },
    completedCtmTrades: { merchantProfile: { completedCtmTrades: sortDir } },
  }
  const orderBy = ALLOWED_SORT_FIELDS[sortBy ?? 'createdAt'] ?? { createdAt: 'desc' }

  const [listings, total] = await Promise.all([
    db.ctmListing.findMany({
      where,
      skip,
      take: limit,
      orderBy,
      include: {
        token: { select: { id: true, slug: true, name: true, symbol: true, logoUrl: true, riskTier: true, communityVerified: true, status: true } },
        merchantProfile: {
          select: {
            id: true,
            tier: true,
            totalCtmTrades: true,
            completedCtmTrades: true,
            ctmAvgRating: true,
            merchant: { select: { id: true, status: true, businessName: true } },
            user: {
              select: {
                id: true,
                username: true,
                fullName: true,
                avatarUrl: true,
                createdAt: true,
                lastSeenAt: true,
                tradeStats: { select: { badge: true, completionRate: true } },
              },
            },
          },
        },
      },
    }),
    db.ctmListing.count({ where }),
  ])

  // Resolve all payment method IDs across all listings in one query
  const allIds = [...new Set(listings.flatMap((l) => l.paymentMethods))]
  const allMethods = await db.paymentMethod.findMany({
    where: { id: { in: allIds } },
    select: { id: true, type: true, accountName: true, bankName: true },
  })
  const resolvedListings: Array<Record<string, unknown>> = listings.map((l) => ({
    ...l,
    resolvedPaymentMethods: l.paymentMethods.map((id) => {
      const m = allMethods.find((x) => x.id === id)
      if (!m) return { id, type: 'unknown', label: 'Unknown' }
      const label = m.type === 'bank_transfer' ? (m.bankName ?? 'Bank Transfer') : (PM_LABELS[m.type] ?? m.type)
      return { id, type: m.type as string, label }
    }),
  }))

  // Maker-bond availability annotation (flag-gated). Marks listings whose maker
  // (listing creator) can't cover the USDT bond for even their min order, so the
  // UI can show "maker unavailable". Needs the USDT/PKR rate to convert the PKR
  // order to USDT-equivalent; if the rate is missing we skip (fail-open), matching
  // the bond-lock behavior. One batched balance query for the page (no N+1).
  const bondCfg = await getBondConfig()
  if (bondCfg.enabled && resolvedListings.length > 0) {
    const usdtPkr = await getNumberConfig('rate_USDT_PKR', 0)
    if (usdtPkr > 0) {
      const makerIds = [...new Set(listings.map((l) => l.merchantProfile.user.id))]
      const balRows = await db.$queryRaw<Array<{ userId: string; avail: string }>>`
        SELECT "userId", COALESCE(SUM(balance - "lockedBalance"), 0)::text AS avail
        FROM "Wallet"
        WHERE "userId" IN (${Prisma.join(makerIds)}) AND coin = 'USDT'
        GROUP BY "userId"
      `
      const availByMaker = new Map<string, Prisma.Decimal>()
      for (const r of balRows) availByMaker.set(r.userId, new Prisma.Decimal(r.avail))
      for (let i = 0; i < resolvedListings.length; i++) {
        const l = listings[i]!
        const minOrderPkr = l.minOrderTokens.mul(l.pricePerUnit)
        const minOrderUsdt = minOrderPkr.toNumber() / usdtPkr
        const bondForMin = computeBondUsdt(minOrderUsdt, bondCfg)
        const avail = availByMaker.get(l.merchantProfile.user.id) ?? new Prisma.Decimal(0)
        resolvedListings[i]!.makerBondInsufficient = avail.lt(bondForMin)
      }
    }
  }

  return { listings: resolvedListings, total, page, limit, totalPages: Math.ceil(total / limit) }
}

export async function getListingById(id: string) {
  const listing = await db.ctmListing.findUnique({
    where: { id },
    include: {
      token: true,
      merchantProfile: {
        include: {
          user: { select: { id: true, username: true } },
        },
      },
    },
  })
  if (!listing) throw new AppError('NOT_FOUND', 'Listing not found', 404)
  const resolvedPaymentMethods = await resolvePaymentMethods(listing.paymentMethods)
  return { ...listing, resolvedPaymentMethods }
}

export async function updateListing(userId: string, listingId: string, data: {
  pricePerUnit?: number
  minOrderTokens?: number
  maxOrderTokens?: number
  terms?: string
  paymentMethods?: string[]
  settlementNote?: string
  tradeWindowMins?: number
}) {
  const listing = await db.ctmListing.findUnique({
    where: { id: listingId },
    include: { merchantProfile: { select: { userId: true, tier: true } } },
  })
  if (!listing) throw new AppError('NOT_FOUND', 'Listing not found', 404)
  if (listing.merchantProfile.userId !== userId) throw new AppError('FORBIDDEN', 'Not your listing', 403)

  const effectivePrice = data.pricePerUnit ?? Number(listing.pricePerUnit)
  if (data.maxOrderTokens) {
    const maxPkrPerTrade = TIER_CAPS[listing.merchantProfile.tier] ?? 5_000
    if (data.maxOrderTokens * effectivePrice > maxPkrPerTrade) {
      throw new AppError('FORBIDDEN', `Your merchant tier allows max PKR ${maxPkrPerTrade} per trade`, 403)
    }
  }
  if (data.minOrderTokens !== undefined && data.maxOrderTokens !== undefined && data.maxOrderTokens < data.minOrderTokens) {
    throw new AppError('VALIDATION_ERROR', 'Maximum tokens must be greater than or equal to minimum', 400)
  }

  if (data.pricePerUnit) {
    const activeTrades = await db.ctmTrade.count({
      where: { listingId, status: { in: ['awaiting_payment', 'payment_uploaded', 'payment_confirmed', 'seller_transferring', 'proof_submitted', 'buyer_confirming'] } },
    })
    if (activeTrades > 0) throw new AppError('CONFLICT', 'Cannot change price while there are active trades', 409)
  }

  return db.ctmListing.update({
    where: { id: listingId },
    data: {
      ...(data.pricePerUnit !== undefined ? { pricePerUnit: new Prisma.Decimal(data.pricePerUnit) } : {}),
      ...(data.minOrderTokens !== undefined ? { minOrderTokens: new Prisma.Decimal(data.minOrderTokens) } : {}),
      ...(data.maxOrderTokens !== undefined ? { maxOrderTokens: new Prisma.Decimal(data.maxOrderTokens) } : {}),
      ...(data.terms !== undefined ? { terms: data.terms } : {}),
      ...(data.paymentMethods !== undefined ? { paymentMethods: data.paymentMethods } : {}),
      ...(data.settlementNote !== undefined ? { settlementNote: data.settlementNote } : {}),
      ...(data.tradeWindowMins !== undefined ? { tradeWindowMins: data.tradeWindowMins } : {}),
    },
  })
}

export async function pauseListing(userId: string, listingId: string) {
  const listing = await db.ctmListing.findUnique({
    where: { id: listingId },
    include: { merchantProfile: { select: { userId: true } } },
  })
  if (!listing) throw new AppError('NOT_FOUND', 'Listing not found', 404)
  if (listing.merchantProfile.userId !== userId) throw new AppError('FORBIDDEN', 'Not your listing', 403)
  if (listing.status !== 'active') throw new AppError('CONFLICT', 'Listing is not active', 409)
  return db.ctmListing.update({ where: { id: listingId }, data: { status: 'paused' } })
}

export async function activateListing(userId: string, listingId: string) {
  const listing = await db.ctmListing.findUnique({
    where: { id: listingId },
    include: { merchantProfile: { select: { userId: true } } },
  })
  if (!listing) throw new AppError('NOT_FOUND', 'Listing not found', 404)
  if (listing.merchantProfile.userId !== userId) throw new AppError('FORBIDDEN', 'Not your listing', 403)
  if (listing.status !== 'paused') throw new AppError('CONFLICT', 'Listing is not paused', 409)
  return db.ctmListing.update({ where: { id: listingId }, data: { status: 'active' } })
}

export async function deleteListing(userId: string, listingId: string) {
  const listing = await db.ctmListing.findUnique({
    where: { id: listingId },
    include: { merchantProfile: { select: { userId: true } } },
  })
  if (!listing) throw new AppError('NOT_FOUND', 'Listing not found', 404)
  if (listing.merchantProfile.userId !== userId) throw new AppError('FORBIDDEN', 'Not your listing', 403)

  const activeTrades = await db.ctmTrade.count({
    where: { listingId, status: { in: ['awaiting_payment', 'payment_uploaded', 'payment_confirmed', 'seller_transferring', 'proof_submitted', 'buyer_confirming'] } },
  })
  if (activeTrades > 0) throw new AppError('CONFLICT', 'Cannot delete listing with active trades', 409)

  return db.ctmListing.update({ where: { id: listingId }, data: { status: 'cancelled' } })
}

export async function incrementLockedAmount(listingId: string, amount: Prisma.Decimal, tx: Tx) {
  await tx.ctmListing.update({
    where: { id: listingId },
    data: {
      availableAmount: { decrement: amount },
      lockedAmount: { increment: amount },
    },
  })
}

export async function decrementLockedAmount(listingId: string, amount: Prisma.Decimal, tx: Tx) {
  await tx.ctmListing.update({
    where: { id: listingId },
    data: {
      availableAmount: { increment: amount },
      lockedAmount: { decrement: amount },
    },
  })
}

const ACTIVE_TRADE_STATUSES: CtmTradeStatus[] = [
  'awaiting_payment', 'payment_uploaded', 'payment_confirmed',
  'seller_transferring', 'proof_submitted', 'buyer_confirming',
]

export async function getListingActivity(listingId: string, requestingUserId?: string) {
  const listing = await db.ctmListing.findUnique({
    where: { id: listingId },
    include: { merchantProfile: { select: { userId: true } } },
  })
  if (!listing) throw new AppError('NOT_FOUND', 'Listing not found', 404)

  const isOwner = !!requestingUserId && requestingUserId === listing.merchantProfile.userId

  const [bidAgg, activeTradeCount, completedTradeCount, lastTrade] = await Promise.all([
    db.ctmListingBid.aggregate({
      where: { listingId, status: 'pending' },
      _count: { id: true },
      _min:   { pricePerUnit: true },
      _max:   { pricePerUnit: true },
    }),
    db.ctmTrade.count({ where: { listingId, status: { in: ACTIVE_TRADE_STATUSES } } }),
    db.ctmTrade.count({ where: { listingId, status: 'completed' } }),
    db.ctmTrade.findFirst({
      where: { listingId, status: 'completed' },
      orderBy: { completedAt: 'desc' },
      select: { pricePerUnit: true, completedAt: true },
    }),
  ])

  const base = {
    bids: {
      pendingCount: bidAgg._count.id ?? 0,
      minPrice:     bidAgg._min.pricePerUnit?.toString() ?? null,
      maxPrice:     bidAgg._max.pricePerUnit?.toString() ?? null,
    },
    trades: {
      activeCount:    activeTradeCount,
      completedCount: completedTradeCount,
      lastTradePrice: lastTrade?.pricePerUnit?.toString() ?? null,
      lastTradeAt:    lastTrade?.completedAt ?? null,
    },
  }

  if (!isOwner) {
    let myBid = null
    if (requestingUserId) {
      myBid = await db.ctmListingBid.findFirst({
        where: { listingId, bidderId: requestingUserId, status: { in: ['pending', 'accepted_pending_buyer'] } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, status: true, expiresAt: true, pricePerUnit: true, tokenAmount: true, fiatAmount: true },
      })
    }
    return { ...base, myBid: myBid ?? null }
  }

  const [bidItems, tradeItems] = await Promise.all([
    db.ctmListingBid.findMany({
      where: { listingId, status: { in: ['pending', 'accepted_pending_buyer'] } },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: {
        id: true, pricePerUnit: true, tokenAmount: true, fiatAmount: true,
        message: true, status: true, expiresAt: true, createdAt: true,
        bidder: { select: { id: true, username: true } },
        trade:  { select: { tradeRef: true, status: true } },
      },
    }),
    db.ctmTrade.findMany({
      where: { listingId },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: {
        tradeRef: true, status: true, tokenAmount: true,
        pricePerUnit: true, fiatAmount: true,
        createdAt: true, completedAt: true,
        buyer:  { select: { username: true } },
        seller: { select: { username: true } },
      },
    }),
  ])

  return {
    ...base,
    bids:   { ...base.bids,   items: bidItems },
    trades: { ...base.trades, items: tradeItems },
  }
}
