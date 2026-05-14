import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { AppError } from '../lib/errors'
import { generateOrderRef } from '../lib/hash'
import { getChainByNetworkLabel, isEvmNetwork } from '../lib/chains'
import { getOrCreateEvmDepositAddress } from './depositAddress.service'
import { recordAuditLog } from '../lib/audit'

// ─── Wallet ───────────────────────────────────────────────────────────────────

export async function getUserWallets(userId: string) {
  return db.wallet.findMany({ where: { userId } })
}

/**
 * Resolve a deposit address for {userId, coin, network}:
 *   - EVM networks (ERC20/BEP20/POLYGON/ARBITRUM/OPTIMISM/BASE): HD-derived
 *     per-user address (same address shared across all EVM chains).
 *   - Non-EVM networks (TRC20 today, TON/SUI later): legacy shared address
 *     stored in PlatformConfig under `deposit_address_<COIN>_<NETWORK>`.
 *
 * On any misconfiguration we return 503 ("temporarily unavailable") instead of
 * 404 ("not configured") so the UI never reads as a hard "we don't support
 * this" state.
 */
export async function getDepositAddress(userId: string, coin: string, network: string) {
  if (isEvmNetwork(network)) {
    const chain = getChainByNetworkLabel(network)
    if (!chain) {
      throw new AppError('UNSUPPORTED_NETWORK', `Network ${network} is not supported`, 400)
    }
    // Validate that the coin is supported on this chain (or is the chain's native asset).
    const isNative = coin.toUpperCase() === chain.nativeSymbol
    const tokenOk = chain.tokens.some((t) => t.symbol === coin.toUpperCase())
    if (!isNative && !tokenOk) {
      throw new AppError(
        'UNSUPPORTED_ASSET',
        `${coin} is not supported on ${chain.name}`,
        400,
      )
    }
    const { address } = await getOrCreateEvmDepositAddress(userId)
    return {
      address,
      coin,
      network,
      chainId: chain.chainId,
      chainName: chain.name,
      minConfirmations: chain.minConfirmations,
      family: 'EVM',
    }
  }

  // Non-EVM fallback — shared platform address.
  const key = `deposit_address_${coin}_${network}`
  const config = await db.platformConfig.findUnique({ where: { key } })
  if (!config || !config.value) {
    throw new AppError(
      'DEPOSIT_UNAVAILABLE',
      'Deposit address temporarily unavailable — please retry shortly',
      503,
    )
  }
  return { address: config.value, coin, network, family: 'NON_EVM' as const }
}

// ─── Fees ─────────────────────────────────────────────────────────────────────

export async function getLiveFee(coin: string, network: string) {
  const [networkFeeRow, platformFeeRow] = await Promise.all([
    db.platformConfig.findUnique({ where: { key: `network_fee_${coin}_${network}` } }),
    db.platformConfig.findUnique({ where: { key: `platform_fee_${coin}` } }),
  ])
  return {
    networkFee: networkFeeRow?.value ?? '0',
    platformFee: platformFeeRow?.value ?? '0',
    coin,
    network,
  }
}

export async function getFeeSchedule() {
  const configs = await db.platformConfig.findMany({
    where: {
      OR: [
        { key: { startsWith: 'network_fee_' } },
        { key: { startsWith: 'platform_fee_' } },
      ],
    },
    select: { key: true, value: true },
  })
  return configs
}

// ─── Withdrawals ──────────────────────────────────────────────────────────────

export async function requestWithdrawal(
  userId: string,
  data: {
    coin: string
    network: string
    amount: number
    toAddress: string
    idempotencyKey: string
  },
) {
  // Idempotency check in Redis (24h TTL)
  const idempKey = `idempotency:withdrawal:${data.idempotencyKey}`
  const existing = await redis.get(idempKey)
  if (existing) {
    try {
      return JSON.parse(existing)
    } catch {
      // fall through to create
    }
  }

  // Read network fee from PlatformConfig
  const feeConfig = await db.platformConfig.findUnique({
    where: { key: `network_fee_${data.coin}_${data.network}` },
  })
  const fee = parseFloat(feeConfig?.value ?? '0')
  const totalDeduct = data.amount + fee

  const result = await db.$transaction(async (tx) => {
    // SELECT FOR UPDATE on wallet
    const wallets = await tx.$queryRaw<
      Array<{ id: string; balance: string; lockedBalance: string }>
    >`
      SELECT id, balance, "lockedBalance"
      FROM "Wallet"
      WHERE "userId" = ${userId} AND coin = ${data.coin} AND network = ${data.network}
      FOR UPDATE
    `
    const w = wallets[0]
    if (!w) throw new AppError('NOT_FOUND', 'Wallet not found', 404)

    const available = parseFloat(w.balance) - parseFloat(w.lockedBalance)
    if (available < totalDeduct) {
      throw new AppError('INSUFFICIENT_BALANCE', 'Insufficient balance', 400)
    }

    await tx.wallet.update({
      where: { id: w.id },
      data: { balance: { decrement: totalDeduct } },
    })

    const orderRef = generateOrderRef('WDR')
    const withdrawal = await tx.withdrawal.create({
      data: {
        orderRef,
        userId,
        coin: data.coin,
        network: data.network,
        amount: data.amount,
        fee,
        toAddress: data.toAddress,
        status: 'pending',
      },
    })

    // Create a Transaction row so the user sees the withdrawal immediately
    // in their transaction history (GET /wallet/transactions). Status starts
    // as 'pending' and is never updated here — admin approval/rejection
    // creates a second row or updates this one via the admin routes.
    await tx.transaction.create({
      data: {
        walletId: w.id,
        type: 'withdrawal',
        amount: data.amount,
        fee,
        status: 'pending',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        metadata: {
          withdrawalId: withdrawal.id,
          orderRef,
          toAddress: data.toAddress,
          network: data.network,
          coin: data.coin,
        } as any,
      },
    })

    return withdrawal
  })

  // Cache idempotency result for 24h
  await redis.set(idempKey, JSON.stringify(result), 'EX', 86400)

  // Audit-trail every withdrawal request. Admin two-person approval is logged
  // separately in admin.routes.ts.
  void recordAuditLog(userId, 'WITHDRAWAL_REQUESTED', 'Withdrawal', result.id, {
    coin: data.coin,
    network: data.network,
    amount: data.amount,
    fee,
    toAddress: data.toAddress,
    orderRef: result.orderRef,
  })

  return result
}

export async function getUserWithdrawals(userId: string, params: { page: number; limit: number }) {
  const skip = (params.page - 1) * params.limit
  const [items, total] = await Promise.all([
    db.withdrawal.findMany({
      where: { userId },
      skip,
      take: params.limit,
      orderBy: { createdAt: 'desc' },
    }),
    db.withdrawal.count({ where: { userId } }),
  ])
  return { items, total, page: params.page, limit: params.limit }
}

// ─── Collateral ───────────────────────────────────────────────────────────────

export async function lockCollateral(userId: string, data: { coin: string; amount: number }) {
  return db.$transaction(async (tx) => {
    const wallets = await tx.$queryRaw<
      Array<{ id: string; balance: string; lockedBalance: string }>
    >`
      SELECT id, balance, "lockedBalance"
      FROM "Wallet"
      WHERE "userId" = ${userId} AND coin = ${data.coin}
      FOR UPDATE
    `
    const w = wallets[0]
    if (!w) throw new AppError('NOT_FOUND', 'Wallet not found', 404)

    const available = parseFloat(w.balance) - parseFloat(w.lockedBalance)
    if (available < data.amount) {
      throw new AppError('INSUFFICIENT_BALANCE', 'Insufficient balance for collateral', 400)
    }

    await tx.wallet.update({
      where: { id: w.id },
      data: { lockedBalance: { increment: data.amount } },
    })

    const lock = await tx.collateralLock.create({
      data: {
        userId,
        coin: data.coin,
        amount: data.amount,
        status: 'locked',
        lockedAt: new Date(),
      },
    })
    return lock
  })
}

export async function unlockCollateral(userId: string, lockId: string) {
  // Block unlock if user has active sell trades
  const activeTrades = await db.trade.count({
    where: {
      sellerId: userId,
      status: {
        in: ['payment_pending', 'payment_uploaded', 'payment_confirmed', 'crypto_sent'],
      },
    },
  })
  if (activeTrades > 0) {
    throw new AppError('ACTIVE_TRADES', 'Cannot unlock collateral while you have active trades', 400)
  }

  return db.$transaction(async (tx) => {
    const lock = await tx.collateralLock.findFirst({
      where: { id: lockId, userId, status: 'locked' },
    })
    if (!lock) throw new AppError('NOT_FOUND', 'Active collateral lock not found', 404)

    await tx.wallet.updateMany({
      where: { userId, coin: lock.coin },
      data: { lockedBalance: { decrement: Number(lock.amount) } },
    })

    return tx.collateralLock.update({
      where: { id: lockId },
      data: { status: 'unlocked', unlockedAt: new Date() },
    })
  })
}

export async function getCollateralStatus(userId: string) {
  const activeTrades = await db.trade.count({
    where: {
      sellerId: userId,
      status: {
        in: ['payment_pending', 'payment_uploaded', 'payment_confirmed', 'crypto_sent'],
      },
    },
  })
  const lock = await db.collateralLock.findFirst({ where: { userId, status: 'locked' } })
  return {
    locked: !!lock,
    amount: lock ? Number(lock.amount) : 0,
    lockId: lock?.id ?? null,
    coin: lock?.coin ?? null,
    canUnlock: activeTrades === 0,
    activeTradesCount: activeTrades,
  }
}

// ─── Payment Methods ──────────────────────────────────────────────────────────

export async function getPaymentMethods(userId: string) {
  return db.paymentMethod.findMany({ where: { userId, isActive: true } })
}

export async function addPaymentMethod(
  userId: string,
  data: {
    type: string
    displayName: string
    accountName: string
    mobileNumber?: string
    bankName?: string
    ibanNumber?: string
    accountNumber?: string
  },
) {
  return db.paymentMethod.create({
    data: {
      userId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      type: data.type as any,
      displayName: data.displayName,
      accountName: data.accountName,
      mobileNumber: data.mobileNumber ?? null,
      bankName: data.bankName ?? null,
      ibanNumber: data.ibanNumber ?? null,
      accountNumber: data.accountNumber ?? null,
      isActive: true,
    },
  })
}

export async function deletePaymentMethod(userId: string, id: string) {
  const pm = await db.paymentMethod.findFirst({ where: { id, userId } })
  if (!pm) throw new AppError('NOT_FOUND', 'Payment method not found', 404)
  return db.paymentMethod.update({ where: { id }, data: { isActive: false } })
}

// ─── Saved Addresses ──────────────────────────────────────────────────────────

export async function getSavedAddresses(userId: string) {
  return db.savedAddress.findMany({ where: { userId } })
}

export async function addSavedAddress(
  userId: string,
  data: { coin: string; network: string; address: string; label: string },
) {
  return db.savedAddress.create({ data: { userId, ...data } })
}

export async function deleteSavedAddress(userId: string, id: string) {
  const addr = await db.savedAddress.findFirst({ where: { id, userId } })
  if (!addr) throw new AppError('NOT_FOUND', 'Address not found', 404)
  return db.savedAddress.delete({ where: { id } })
}
