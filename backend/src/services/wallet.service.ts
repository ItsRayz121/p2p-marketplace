import { db } from '../lib/prisma'
import { Prisma } from '@prisma/client'
import { redis } from '../lib/redis'
import { AppError } from '../lib/errors'
import { generateOrderRef } from '../lib/hash'
import { getChainByNetworkLabel, isEvmNetwork } from './chainRegistry.service'
import { getOrCreateEvmDepositAddress } from './depositAddress.service'
import { recordAuditLog } from '../lib/audit'
import { assessWithdrawalRisk, getWithdrawalTierConfig } from './withdrawal-risk.service'
import { sendWithdrawalEmail, sendWithdrawalConfirmationEmail } from './email.service'
import { env } from '../lib/env'
import { sendWithdrawalOnChain } from '../lib/withdrawal.sender'
import {
  assertWithdrawalNotLocked,
  storeConfirmationTokens,
  consumeConfirmToken,
  consumeCancelToken,
  incrementResendCount,
  MAX_RESENDS,
  cancelExpiredConfirmations,
} from './withdrawal-security.service'

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
  if (await isEvmNetwork(network)) {
    const chain = await getChainByNetworkLabel(network)
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
  // The key MUST be lowercased: admin saves under `deposit_address_<coin>_<network>`
  // lowercased (admin.routes.ts), and instant-buy + webhooks read it lowercased too.
  // The deposit route uppercases the path params, so without this lowercase the
  // lookup for e.g. Aptos became `deposit_address_USDT_APTOS` and never matched the
  // stored `deposit_address_usdt_aptos` — surfacing as "temporarily unavailable".
  const key = `deposit_address_${coin.toLowerCase()}_${network.toLowerCase()}`
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
  const net = network.toUpperCase()
  const [networkFeeRow, platformFeeRow, gasFeeRow, wdPlatformFeeRow] = await Promise.all([
    db.platformConfig.findUnique({ where: { key: `network_fee_${coin}_${network}` } }),
    db.platformConfig.findUnique({ where: { key: `platform_fee_${coin}` } }),
    db.platformConfig.findUnique({ where: { key: `withdrawal_gas_fee_${net}` } }),
    db.platformConfig.findUnique({ where: { key: `withdrawal_platform_fee_${net}` } }),
  ])
  // New per-network withdrawal fee keys take precedence; fall back to legacy keys
  const gasFee = gasFeeRow?.value ?? networkFeeRow?.value ?? '0'
  const platformFee = wdPlatformFeeRow?.value ?? platformFeeRow?.value ?? '0'
  return {
    networkFee: gasFee,   // backward-compat alias
    platformFee,
    gasFee,
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
  // Phase 1: hard-block if account is under a security lock
  await assertWithdrawalNotLocked(userId)

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

  // Load tier config — needed for email confirmation setting + address activation check
  const cfg = await getWithdrawalTierConfig(db)

  // Phase 3 pre-flight: block withdrawals to addresses pending activation.
  // This runs before creating email_pending so the user gets an immediate error
  // rather than a confirmation email that will always fail.
  const pendingActivation = await db.trustedWithdrawalAddress.findFirst({
    where: {
      userId,
      address: data.toAddress,
      removedAt: null,
      activatesAt: { gt: new Date() },
    },
  })
  if (pendingActivation) {
    throw new AppError(
      'ADDRESS_PENDING_ACTIVATION',
      `This address is in its ${cfg.addressActivationHours}h activation period. It will be ready to use at ${pendingActivation.activatesAt.toISOString()}.`,
      403,
    )
  }

  // Read withdrawal fees from PlatformConfig (new per-network keys take precedence over legacy)
  const net = data.network.toUpperCase()
  const [gasFeeConfig, platformFeeConfig, legacyFeeConfig] = await Promise.all([
    db.platformConfig.findUnique({ where: { key: `withdrawal_gas_fee_${net}` } }),
    db.platformConfig.findUnique({ where: { key: `withdrawal_platform_fee_${net}` } }),
    db.platformConfig.findUnique({ where: { key: `network_fee_${data.coin}_${data.network}` } }),
  ])
  const gasFee = parseFloat(gasFeeConfig?.value ?? legacyFeeConfig?.value ?? '0')
  const platformFee = parseFloat(platformFeeConfig?.value ?? '0')
  const fee = gasFee + platformFee

  // Determine USD value to decide whether to skip email confirmation
  const coinPrice = cfg.coinPricesUsd[data.coin.toUpperCase()] ?? 0
  const amountUsd = coinPrice > 0 ? data.amount * coinPrice : 999999
  const isSmallAmount = coinPrice > 0 && amountUsd < cfg.tier1MaxUsd

  // Sub-$100: skip email confirmation and auto-approve immediately
  if (isSmallAmount) {
    const totalDeduct = data.amount + fee
    const result = await db.$transaction(async (tx) => {
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

      // Compare in Decimal space — never coerce money to IEEE-754 float.
      const available = new Prisma.Decimal(w.balance).sub(w.lockedBalance)
      if (available.lt(totalDeduct)) {
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
          status: 'auto_approved',
          tier: 1,
          riskScore: 0,
          riskFlags: [],
          amountUsd,
        },
      })

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
            tier: 1,
          } as any,
        },
      })

      return withdrawal
    })

    await redis.set(idempKey, JSON.stringify(result), 'EX', 86400)
    void recordAuditLog(userId, 'WITHDRAWAL_AUTO_APPROVED', 'Withdrawal', result.id, {
      coin: data.coin,
      network: data.network,
      amount: data.amount,
      fee,
      toAddress: data.toAddress,
      orderRef: result.orderRef,
      amountUsd,
    })
    // Fire-and-forget: broadcast the on-chain transaction from the hot wallet.
    // On failure the withdrawal stays auto_approved and an admin alert is sent.
    void sendWithdrawalOnChain({
      id: result.id,
      userId,
      coin: data.coin,
      network: data.network,
      amount: data.amount,
      fee,
      toAddress: data.toAddress,
    })
    return result
  }

  // $100+: email confirmation required before admin review
  if (cfg.emailConfirmationEnabled) {
    const orderRef = generateOrderRef('WDR')
    const withdrawal = await db.withdrawal.create({
      data: {
        orderRef,
        userId,
        coin: data.coin,
        network: data.network,
        amount: data.amount,
        fee,
        toAddress: data.toAddress,
        status: 'email_pending',
        // tier/riskScore/riskFlags will be populated on confirmation
        tier: 3,
        confirmationChannel: 'email',
        confirmationSentAt: new Date(),
      },
    })

    // Store confirmation tokens in Redis
    const ttlSecs = cfg.emailConfirmationTtlMins * 60
    const { confirmToken, cancelToken } = await storeConfirmationTokens(withdrawal.id, ttlSecs)

    // Cache idempotency result pointing to this email_pending withdrawal
    await redis.set(idempKey, JSON.stringify(withdrawal), 'EX', 86400)

    // Send confirmation email — fire-and-forget but log errors
    void db.user
      .findUnique({ where: { id: userId }, select: { email: true } })
      .then((u) => {
        if (!u?.email) return
        const confirmUrl = `${env.FRONTEND_URL}/confirm-withdrawal?wid=${withdrawal.id}&token=${confirmToken}`
        const cancelUrl = `${env.FRONTEND_URL}/confirm-withdrawal?wid=${withdrawal.id}&cancel=${cancelToken}`
        return sendWithdrawalConfirmationEmail(u.email, {
          amount: data.amount.toString(),
          coin: data.coin,
          network: data.network,
          toAddress: data.toAddress,
          confirmUrl,
          cancelUrl,
          expiresInMins: cfg.emailConfirmationTtlMins,
          userId,
        })
      })
      .catch(() => {})

    void recordAuditLog(userId, 'WITHDRAWAL_CONFIRMATION_SENT', 'Withdrawal', withdrawal.id, {
      coin: data.coin,
      network: data.network,
      amount: data.amount,
      fee,
      toAddress: data.toAddress,
      orderRef,
      ttlMins: cfg.emailConfirmationTtlMins,
    })

    return withdrawal
  }

  // ── Legacy path (emailConfirmationEnabled = false) ──────────────────────────
  // Risk assessment (runs outside transaction — read-only queries)
  const risk = await assessWithdrawalRisk(userId, data.amount, data.coin, data.toAddress, db, cfg)
  const initialStatus = deriveInitialStatus(risk)
  const totalDeduct = data.amount + fee

  const result = await db.$transaction(async (tx) => {
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

    // Compare in Decimal space — never coerce money to IEEE-754 float.
    const available = new Prisma.Decimal(w.balance).sub(w.lockedBalance)
    if (available.lt(totalDeduct)) {
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
        status: initialStatus,
        tier: risk.tier,
        riskScore: risk.riskScore,
        riskFlags: risk.riskFlags,
        ...(risk.amountUsd > 0 ? { amountUsd: risk.amountUsd } : {}),
      },
    })

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
          tier: risk.tier,
        } as any,
      },
    })

    return withdrawal
  })

  await redis.set(idempKey, JSON.stringify(result), 'EX', 86400)

  void recordAuditLog(userId, 'WITHDRAWAL_REQUESTED', 'Withdrawal', result.id, {
    coin: data.coin,
    network: data.network,
    amount: data.amount,
    fee,
    toAddress: data.toAddress,
    orderRef: result.orderRef,
    tier: risk.tier,
    riskScore: risk.riskScore,
    riskFlags: risk.riskFlags,
    initialStatus,
  })

  void db.user
    .findUnique({ where: { id: userId }, select: { email: true } })
    .then((u) => {
      if (!u?.email) return
      return sendWithdrawalEmail('requested', u.email, {
        amount: data.amount.toString(),
        coin: data.coin,
      })
    })
    .catch(() => {})

  return result
}

// ─── Confirm a withdrawal (Phase 2) ───────────────────────────────────────────

export async function confirmWithdrawal(
  withdrawalId: string,
  userId: string,
  rawToken: string,
) {
  // Verify and consume the token (replay-safe)
  const valid = await consumeConfirmToken(withdrawalId, rawToken)
  if (!valid) {
    throw new AppError('INVALID_TOKEN', 'Confirmation link is invalid or has expired', 400)
  }

  // Reload withdrawal — must still be email_pending and belong to this user
  const wd = await db.withdrawal.findUnique({ where: { id: withdrawalId } })
  if (!wd) throw new AppError('NOT_FOUND', 'Withdrawal not found', 404)
  if (wd.userId !== userId) throw new AppError('FORBIDDEN', 'Forbidden', 403)
  if (wd.status !== 'email_pending') {
    throw new AppError(
      'INVALID_STATUS',
      `Withdrawal cannot be confirmed (current status: ${wd.status})`,
      409,
    )
  }

  // Run risk assessment now that the user has confirmed intent
  const risk = await assessWithdrawalRisk(
    userId,
    parseFloat(wd.amount.toString()),
    wd.coin,
    wd.toAddress,
    db,
  )
  const initialStatus = deriveInitialStatus(risk)
  const fee = parseFloat(wd.fee.toString())
  const amount = parseFloat(wd.amount.toString())
  const totalDeduct = amount + fee

  const updated = await db.$transaction(async (tx) => {
    // SELECT FOR UPDATE — deduct balance atomically
    const wallets = await tx.$queryRaw<
      Array<{ id: string; balance: string; lockedBalance: string }>
    >`
      SELECT id, balance, "lockedBalance"
      FROM "Wallet"
      WHERE "userId" = ${userId} AND coin = ${wd.coin} AND network = ${wd.network}
      FOR UPDATE
    `
    const w = wallets[0]
    if (!w) throw new AppError('NOT_FOUND', 'Wallet not found', 404)

    // Compare in Decimal space — never coerce money to IEEE-754 float.
    const available = new Prisma.Decimal(w.balance).sub(w.lockedBalance)
    if (available.lt(totalDeduct)) {
      throw new AppError('INSUFFICIENT_BALANCE', 'Insufficient balance', 400)
    }

    await tx.wallet.update({
      where: { id: w.id },
      data: { balance: { decrement: totalDeduct } },
    })

    // Optimistic lock: only flip if still email_pending.
    // Guards against an admin cancelling the withdrawal between the status
    // check above and this update.
    const flipped = await tx.withdrawal.updateMany({
      where: { id: withdrawalId, status: 'email_pending' },
      data: {
        status: initialStatus,
        tier: risk.tier,
        riskScore: risk.riskScore,
        riskFlags: risk.riskFlags,
        ...(risk.amountUsd > 0 ? { amountUsd: risk.amountUsd } : {}),
      },
    })
    if (flipped.count === 0) {
      // Withdrawal was cancelled or already confirmed by another request
      throw new AppError('CONFLICT', 'Withdrawal is no longer pending confirmation', 409)
    }
    const withdrawal = await tx.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } })

    // Pending transaction row so user sees it immediately in history
    await tx.transaction.create({
      data: {
        walletId: w.id,
        type: 'withdrawal',
        amount,
        fee,
        status: 'pending',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        metadata: {
          withdrawalId: withdrawal.id,
          orderRef: wd.orderRef,
          toAddress: wd.toAddress,
          network: wd.network,
          coin: wd.coin,
          tier: risk.tier,
        } as any,
      },
    })

    return withdrawal
  })

  void recordAuditLog(userId, 'WITHDRAWAL_CONFIRMED', 'Withdrawal', withdrawalId, {
    coin: wd.coin,
    network: wd.network,
    amount,
    fee,
    toAddress: wd.toAddress,
    orderRef: wd.orderRef,
    tier: risk.tier,
    riskScore: risk.riskScore,
    riskFlags: risk.riskFlags,
    initialStatus,
  })

  // Update lastUsedAt on the trusted address if it exists
  void db.trustedWithdrawalAddress
    .updateMany({
      where: { userId, address: wd.toAddress, removedAt: null },
      data: { lastUsedAt: new Date() },
    })
    .catch(() => {})

  // Notify user — fire-and-forget
  void db.user
    .findUnique({ where: { id: userId }, select: { email: true } })
    .then((u) => {
      if (!u?.email) return
      return sendWithdrawalEmail('requested', u.email, {
        amount: amount.toString(),
        coin: wd.coin,
      })
    })
    .catch(() => {})

  return updated
}

// ─── Cancel a withdrawal via email cancel link ────────────────────────────────

export async function cancelWithdrawalByToken(
  withdrawalId: string,
  userId: string,
  rawCancelToken: string,
) {
  const valid = await consumeCancelToken(withdrawalId, rawCancelToken)
  if (!valid) {
    throw new AppError('INVALID_TOKEN', 'Cancel link is invalid or has expired', 400)
  }

  const wd = await db.withdrawal.findUnique({ where: { id: withdrawalId } })
  if (!wd) throw new AppError('NOT_FOUND', 'Withdrawal not found', 404)
  if (wd.userId !== userId) throw new AppError('FORBIDDEN', 'Forbidden', 403)
  if (wd.status !== 'email_pending') {
    // Already cancelled or confirmed — idempotent, just return
    return wd
  }

  const updated = await db.withdrawal.update({
    where: { id: withdrawalId },
    data: { status: 'cancelled' },
  })

  void recordAuditLog(userId, 'WITHDRAWAL_CANCELLED_BY_USER', 'Withdrawal', withdrawalId, {
    orderRef: wd.orderRef,
    reason: 'user_cancelled_via_email_link',
  })

  return updated
}

// ─── Resend confirmation email ────────────────────────────────────────────────

export async function resendWithdrawalConfirmation(withdrawalId: string, userId: string) {
  const wd = await db.withdrawal.findUnique({ where: { id: withdrawalId } })
  if (!wd) throw new AppError('NOT_FOUND', 'Withdrawal not found', 404)
  if (wd.userId !== userId) throw new AppError('FORBIDDEN', 'Forbidden', 403)
  if (wd.status !== 'email_pending') {
    throw new AppError(
      'INVALID_STATUS',
      `Cannot resend confirmation for withdrawal in status: ${wd.status}`,
      400,
    )
  }

  const count = await incrementResendCount(withdrawalId)
  if (count > MAX_RESENDS) {
    throw new AppError(
      'RESEND_LIMIT',
      `Maximum ${MAX_RESENDS} resend attempts reached. Please wait and try again.`,
      429,
    )
  }

  const cfg = await getWithdrawalTierConfig(db)
  const ttlSecs = cfg.emailConfirmationTtlMins * 60

  // Rotate tokens — old links are invalidated
  const { confirmToken, cancelToken } = await storeConfirmationTokens(withdrawalId, ttlSecs)

  await db.withdrawal.update({
    where: { id: withdrawalId },
    data: { confirmationSentAt: new Date() },
  })

  void db.user
    .findUnique({ where: { id: userId }, select: { email: true } })
    .then((u) => {
      if (!u?.email) return
      const confirmUrl = `${env.FRONTEND_URL}/confirm-withdrawal?wid=${withdrawalId}&token=${confirmToken}`
      const cancelUrl = `${env.FRONTEND_URL}/confirm-withdrawal?wid=${withdrawalId}&cancel=${cancelToken}`
      return sendWithdrawalConfirmationEmail(u.email, {
        amount: wd.amount.toString(),
        coin: wd.coin,
        network: wd.network,
        toAddress: wd.toAddress,
        confirmUrl,
        cancelUrl,
        expiresInMins: cfg.emailConfirmationTtlMins,
        userId,
      })
    })
    .catch(() => {})

  return { resendCount: count, maxResends: MAX_RESENDS }
}

function deriveInitialStatus(
  risk: import('./withdrawal-risk.service').RiskAssessment,
): import('@prisma/client').WithdrawalStatus {
  if (risk.requiresHold) return 'on_hold'
  // Tier 1 with no flags and auto-approve enabled → skip admin queue entirely
  if (risk.tier === 1) return 'auto_approved'
  return 'pending'
}

export async function getUserWithdrawals(userId: string, params: { page: number; limit: number }) {
  // Lazily cancel email_pending withdrawals whose confirmation window expired
  const cfg = await getWithdrawalTierConfig(db)
  await cancelExpiredConfirmations(userId, cfg.emailConfirmationTtlMins)

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

// ─── Trusted Withdrawal Addresses (Phase 3) ───────────────────────────────────

export async function getTrustedAddresses(userId: string) {
  return db.trustedWithdrawalAddress.findMany({
    where: { userId, removedAt: null },
    orderBy: { addedAt: 'desc' },
  })
}

export async function addTrustedAddress(
  userId: string,
  data: { coin: string; network: string; address: string; label: string },
) {
  const cfg = await getWithdrawalTierConfig(db)
  const activatesAt = new Date(Date.now() + cfg.addressActivationHours * 60 * 60 * 1000)

  // Normalize coin and network to uppercase so the unique constraint is consistent
  const coin = data.coin.toUpperCase()
  const network = data.network.toUpperCase()
  const normalized = { ...data, coin, network }

  // Upsert: if the address was previously soft-deleted, restore it with a new activation period
  const existing = await db.trustedWithdrawalAddress.findFirst({
    where: { userId, coin, network, address: data.address },
  })

  if (existing) {
    if (!existing.removedAt) {
      throw new AppError('CONFLICT', 'This address is already in your trusted list', 409)
    }
    const restored = await db.trustedWithdrawalAddress.update({
      where: { id: existing.id },
      data: {
        label: normalized.label,
        activatesAt,
        addedAt: new Date(),
        removedAt: null,
        lastUsedAt: null,
      },
    })
    void recordAuditLog(userId, 'TRUSTED_ADDRESS_RESTORED', 'TrustedWithdrawalAddress', restored.id, {
      coin,
      network,
      address: data.address,
      label: normalized.label,
      activatesAt: activatesAt.toISOString(),
    })
    return restored
  }

  const trusted = await db.trustedWithdrawalAddress.create({
    data: {
      userId,
      coin,
      network,
      address: data.address,
      label: normalized.label,
      activatesAt,
    },
  })

  void recordAuditLog(userId, 'TRUSTED_ADDRESS_ADDED', 'TrustedWithdrawalAddress', trusted.id, {
    coin,
    network,
    address: data.address,
    label: normalized.label,
    activatesAt: activatesAt.toISOString(),
    activationHours: cfg.addressActivationHours,
  })

  return trusted
}

export async function removeTrustedAddress(userId: string, id: string) {
  const addr = await db.trustedWithdrawalAddress.findFirst({
    where: { id, userId, removedAt: null },
  })
  if (!addr) throw new AppError('NOT_FOUND', 'Trusted address not found', 404)

  const updated = await db.trustedWithdrawalAddress.update({
    where: { id },
    data: { removedAt: new Date() },
  })

  void recordAuditLog(userId, 'TRUSTED_ADDRESS_REMOVED', 'TrustedWithdrawalAddress', id, {
    coin: addr.coin,
    network: addr.network,
    address: addr.address,
  })

  return updated
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

    const available = new Prisma.Decimal(w.balance).sub(w.lockedBalance)
    if (available.lt(data.amount)) {
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
