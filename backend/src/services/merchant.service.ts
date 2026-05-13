import { db } from '../lib/prisma'
import { AppError, Errors } from '../lib/errors'

// ─── getMerchantProfile ───────────────────────────────────────────────────────

export async function getMerchantProfile(userId: string) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      username: true,
      fullName: true,
      email: true,
      role: true,
      kycStatus: true,
      kycLevel: true,
      createdAt: true,
      merchant: {
        include: {
          inventory: true,
        },
      },
      tradeStats: true,
    },
  })
  if (!user) throw Errors.NOT_FOUND('User')
  return user
}

// ─── applyMerchant ────────────────────────────────────────────────────────────

export async function applyMerchant(
  userId: string,
  data: { businessName: string; description: string; proofUrl: string },
) {
  // Check KYC is approved
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { kycStatus: true, kycLevel: true },
  })
  if (!user) throw Errors.NOT_FOUND('User')
  if (user.kycStatus !== 'approved') {
    throw new AppError('KYC_REQUIRED', 'KYC must be approved before applying as a merchant', 400)
  }

  // Check if submission already exists
  const existing = await db.merchantKycSubmission.findFirst({
    where: { userId, status: 'pending' },
  })
  if (existing) {
    throw Errors.CONFLICT('A pending merchant application already exists')
  }

  // MerchantKycSubmission requires several fields — use sensible defaults for optional ones
  const submission = await db.merchantKycSubmission.create({
    data: {
      userId,
      businessName: data.businessName,
      businessDescription: data.description,
      contactPhone: '',
      businessProofType: 'bank_statement',
      cnicFrontUrl: '',
      cnicBackUrl: '',
      selfieUrl: '',
      businessProofUrl: data.proofUrl,
      status: 'pending',
    },
  })
  return submission
}

// ─── activateMerchant ─────────────────────────────────────────────────────────

export async function activateMerchant(userId: string) {
  // Find USDT wallet
  const wallet = await db.wallet.findFirst({
    where: { userId, coin: 'USDT' },
  })
  if (!wallet) {
    throw new AppError('WALLET_NOT_FOUND', 'USDT wallet not found', 400)
  }
  if (Number(wallet.balance) < 100) {
    throw new AppError('INSUFFICIENT_BALANCE', 'You need at least 100 USDT to activate merchant account', 400)
  }

  const result = await db.$transaction(async (tx: any) => {
    // Lock 100 USDT as collateral
    await tx.wallet.update({
      where: { id: wallet.id },
      data: {
        balance: { decrement: 100 },
        lockedBalance: { increment: 100 },
      },
    })

    // Create collateral lock record
    const collateral = await tx.collateralLock.create({
      data: {
        userId,
        coin: 'USDT',
        amount: 100,
        status: 'locked',
      },
    })

    // Upsert merchant record
    const merchant = await tx.merchant.upsert({
      where: { userId },
      create: {
        userId,
        businessName: '',
        status: 'approved',
        approvedAt: new Date(),
      },
      update: {
        status: 'approved',
        approvedAt: new Date(),
      },
    })

    // Update user role
    const user = await tx.user.update({
      where: { id: userId },
      data: { role: 'merchant' },
      select: { id: true, role: true, email: true, username: true },
    })

    return { user, merchant, collateral }
  })

  return result
}

// ─── updateSpread ─────────────────────────────────────────────────────────────

export async function updateSpread(userId: string, spreadBps: number) {
  // Get platform config for max spread
  const config = await db.platformConfig.findUnique({
    where: { key: 'merchant_max_spread_bps' },
  })
  const maxSpread = config ? parseInt(config.value, 10) : 500

  if (spreadBps > maxSpread) {
    throw new AppError(
      'SPREAD_TOO_HIGH',
      `Spread cannot exceed ${maxSpread} bps (${maxSpread / 100}%)`,
      400,
    )
  }
  if (spreadBps < 0) {
    throw new AppError('INVALID_SPREAD', 'Spread cannot be negative', 400)
  }

  const merchant = await db.merchant.findUnique({ where: { userId } })
  if (!merchant) throw Errors.NOT_FOUND('Merchant profile')

  const updated = await db.merchant.update({
    where: { userId },
    data: { spreadBps },
  })
  return updated
}

// ─── getMerchantInventory ─────────────────────────────────────────────────────

export async function getMerchantInventory(userId: string) {
  const merchant = await db.merchant.findUnique({ where: { userId } })
  if (!merchant) throw Errors.NOT_FOUND('Merchant profile')

  const inventory = await db.merchantInventory.findMany({
    where: { merchantId: merchant.id },
    orderBy: { updatedAt: 'desc' },
  })
  return inventory
}

// ─── addInventoryItem ─────────────────────────────────────────────────────────

export async function addInventoryItem(
  userId: string,
  data: {
    coin: string
    network: string
    availableAmount: number
    pricePerUnit: number
  },
) {
  const merchant = await db.merchant.findUnique({ where: { userId } })
  if (!merchant) throw Errors.NOT_FOUND('Merchant profile')
  if (merchant.status !== 'approved') {
    throw new AppError('MERCHANT_NOT_APPROVED', 'Merchant account is not approved', 403)
  }

  const item = await db.merchantInventory.create({
    data: {
      merchantId: merchant.id,
      coin: data.coin,
      network: data.network,
      availableAmount: data.availableAmount,
      pricePerUnit: data.pricePerUnit,
    },
  })
  return item
}

// ─── getMerchantStats ─────────────────────────────────────────────────────────

export async function getMerchantStats(userId: string) {
  const tradeStats = await db.tradeStats.findUnique({
    where: { userId },
  })

  const avgRating = await db.tradeRating.aggregate({
    where: { ratedUserId: userId },
    _avg: { rating: true },
    _count: { rating: true },
  })

  return {
    totalTrades: tradeStats?.totalTrades ?? 0,
    completedTrades: tradeStats?.completedTrades ?? 0,
    cancelledTrades: tradeStats?.cancelledTrades ?? 0,
    completionRate: tradeStats?.completionRate ?? 0,
    totalVolumePKR: tradeStats?.totalVolumePKR ?? 0,
    avgRating: avgRating._avg.rating ?? 0,
    totalReviews: avgRating._count.rating ?? 0,
    badge: tradeStats?.badge ?? 'new',
    trustScore: tradeStats?.trustScore ?? 0,
  }
}

// ─── getMerchantDashboard ─────────────────────────────────────────────────────

export async function getMerchantDashboard(userId: string) {
  const [profile, inventory, stats, recentTrades] = await Promise.all([
    getMerchantProfile(userId),
    getMerchantInventory(userId),
    getMerchantStats(userId),
    db.trade.findMany({
      where: {
        OR: [{ buyerId: userId }, { sellerId: userId }],
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        orderRef: true,
        coin: true,
        amount: true,
        fiatAmount: true,
        status: true,
        createdAt: true,
        buyer: { select: { username: true } },
        seller: { select: { username: true } },
      },
    }),
  ])
  return { profile, inventory, stats, recentTrades }
}

// ─── getPublicMerchant ────────────────────────────────────────────────────────

export async function getPublicMerchant(merchantId: string) {
  const merchant = await db.merchant.findUnique({
    where: { id: merchantId },
    include: {
      user: {
        select: {
          id: true,
          username: true,
          createdAt: true,
          tradeStats: {
            select: {
              totalTrades: true,
              completedTrades: true,
              completionRate: true,
              avgRating: true,
              totalReviews: true,
              badge: true,
              totalVolumePKR: true,
            },
          },
        },
      },
      inventory: true,
    },
  })
  if (!merchant) throw Errors.NOT_FOUND('Merchant')

  return {
    id: merchant.id,
    businessName: merchant.businessName,
    status: merchant.status,
    rank: merchant.rank,
    spreadBps: merchant.spreadBps,
    approvedAt: merchant.approvedAt,
    createdAt: merchant.createdAt,
    user: merchant.user,
    inventory: merchant.inventory,
  }
}
