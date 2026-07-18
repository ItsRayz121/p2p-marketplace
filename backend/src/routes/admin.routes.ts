import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { cloudinary, CLOUDINARY_FOLDERS, signCloudinaryDeliveryUrl, fetchCloudinaryAsset } from '../lib/cloudinary'
import { authenticate, requireRole, requireAdminStepUp } from '../middleware/auth.middleware'
import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { env } from '../lib/env'
import { AppError, Errors } from '../lib/errors'
import { sendKycEmail, sendWithdrawalEmail } from '../services/email.service'
import { queues } from '../queues/definitions'
import { logger as log } from '../lib/logger'
import { resolveBondOnDispute, releaseMakerBond } from '../services/makerBond.service'
import { clawbackTradePoints } from '../services/airdrop.service'
import { getStreamStatusSummary, ensureSubscriptionRows, enqueuePendingSubscriptions } from '../services/moralisStreams.service'
import { getPublicConfig } from '../services/marketplace.service'
import { runMediaRetention } from '../jobs/mediaRetention.job'
import { FLAGS, isFlagEnabled } from '../services/platformFlags.service'
import { isSyntheticEmail } from '../services/auth.service'
import { getChainById, getRpcUrl, getAllChains, invalidateCache } from '../services/chainRegistry.service'
import { processDepositEvent, creditDetectedDeposit } from '../services/depositWatcher.service'
import { getDepositAddressBalances, sweepDepositAddress } from '../services/depositSweep.service'
import { refreshDepositFromRpc } from '../services/depositReconcile.service'
import { getTransactionByHash, getTransactionReceipt, getBlockNumber } from '../lib/evmRpc'
import { Prisma } from '@prisma/client'
import { getWithdrawalTierConfig, upsertWithdrawalTierConfig } from '../services/withdrawal-risk.service'
import { getNativeUsdPrice, testRpcHealth, getHotWalletBalance } from '../lib/gas/gas.balance'
import { getAllTreasuryAddresses, getTreasuryBalance } from '../lib/gas/gas.treasury'
import { getLedgerEntries, getLedgerSummary, appendLedgerEntry, nativeSymbol } from '../lib/gas/gas.ledger'
import { getWalletTokenBalances } from '../lib/moralisClient'
import { getAllThresholds, getThreshold, upsertThreshold, setThresholdEnabled, validateThreshold } from '../lib/gas/gas.thresholds'
import { approveRefill, cancelRefill, checkAndQueueRefills, processApprovedRefills } from '../lib/gas/gas.refill'
import { getTronHotWalletAddress, getEvmHotWalletAddress, getTronTreasuryAddress, getEvmTreasuryAddress } from '../lib/gas/gasWalletService'
import type { GasChainId } from '../lib/gas/gas.chains'
import { listReconciliationRuns, getReconciliationRun, resolveDiscrepancy } from '../lib/gas/gas.reconciliation'
import { getChainBurnRates, getChainRunways, getProfitabilityByChain, getVolumeTimeSeries } from '../lib/gas/gas.analytics'
import { listFlaggedOrders, reviewFlaggedOrder } from '../lib/gas/gas.risk'
import { listMerchantAccounts, createMerchantAccount, updateMerchantAccount, getMerchantAccount, listMerchantSettlements, approveSettlement } from '../lib/gas/gas.merchant-settlement'
import { adminListAffiliates, adminReviewAffiliate } from '../lib/gas/gas.affiliate'
type JsonValue = Prisma.InputJsonValue

// Maps withdrawal network label → GasChainId for platform_fee ledger entries
const WITHDRAWAL_NETWORK_TO_GAS_CHAIN: Partial<Record<string, GasChainId>> = {
  TRC20:    'TRON',
  BEP20:    'BSC',
  ERC20:    'ETHEREUM',
  BASE:     'BASE',
  ARBITRUM: 'ARB',
  OPTIMISM: 'OP',
  POLYGON:  'MATIC',
}

const adminOrSuper = requireRole('admin', 'super_admin')
const adminOrSuperOrKyc = requireRole('admin', 'super_admin', 'kyc_reviewer')
const superAdminOnly = requireRole('super_admin')

// Resolve the gas hot-wallet address that holds tokens on a chain — used to probe
// a token contract on-chain before saving / going delivery-live (gas.tokenAddress).
async function resolveGasHotWalletOwner(dbChain: string): Promise<string | null> {
  if (dbChain === 'APT' || dbChain === 'APTOS') {
    const { getAptosHotWalletAddress } = await import('../lib/gas/aptosWalletService')
    return getAptosHotWalletAddress()
  }
  const w = await db.gasHotWallet.findFirst({
    where: { chain: dbChain as 'TRON' | 'BSC' | 'ETH' | 'SOL' | 'MATIC' | 'ARB' | 'BASE' | 'OP' | 'AVAX' | 'TON' | 'SUI' },
  })
  return w?.address ?? null
}

// Step-up auth for destructive admin actions (ban, money movement, config).
// No-op for admins without 2FA enabled; admins WITH 2FA must supply a fresh
// X-TOTP-Code header (the frontend api client prompts and retries on
// TOTP_REQUIRED). Strongly recommended: enable 2FA on all admin accounts.
const adminStepUp = [authenticate, adminOrSuper, requireAdminStepUp]
const superStepUp = [authenticate, superAdminOnly, requireAdminStepUp]

// Rejects known non-direct-image URLs (Google Drive share links etc.)
function validateLogoUrl(url: string): boolean {
  try {
    const u = new URL(url)
    const blockedHosts = ['drive.google.com', 'share.google.com', 'docs.google.com']
    if (blockedHosts.some((h) => u.hostname === h || u.hostname.endsWith('.' + h))) return false
    const imageExts = ['.png', '.jpg', '.jpeg', '.svg', '.webp', '.gif']
    const hasImageExt = imageExts.some((ext) => u.pathname.toLowerCase().endsWith(ext))
    const trustedHosts = ['res.cloudinary.com', 'githubusercontent.com', 'cryptologos.cc', 'icons8.com', 'cdn.']
    const isTrustedHost = trustedHosts.some((h) => u.hostname.includes(h))
    return hasImageExt || isTrustedHost
  } catch {
    return false
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function paginationParams(query: Record<string, string>) {
  const page = query.page ? parseInt(query.page, 10) : 1
  const limit = Math.min(query.limit ? parseInt(query.limit, 10) : 20, 100)
  const skip = (page - 1) * limit
  return { page, limit, skip }
}

/**
 * Resolve the real client IP, preferring proxy headers set by Cloudflare /
 * Railway over the raw socket. trustProxy is enabled so req.ip already parses
 * X-Forwarded-For, but cf-connecting-ip / x-real-ip are honoured first.
 */
function clientIp(req: FastifyRequest): string {
  const cf = req.headers['cf-connecting-ip']
  if (typeof cf === 'string' && cf.trim()) return cf.trim()
  const xr = req.headers['x-real-ip']
  if (typeof xr === 'string' && xr.trim()) return xr.trim()
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0]!.trim()
  return req.ip
}

async function createAuditLog(
  adminId: string,
  action: string,
  targetType: string,
  targetId: string,
  details: Record<string, unknown>,
  ipAddress?: string,
  userAgent?: string,
) {
  await db.auditLog.create({
    data: {
      actorId: adminId,
      action,
      targetType,
      targetId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      metadata: { ...details } as any,
      // Persist IP / UA into their dedicated columns so the Audit Log UI can
      // display them (previously buried in metadata._ip and never shown).
      ipAddress: ipAddress ?? null,
      userAgent: userAgent ? userAgent.slice(0, 500) : null,
    },
  })
}

import { notify } from '../lib/notify'
import { mergeVerifiedFromKyc } from '../services/socialLinks.service'
import { computeModerationStatus, recordModerationAction, notifyModeration, moderationStatusLabel } from '../lib/moderation'

// ─── Route Export ─────────────────────────────────────────────────────────────

export async function adminRoutes(app: FastifyInstance) {
  // ── Dashboard Stats ────────────────────────────────────────────────────────

  app.get(
    '/admin/dashboard/stats',
    { preHandler: [authenticate, adminOrSuperOrKyc] },
    async (req, reply) => {
      // Time-frame selector for the period-scoped KPIs (volume, trades, new
      // users, gas, withdrawals). 'all' drops the date boundary entirely. The
      // "Action Required" and "All Time" cards are point-in-time / cumulative
      // and intentionally ignore this filter.
      const RANGES = ['today', '7d', '30d', '1y', 'all'] as const
      type Range = (typeof RANGES)[number]
      const q = req.query as Record<string, string>
      const range: Range = (RANGES as readonly string[]).includes(q.range ?? '') ? (q.range as Range) : 'today'

      const DAY_MS = 86_400_000
      const now = new Date()
      let since: Date | undefined
      if (range === 'today') {
        const d = new Date(now)
        d.setHours(0, 0, 0, 0)
        since = d
      } else if (range === '7d') {
        since = new Date(now.getTime() - 7 * DAY_MS)
      } else if (range === '30d') {
        since = new Date(now.getTime() - 30 * DAY_MS)
      } else if (range === '1y') {
        since = new Date(now.getTime() - 365 * DAY_MS)
      } else {
        since = undefined // 'all' — no lower bound
      }
      // Spread helpers: apply the period boundary only when one exists.
      const createdSince   = since ? { createdAt: { gte: since } } : {}
      const updatedSince   = since ? { updatedAt: { gte: since } } : {}
      const deliveredSince = since ? { deliveredAt: { gte: since } } : {}
      const completedSince = since ? { completedAt: { gte: since } } : {}

      const [
        pendingKyc,
        openDisputes,
        pendingWithdrawals,
        pendingInstantBuy,
        todayRevenueResult,
        totalVolumePkrResult,
        totalUsers,
        newUsersToday,
        totalTrades,
        todayTrades,
        unreadNotifCount,
        recentNotifications,
        pendingGasOrders,
        pkrGasProofsPending,
        todayGasOrders,
        todayGasRevenueResult,
        totalGasOrders,
        totalGasRevenueResult,
        // Withdrawal accounting stats
        todaySentWithdrawals,
        totalSentWithdrawals,
        todayWithdrawalFeesResult,
        totalWithdrawalFeesResult,
        recentGasActivity,
      ] = await Promise.all([
        db.kycSubmission.count({ where: { status: 'pending' } }),
        db.dispute.count({ where: { status: { in: ['open', 'escalated'] } } }),
        db.withdrawal.count({ where: { status: { in: ['pending', 'first_approved'] } } }),
        db.instantBuyOrder.count({ where: { status: 'admin_review' } }),
        db.trade.aggregate({
          where: { status: 'crypto_released', ...updatedSince },
          _sum: { fiatAmount: true },
        }),
        db.trade.aggregate({
          where: { status: 'crypto_released' },
          _sum: { fiatAmount: true },
        }),
        db.user.count(),
        db.user.count({ where: { ...createdSince } }),
        db.trade.count(),
        db.trade.count({ where: { ...createdSince } }),
        db.adminNotification.count({ where: { isRead: false } }),
        db.adminNotification.findMany({
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: { id: true, category: true, title: true, body: true, href: true, isRead: true, createdAt: true },
        }),
        // Gas fee stats
        db.gasFeeOrder.count({ where: { status: { in: ['payment_pending', 'payment_uploaded', 'payment_verified', 'payment_detected', 'sending'] } } }),
        db.gasFeeOrder.count({ where: { status: 'payment_uploaded', paymentCoin: 'PKR' } }),
        db.gasFeeOrder.count({ where: { ...createdSince } }),
        db.gasFeeOrder.aggregate({
          where: { status: 'delivered', ...deliveredSince },
          // paymentAmount = what the user paid (gross, in USD); gasAmountUSD = the
          // USD cost of the gas we actually delivered. Revenue = gross − cost.
          _sum: { paymentAmount: true, gasAmountUSD: true },
        }),
        db.gasFeeOrder.count(),
        db.gasFeeOrder.aggregate({
          where: { status: 'delivered' },
          _sum: { paymentAmount: true, gasAmountUSD: true },
        }),
        // Withdrawal accounting stats — fees collected and sends completed
        db.withdrawal.count({ where: { status: { in: ['sent', 'completed'] }, ...completedSince } }),
        db.withdrawal.count({ where: { status: { in: ['sent', 'completed'] } } }),
        db.withdrawal.aggregate({
          where: { status: { in: ['sent', 'completed'] }, ...completedSince },
          _sum: { fee: true },
        }),
        db.withdrawal.aggregate({
          where: { status: { in: ['sent', 'completed'] } },
          _sum: { fee: true },
        }),
        // Recent gas wallet activity (inbound deposits + outbound deliveries)
        db.gasFeeOrder.findMany({
          where: {
            OR: [
              { paymentTxHash: { not: null } },
              { deliveryTxHash: { not: null } },
            ],
          },
          orderBy: { updatedAt: 'desc' },
          take: 8,
          select: {
            id: true, orderRef: true, chain: true,
            paymentAmount: true, paymentCoin: true, paymentNetwork: true,
            paymentTxHash: true, deliveryTxHash: true,
            gasAmountNative: true, status: true,
            createdAt: true, updatedAt: true, deliveredAt: true,
          },
        }),
      ])

      // Gas economics: gross = what users paid; cost = USD value of gas delivered;
      // revenue = the platform margin (gross − cost). Never let revenue go negative
      // (rounding/price drift on a delivered order) — floor at 0 for display.
      const todayGasGross   = Number(todayGasRevenueResult._sum.paymentAmount ?? 0)
      const todayGasCost    = Number(todayGasRevenueResult._sum.gasAmountUSD ?? 0)
      const totalGasGross   = Number(totalGasRevenueResult._sum.paymentAmount ?? 0)
      const totalGasCost    = Number(totalGasRevenueResult._sum.gasAmountUSD ?? 0)
      const todayGasRevenue = Math.max(0, todayGasGross - todayGasCost)
      const totalGasRevenue = Math.max(0, totalGasGross - totalGasCost)

      return reply.send({
        success: true,
        data: {
          // Echo the active time-frame so the UI can label the period cards.
          range,
          pendingKyc,
          openDisputes,
          pendingWithdrawals,
          pendingInstantBuy,
          // Trades carry no platform fee (non-custodial), so this is settled VOLUME, not revenue.
          todayVolumePkr:    (todayRevenueResult._sum.fiatAmount ?? 0).toString(),
          totalVolumePkr:    (totalVolumePkrResult._sum.fiatAmount ?? 0).toString(),
          totalUsers,
          newUsersToday,
          totalTrades,
          todayTrades,
          unreadNotifCount,
          recentNotifications,
          pendingGasOrders,
          pkrGasProofsPending,
          todayGasOrders,
          // Gross gas payment (cost + fee) vs actual platform margin (fee only).
          todayGasVolumeUsdt:  todayGasGross.toFixed(2),
          todayGasRevenueUsdt: todayGasRevenue.toFixed(2),
          totalGasOrders,
          totalGasVolumeUsdt:  totalGasGross.toFixed(2),
          totalGasRevenueUsdt: totalGasRevenue.toFixed(2),
          recentGasActivity,
          // Withdrawal accounting
          todaySentWithdrawals,
          totalSentWithdrawals,
          todayWithdrawalFeesUsdt: Number(todayWithdrawalFeesResult._sum.fee ?? 0).toFixed(6),
          totalWithdrawalFeesUsdt: Number(totalWithdrawalFeesResult._sum.fee ?? 0).toFixed(6),
        },
      })
    },
  )

  // ── Users ──────────────────────────────────────────────────────────────────

  app.get('/admin/users', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const query = req.query as Record<string, string>
    const { page, limit, skip } = paginationParams(query)

    const where: Record<string, unknown> = {}
    if (query.search) {
      const s = query.search.trim()
      where.OR = [
        { email: { contains: s, mode: 'insensitive' } },
        { username: { contains: s, mode: 'insensitive' } },
        { fullName: { contains: s, mode: 'insensitive' } },
        { referralCode: { contains: s, mode: 'insensitive' } },
        { telegramUsername: { contains: s.replace(/^@/, ''), mode: 'insensitive' } }, // @handle (with or without @)
        { id: s },               // exact user ID
        { registrationIp: s },   // exact IP (fraud investigation)
      ]
    }
    if (query.role) where.role = query.role
    if (query.kycStatus) where.kycStatus = query.kycStatus

    const [users, total] = await Promise.all([
      db.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          username: true,
          fullName: true,
          role: true,
          kycStatus: true,
          kycLevel: true,
          isBanned: true,
          isSuspended: true,
          bannedUntil: true,
          suspendedUntil: true,
          banType: true,
          underReview: true,
          moderationReason: true,
          createdAt: true,
          telegramId: true,
          telegramUsername: true,
          tradeStats: { select: { totalTrades: true, completedTrades: true, completionRate: true, totalVolumePKR: true, badge: true, badgeLabel: true, trustScore: true, badgeOverride: true } },
          _count: {
            select: {
              trades: true,
              sellTrades: true,
              ctmBuyTrades: true,
              ctmSellTrades: true,
              appeals: { where: { status: { in: ['pending', 'more_info_requested'] } } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      db.user.count({ where }),
    ])

    // Enrich with accurate live trade count (buy + sell, P2P + CTM) + moderation status.
    // Strip the raw BigInt telegramId (not JSON-serializable) and surface clean
    // flags: telegramLinked = signed up / linked via Telegram; hasRealEmail =
    // false when the email is the synthetic telegram_*@*.invalid placeholder.
    const enrichedUsers = users.map(({ telegramId, ...u }) => ({
      ...u,
      telegramLinked: telegramId != null,
      hasRealEmail: !isSyntheticEmail(u.email),
      tradeCount: (u._count.trades ?? 0) + (u._count.sellTrades ?? 0) + (u._count.ctmBuyTrades ?? 0) + (u._count.ctmSellTrades ?? 0),
      moderationStatus: computeModerationStatus(u),
      hasPendingAppeal: (u._count.appeals ?? 0) > 0,
    }))

    return reply.send({
      success: true,
      data: { users: enrichedUsers, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
    })
  })

  app.get('/admin/users/:id', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const [user, ctmBuyCount, ctmSellCount, gasCount, referralCount] = await Promise.all([
      db.user.findUnique({
        where: { id },
        include: {
          tradeStats: true,
          trades: {
            take: 20,
            orderBy: { createdAt: 'desc' },
            select: { id: true, orderRef: true, coin: true, amount: true, fiatAmount: true, status: true, createdAt: true },
          },
          sellTrades: {
            take: 20,
            orderBy: { createdAt: 'desc' },
            select: { id: true, orderRef: true, coin: true, amount: true, fiatAmount: true, status: true, createdAt: true },
          },
          kycSubmissions: { orderBy: { createdAt: 'desc' } },
          merchant: true,
          wallets: true,
          fraudFlags: { where: { status: 'open' } },
          adminNotes: { orderBy: { createdAt: 'desc' }, take: 10 },
          referredBy: { select: { id: true, username: true, email: true } },
          referrals: { select: { id: true, username: true, email: true, createdAt: true, kycStatus: true }, take: 20 },
          gasFeeOrders: {
            take: 10,
            orderBy: { createdAt: 'desc' },
            select: { id: true, chain: true, gasAmountUSD: true, status: true, createdAt: true },
          },
        },
      }),
      db.ctmTrade.count({ where: { buyerId: id } }),
      db.ctmTrade.count({ where: { sellerId: id } }),
      db.gasFeeOrder.count({ where: { userId: id } }),
      db.user.count({ where: { referredById: id } }),
    ])

    if (!user) throw Errors.NOT_FOUND('User')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const u = user as any
    const p2pBuyCount  = (u.trades?.length ?? 0) as number
    const p2pSellCount = (u.sellTrades?.length ?? 0) as number
    const liveTradeCount = p2pBuyCount + p2pSellCount + ctmBuyCount + ctmSellCount

    return reply.send({
      success: true,
      data: {
        ...user,
        // KYC documents are authenticated Cloudinary assets — sign for display
        kycSubmissions: (u.kycSubmissions ?? []).map((s: { frontUrl: string; backUrl: string; selfieUrl: string; videoUrl: string | null }) => ({
          ...s,
          frontUrl: signCloudinaryDeliveryUrl(s.frontUrl),
          backUrl: signCloudinaryDeliveryUrl(s.backUrl),
          selfieUrl: signCloudinaryDeliveryUrl(s.selfieUrl),
          videoUrl: signCloudinaryDeliveryUrl(s.videoUrl),
        })),
        moderationStatus: computeModerationStatus(user),
        liveTradeCount,
        ctmBuyCount,
        ctmSellCount,
        gasOrderCount: gasCount,
        referralCount,
      },
    })
  })

  // ── Full user intelligence profile (read-only aggregation) ──────────────────
  // Powers /admin/users/:id — one central page joining every record tied to a
  // user: trades (P2P/CTM/gas), wallet movements, disputes, ratings, referrals,
  // saved payment/delivery details and audit trail.
  app.get('/admin/users/:id/profile', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const user = await db.user.findUnique({
      where: { id },
      include: {
        tradeStats: true,
        merchant: true,
        ctmMerchantProfile: true,
        referredBy: { select: { id: true, username: true, email: true } },
        fraudFlags: { orderBy: { createdAt: 'desc' }, take: 20 },
        adminNotes: { orderBy: { createdAt: 'desc' }, take: 20 },
        paymentMethods: { orderBy: { createdAt: 'desc' } },
        savedAddresses: true,
        kycSubmissions: { orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, tier: true, status: true, reviewedAt: true, createdAt: true } },
        wallets: { select: { coin: true, network: true, balance: true, lockedBalance: true } },
      },
    })
    if (!user) throw Errors.NOT_FOUND('User')

    const userOr = { OR: [{ buyerId: id }, { sellerId: id }] }

    const [
      p2pTrades, ctmTrades, gasOrders,
      withdrawals, deposits, depositAddresses,
      p2pStatus, ctmBuyStatus, ctmSellStatus, gasStatus,
      p2pDisputes, ctmDisputes,
      ratingsReceived, ctmRatingsReceived, ratingAgg, ctmRatingAgg,
      referrals, referralCount,
      auditByUser, auditTargetingUser,
      moderationActions, appeals, recentNotifications,
    ] = await Promise.all([
      db.trade.findMany({
        where: { OR: [{ buyerId: id }, { sellerId: id }] },
        orderBy: { createdAt: 'desc' }, take: 30,
        select: { id: true, orderRef: true, coin: true, amount: true, fiatAmount: true, status: true, createdAt: true, buyerId: true, sellerId: true },
      }),
      db.ctmTrade.findMany({
        where: userOr,
        orderBy: { createdAt: 'desc' }, take: 30,
        select: { id: true, tradeRef: true, tokenAmount: true, pricePerUnit: true, fiatAmount: true, status: true, createdAt: true, buyerId: true, sellerId: true, token: { select: { symbol: true, name: true } } },
      }),
      db.gasFeeOrder.findMany({
        where: { userId: id },
        orderBy: { createdAt: 'desc' }, take: 30,
        select: { id: true, orderRef: true, chain: true, gasAmountUSD: true, status: true, createdAt: true },
      }),
      db.withdrawal.findMany({
        where: { userId: id },
        orderBy: { createdAt: 'desc' }, take: 30,
        select: { id: true, orderRef: true, coin: true, network: true, amount: true, fee: true, status: true, toAddress: true, txHash: true, createdAt: true },
      }),
      db.deposit.findMany({
        where: { userId: id },
        orderBy: { detectedAt: 'desc' }, take: 30,
        select: { id: true, txHash: true, chain: true, symbol: true, amount: true, status: true, detectedAt: true, creditedAt: true },
      }),
      db.depositAddress.findMany({
        where: { userId: id },
        orderBy: { createdAt: 'asc' },
        select: { id: true, chainFamily: true, address: true, derivationIndex: true, createdAt: true },
      }),
      db.trade.groupBy({ by: ['status'], where: { OR: [{ buyerId: id }, { sellerId: id }] }, _count: { status: true } }),
      db.ctmTrade.groupBy({ by: ['status'], where: { buyerId: id }, _count: { status: true } }),
      db.ctmTrade.groupBy({ by: ['status'], where: { sellerId: id }, _count: { status: true } }),
      db.gasFeeOrder.groupBy({ by: ['status'], where: { userId: id }, _count: { status: true } }),
      db.dispute.findMany({
        where: { trade: { OR: [{ buyerId: id }, { sellerId: id }] } },
        orderBy: { createdAt: 'desc' }, take: 20,
        select: { id: true, reason: true, status: true, winner: true, openedById: true, resolvedAt: true, createdAt: true, trade: { select: { orderRef: true } } },
      }),
      db.ctmDispute.findMany({
        where: { trade: userOr },
        orderBy: { createdAt: 'desc' }, take: 20,
        select: { id: true, reason: true, status: true, winner: true, openedById: true, resolvedAt: true, createdAt: true, trade: { select: { tradeRef: true } } },
      }),
      db.tradeRating.findMany({
        where: { ratedUserId: id, hidden: false },
        orderBy: { createdAt: 'desc' }, take: 20,
        select: { id: true, rating: true, comment: true, tags: true, ratedByUserId: true, createdAt: true },
      }),
      db.ctmTradeRating.findMany({
        where: { ratedUserId: id },
        orderBy: { createdAt: 'desc' }, take: 20,
        select: { id: true, rating: true, comment: true, tags: true, ratedByUserId: true, createdAt: true },
      }),
      db.tradeRating.aggregate({ where: { ratedUserId: id, hidden: false }, _avg: { rating: true }, _count: { rating: true } }),
      db.ctmTradeRating.aggregate({ where: { ratedUserId: id }, _avg: { rating: true }, _count: { rating: true } }),
      db.user.findMany({ where: { referredById: id }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, username: true, email: true, kycStatus: true, createdAt: true } }),
      db.user.count({ where: { referredById: id } }),
      db.auditLog.findMany({ where: { actorId: id }, orderBy: { createdAt: 'desc' }, take: 25, select: { id: true, action: true, targetType: true, targetId: true, ipAddress: true, createdAt: true } }),
      db.auditLog.findMany({ where: { targetType: { in: ['User', 'user'] }, targetId: id }, orderBy: { createdAt: 'desc' }, take: 25, select: { id: true, action: true, actorId: true, ipAddress: true, createdAt: true } }),
      db.moderationAction.findMany({
        where: { targetUserId: id }, orderBy: { createdAt: 'desc' }, take: 50,
        select: { id: true, action: true, reason: true, previousStatus: true, newStatus: true, durationLabel: true, expiresAt: true, createdAt: true, moderator: { select: { id: true, username: true } } },
      }),
      db.appeal.findMany({
        where: { userId: id }, orderBy: { createdAt: 'desc' }, take: 25,
        select: { id: true, status: true, subjectStatus: true, explanation: true, evidenceUrls: true, decisionNote: true, reviewedAt: true, createdAt: true, reviewedBy: { select: { id: true, username: true } } },
      }),
      db.notification.findMany({
        where: { userId: id }, orderBy: { createdAt: 'desc' }, take: 25,
        select: { id: true, type: true, title: true, body: true, isRead: true, createdAt: true },
      }),
    ])

    // Blend ratings from both marketplaces into one average
    const rCount = (ratingAgg._count.rating ?? 0) + (ctmRatingAgg._count.rating ?? 0)
    const rSum = (Number(ratingAgg._avg.rating ?? 0) * (ratingAgg._count.rating ?? 0))
      + (Number(ctmRatingAgg._avg.rating ?? 0) * (ctmRatingAgg._count.rating ?? 0))
    const avgRating = rCount > 0 ? Number((rSum / rCount).toFixed(2)) : null

    const onlineThreshold = new Date(Date.now() - 5 * 60 * 1000)
    const isOnline = !!user.lastSeenAt && user.lastSeenAt > onlineThreshold

    // ── Referral & affiliate program (flag-independent admin view) ──
    const [gasCodes, accrualAgg, affiliateProfile] = await Promise.all([
      db.gasReferralCode.findMany({ where: { ownerId: id }, orderBy: { createdAt: 'asc' }, select: { id: true, code: true, label: true, referralPct: true, userDiscountPct: true, isActive: true } }),
      db.gasReferralAccrual.groupBy({ by: ['status'], where: { referrerId: id }, _sum: { amountUsdt: true } }),
      db.gasAffiliate.findUnique({ where: { userId: id }, select: { status: true, socials: true, applicantNote: true, rejectionReason: true, maxMarginPct: true, minUserDiscountPct: true, maxLinks: true, reviewedAt: true } }),
    ])
    const codeIds = gasCodes.map((c) => c.id)
    const perCode = codeIds.length ? await db.gasReferral.groupBy({ by: ['codeId'], where: { codeId: { in: codeIds } }, _count: { _all: true } }) : []
    const perCodeMap = new Map(perCode.map((c) => [c.codeId, c._count._all]))
    const round2 = (n: number) => Math.round(n * 100) / 100
    let totalEarnedUsdt = 0, availableUsdt = 0, withdrawnUsdt = 0
    for (const a of accrualAgg) {
      const amt = Number(a._sum.amountUsdt ?? 0)
      if (a.status === 'available') { availableUsdt += amt; totalEarnedUsdt += amt }
      else if (a.status === 'withdrawn') { withdrawnUsdt += amt; totalEarnedUsdt += amt }
    }
    const referralProgram = {
      referralCode: user.referralCode,
      referralPct: gasCodes[0]?.referralPct ?? null,
      referredCount: referralCount,
      totalEarnedUsdt: round2(totalEarnedUsdt),
      availableUsdt: round2(availableUsdt),
      withdrawnUsdt: round2(withdrawnUsdt),
      affiliate: affiliateProfile,
      codes: gasCodes.map((c) => ({ ...c, referredCount: perCodeMap.get(c.id) ?? 0 })),
    }

    const ts = user.tradeStats
    return reply.send({
      success: true,
      data: {
        profile: {
          id: user.id,
          username: user.username,
          email: user.email,
          fullName: user.fullName,
          avatarUrl: user.avatarUrl,
          role: user.role,
          kycStatus: user.kycStatus,
          kycLevel: user.kycLevel,
          twoFaEnabled: user.twoFaEnabled,
          isEmailVerified: user.isEmailVerified,
          createdAt: user.createdAt,
          lastSeenAt: user.lastSeenAt,
          isOnline,
          registrationIp: user.registrationIp,
          country: user.country,
          countryCode: user.countryCode,
          isBanned: user.isBanned,
          isSuspended: user.isSuspended,
          suspendReason: user.suspendReason,
          moderationReason: user.moderationReason,
          moderationStatus: computeModerationStatus(user),
          bannedUntil: user.bannedUntil,
          suspendedUntil: user.suspendedUntil,
          banType: user.banType,
          underReview: user.underReview,
          referralCode: user.referralCode,
          isMerchant: !!user.merchant,
          merchantName: user.merchant?.businessName ?? null,
          isCtmMerchant: !!user.ctmMerchantProfile,
          badge: ts?.badge ?? 'new',
          badgeLabel: ts?.badgeLabel ?? null,
          badgeOverride: ts?.badgeOverride ?? false,
          trustScore: ts?.trustScore ?? null,
          completionRate: ts ? Number(ts.completionRate) : null,
          completedTrades: ts?.completedTrades ?? 0,
          totalTrades: ts?.totalTrades ?? 0,
          avgRating,
          ratingCount: rCount,
        },
        summary: {
          p2pStatus, ctmBuyStatus, ctmSellStatus, gasStatus,
          referralCount,
        },
        p2pTrades, ctmTrades, gasOrders,
        withdrawals, deposits, depositAddresses,
        paymentMethods: user.paymentMethods,
        savedAddresses: user.savedAddresses,
        kycSubmissions: user.kycSubmissions,
        wallets: user.wallets,
        disputes: { p2p: p2pDisputes, ctm: ctmDisputes },
        ratings: { p2p: ratingsReceived, ctm: ctmRatingsReceived },
        referrals,
        referredBy: user.referredBy,
        referralProgram,
        auditByUser,
        auditTargetingUser,
        adminNotes: user.adminNotes,
        fraudFlags: user.fraudFlags,
        moderationActions,
        appeals,
        notifications: recentNotifications,
      },
    })
  })

  // Loads the moderation flags needed to compute a user's current status.
  const MODERATION_SELECT = { id: true, email: true, isBanned: true, isSuspended: true, bannedUntil: true, suspendedUntil: true, underReview: true } as const

  // ── Ban (permanent or temporary) ──
  app.post('/admin/users/:id/ban', { preHandler: adminStepUp, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const bodySchema = z.object({
      reason: z.string().min(1).max(1000),
      type: z.enum(['permanent', 'temporary']).default('permanent'),
      until: z.string().datetime().optional(),
      durationLabel: z.string().max(40).optional(),
    }).refine((d) => d.type === 'permanent' || !!d.until, { message: 'A temporary ban requires an end date', path: ['until'] })
      .refine((d) => !d.until || new Date(d.until).getTime() > Date.now(), { message: 'End date must be in the future', path: ['until'] })
    const parsed = bodySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    const { reason, type, until, durationLabel } = parsed.data

    const user = await db.user.findUnique({ where: { id }, select: MODERATION_SELECT })
    if (!user) throw Errors.NOT_FOUND('User')
    const prevStatus = computeModerationStatus(user)
    const bannedUntil = type === 'temporary' && until ? new Date(until) : null

    await db.user.update({
      where: { id },
      data: {
        isBanned: true, banType: type, bannedUntil,
        isSuspended: false, suspendedUntil: null,
        moderationReason: reason, suspendReason: reason,
      },
    })
    const newStatus = bannedUntil ? 'temporarily_banned' : 'permanently_banned'
    await recordModerationAction({ targetUserId: id, moderatorId: req.user!.id, action: bannedUntil ? 'ban_temporary' : 'ban_permanent', reason, previousStatus: prevStatus, newStatus, durationLabel: durationLabel ?? (bannedUntil ? 'Custom' : 'Permanent'), expiresAt: bannedUntil })
    await createAuditLog(req.user!.id, 'USER_BANNED', 'User', id, { reason, type, until: until ?? null }, clientIp(req), req.headers['user-agent'] as string | undefined)
    notifyModeration(id, type === 'temporary' ? 'Account temporarily banned' : 'Account banned',
      type === 'temporary' && bannedUntil
        ? `Your account has been banned until ${bannedUntil.toUTCString()}. Reason: ${reason}`
        : `Your account has been permanently banned. Reason: ${reason}`,
      { action: 'ban', reason, until: until ?? null })
    return reply.send({ success: true })
  })

  // ── Unban (clears ban only; an active suspension is preserved) ──
  app.post('/admin/users/:id/unban', { preHandler: [authenticate, adminOrSuper], config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const bodySchema = z.object({ reason: z.string().max(1000).optional() })
    const reason = bodySchema.safeParse(req.body).success ? (req.body as { reason?: string }).reason ?? 'Ban lifted by admin' : 'Ban lifted by admin'
    const user = await db.user.findUnique({ where: { id }, select: MODERATION_SELECT })
    if (!user) throw Errors.NOT_FOUND('User')
    if (!user.isBanned) throw new AppError('NOT_BANNED', 'User is not banned', 400)
    const prevStatus = computeModerationStatus(user)
    await db.user.update({ where: { id }, data: { isBanned: false, banType: null, bannedUntil: null, ...(user.isSuspended ? {} : { moderationReason: null, suspendReason: null }) } })
    const after = { ...user, isBanned: false, bannedUntil: null }
    await recordModerationAction({ targetUserId: id, moderatorId: req.user!.id, action: 'unban', reason, previousStatus: prevStatus, newStatus: computeModerationStatus(after) })
    await createAuditLog(req.user!.id, 'USER_UNBANNED', 'User', id, { reason }, clientIp(req), req.headers['user-agent'] as string | undefined)
    notifyModeration(id, 'Account ban lifted', 'Your account ban has been lifted. You can now sign in again.', { action: 'unban' })
    return reply.send({ success: true })
  })

  // ── Suspend (with optional auto-lift date) ──
  app.post('/admin/users/:id/suspend', { preHandler: adminStepUp, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const bodySchema = z.object({
      reason: z.string().min(1).max(1000),
      until: z.string().datetime().optional(),
      durationLabel: z.string().max(40).optional(),
    }).refine((d) => !d.until || new Date(d.until).getTime() > Date.now(), { message: 'End date must be in the future', path: ['until'] })
    const parsed = bodySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    const { reason, until, durationLabel } = parsed.data

    const user = await db.user.findUnique({ where: { id }, select: MODERATION_SELECT })
    if (!user) throw Errors.NOT_FOUND('User')
    if (user.isBanned) throw new AppError('USER_BANNED', 'User is banned — lift the ban before suspending', 400)
    const prevStatus = computeModerationStatus(user)
    const suspendedUntil = until ? new Date(until) : null
    await db.user.update({ where: { id }, data: { isSuspended: true, suspendedUntil, moderationReason: reason, suspendReason: reason } })
    await recordModerationAction({ targetUserId: id, moderatorId: req.user!.id, action: 'suspend', reason, previousStatus: prevStatus, newStatus: 'suspended', durationLabel: durationLabel ?? (suspendedUntil ? 'Custom' : 'Indefinite'), expiresAt: suspendedUntil })
    await createAuditLog(req.user!.id, 'USER_SUSPENDED', 'User', id, { reason, until: until ?? null }, clientIp(req), req.headers['user-agent'] as string | undefined)
    notifyModeration(id, 'Account suspended',
      suspendedUntil
        ? `Your account has been suspended until ${suspendedUntil.toUTCString()}. Reason: ${reason}`
        : `Your account has been suspended. Reason: ${reason}`,
      { action: 'suspend', reason, until: until ?? null })
    return reply.send({ success: true })
  })

  // ── Unsuspend (clears suspension only) ──
  app.post('/admin/users/:id/unsuspend', { preHandler: [authenticate, adminOrSuper], config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const reason = (req.body as { reason?: string } | undefined)?.reason ?? 'Suspension lifted by admin'
    const user = await db.user.findUnique({ where: { id }, select: MODERATION_SELECT })
    if (!user) throw Errors.NOT_FOUND('User')
    if (!user.isSuspended) throw new AppError('NOT_SUSPENDED', 'User is not suspended', 400)
    const prevStatus = computeModerationStatus(user)
    await db.user.update({ where: { id }, data: { isSuspended: false, suspendedUntil: null, ...(user.isBanned ? {} : { moderationReason: null, suspendReason: null }) } })
    const after = { ...user, isSuspended: false, suspendedUntil: null }
    await recordModerationAction({ targetUserId: id, moderatorId: req.user!.id, action: 'unsuspend', reason, previousStatus: prevStatus, newStatus: computeModerationStatus(after) })
    await createAuditLog(req.user!.id, 'USER_UNSUSPENDED', 'User', id, { reason }, clientIp(req), req.headers['user-agent'] as string | undefined)
    notifyModeration(id, 'Suspension lifted', 'Your account suspension has been lifted. Full access restored.', { action: 'unsuspend' })
    return reply.send({ success: true })
  })

  // ── Restore access (clears ALL restrictions + review flag) ──
  app.post('/admin/users/:id/restore-access', { preHandler: [authenticate, adminOrSuper], config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const reason = (req.body as { reason?: string } | undefined)?.reason ?? 'Access restored by admin'
    const user = await db.user.findUnique({ where: { id }, select: MODERATION_SELECT })
    if (!user) throw Errors.NOT_FOUND('User')
    const prevStatus = computeModerationStatus(user)
    if (prevStatus === 'active') throw new AppError('ALREADY_ACTIVE', 'User already has full access', 400)
    await db.user.update({ where: { id }, data: { isBanned: false, isSuspended: false, bannedUntil: null, suspendedUntil: null, banType: null, underReview: false, moderationReason: null, suspendReason: null } })
    await recordModerationAction({ targetUserId: id, moderatorId: req.user!.id, action: 'restore_access', reason, previousStatus: prevStatus, newStatus: 'active' })
    await createAuditLog(req.user!.id, 'USER_ACCESS_RESTORED', 'User', id, { reason }, clientIp(req), req.headers['user-agent'] as string | undefined)
    notifyModeration(id, 'Access restored', 'All restrictions on your account have been lifted. Welcome back.', { action: 'restore_access' })
    return reply.send({ success: true })
  })

  // ── Toggle "Under Review" (informational; does not block access) ──
  app.post('/admin/users/:id/review', { preHandler: [authenticate, adminOrSuper], config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const bodySchema = z.object({ active: z.boolean(), reason: z.string().min(1).max(1000) })
    const parsed = bodySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    const { active, reason } = parsed.data
    const user = await db.user.findUnique({ where: { id }, select: MODERATION_SELECT })
    if (!user) throw Errors.NOT_FOUND('User')
    const prevStatus = computeModerationStatus(user)
    await db.user.update({ where: { id }, data: { underReview: active } })
    const newStatus = computeModerationStatus({ ...user, underReview: active })
    await recordModerationAction({ targetUserId: id, moderatorId: req.user!.id, action: active ? 'start_review' : 'end_review', reason, previousStatus: prevStatus, newStatus })
    await createAuditLog(req.user!.id, active ? 'USER_REVIEW_STARTED' : 'USER_REVIEW_ENDED', 'User', id, { reason }, clientIp(req), req.headers['user-agent'] as string | undefined)
    return reply.send({ success: true })
  })

  // ── Reset trust score (clears manual override + forces a fresh recalculation) ──
  app.post('/admin/users/:id/reset-trust', { preHandler: [authenticate, adminOrSuper], config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const bodySchema = z.object({ reason: z.string().min(1).max(1000) })
    const parsed = bodySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    const user = await db.user.findUnique({ where: { id }, select: { id: true, tradeStats: { select: { id: true } } } })
    if (!user) throw Errors.NOT_FOUND('User')
    if (user.tradeStats) {
      await db.tradeStats.update({ where: { userId: id }, data: { badgeOverride: false } })
    }
    await queues.badgeRecalculate.add('recalc', { userId: id }).catch(() => {})
    await recordModerationAction({ targetUserId: id, moderatorId: req.user!.id, action: 'reset_trust', reason: parsed.data.reason, previousStatus: 'active', newStatus: 'active' })
    await createAuditLog(req.user!.id, 'USER_TRUST_RESET', 'User', id, { reason: parsed.data.reason }, clientIp(req), req.headers['user-agent'] as string | undefined)
    return reply.send({ success: true })
  })

  // ── Moderation history (action log + current status) ──
  app.get('/admin/users/:id/moderation', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const [user, actions] = await Promise.all([
      db.user.findUnique({ where: { id }, select: { ...MODERATION_SELECT, banType: true, moderationReason: true } }),
      db.moderationAction.findMany({ where: { targetUserId: id }, orderBy: { createdAt: 'desc' }, take: 100, select: { id: true, action: true, reason: true, previousStatus: true, newStatus: true, durationLabel: true, expiresAt: true, createdAt: true, moderator: { select: { id: true, username: true } } } }),
    ])
    if (!user) throw Errors.NOT_FOUND('User')
    return reply.send({ success: true, data: { status: computeModerationStatus(user), statusLabel: moderationStatusLabel(computeModerationStatus(user)), banType: user.banType, bannedUntil: user.bannedUntil, suspendedUntil: user.suspendedUntil, underReview: user.underReview, moderationReason: user.moderationReason, actions } })
  })

  // ── Appeals (admin review) ──────────────────────────────────────────────
  app.get('/admin/appeals', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const query = req.query as Record<string, string>
    const { page, limit, skip } = paginationParams(query)
    const where: Record<string, unknown> = {}
    if (query.status && ['pending', 'approved', 'rejected', 'more_info_requested'].includes(query.status)) where.status = query.status
    if (query.search) {
      const s = query.search.trim()
      where.user = { OR: [{ email: { contains: s, mode: 'insensitive' } }, { username: { contains: s, mode: 'insensitive' } }] }
    }
    const [appeals, total, pendingCount] = await Promise.all([
      db.appeal.findMany({
        where, orderBy: { createdAt: 'desc' }, skip, take: limit,
        select: {
          id: true, status: true, subjectStatus: true, explanation: true, evidenceUrls: true,
          decisionNote: true, reviewedAt: true, createdAt: true, updatedAt: true,
          user: { select: { id: true, username: true, email: true, isBanned: true, isSuspended: true, bannedUntil: true, underReview: true } },
          reviewedBy: { select: { id: true, username: true } },
        },
      }),
      db.appeal.count({ where }),
      db.appeal.count({ where: { status: { in: ['pending', 'more_info_requested'] } } }),
    ])
    const enriched = appeals.map((a) => ({ ...a, user: { ...a.user, moderationStatus: computeModerationStatus(a.user) } }))
    return reply.send({ success: true, data: { appeals: enriched, pendingCount, pagination: { page, limit, total, pages: Math.ceil(total / limit) } } })
  })

  app.get('/admin/appeals/:id', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const appeal = await db.appeal.findUnique({
      where: { id },
      select: {
        id: true, status: true, subjectStatus: true, explanation: true, evidenceUrls: true,
        decisionNote: true, reviewedAt: true, createdAt: true, updatedAt: true,
        user: { select: { id: true, username: true, email: true, isBanned: true, isSuspended: true, bannedUntil: true, suspendedUntil: true, banType: true, underReview: true, moderationReason: true } },
        reviewedBy: { select: { id: true, username: true } },
      },
    })
    if (!appeal) throw Errors.NOT_FOUND('Appeal')
    return reply.send({ success: true, data: { ...appeal, user: { ...appeal.user, moderationStatus: computeModerationStatus(appeal.user) } } })
  })

  // Approve: marks the appeal approved AND restores the user's access.
  app.post('/admin/appeals/:id/approve', { preHandler: [authenticate, adminOrSuper], config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const note = (req.body as { note?: string } | undefined)?.note?.slice(0, 1000) ?? null
    const appeal = await db.appeal.findUnique({ where: { id }, select: { id: true, status: true, userId: true } })
    if (!appeal) throw Errors.NOT_FOUND('Appeal')
    if (appeal.status !== 'pending' && appeal.status !== 'more_info_requested') throw new AppError('ALREADY_DECIDED', 'This appeal has already been decided', 400)
    const user = await db.user.findUnique({ where: { id: appeal.userId }, select: MODERATION_SELECT })
    if (!user) throw Errors.NOT_FOUND('User')
    const prevStatus = computeModerationStatus(user)
    await db.$transaction([
      db.appeal.update({ where: { id }, data: { status: 'approved', reviewedById: req.user!.id, reviewedAt: new Date(), decisionNote: note } }),
      db.user.update({ where: { id: appeal.userId }, data: { isBanned: false, isSuspended: false, bannedUntil: null, suspendedUntil: null, banType: null, underReview: false, moderationReason: null, suspendReason: null } }),
    ])
    await recordModerationAction({ targetUserId: appeal.userId, moderatorId: req.user!.id, action: 'restore_access', reason: `Appeal approved${note ? `: ${note}` : ''}`, previousStatus: prevStatus, newStatus: 'active' })
    await createAuditLog(req.user!.id, 'APPEAL_APPROVED', 'Appeal', id, { userId: appeal.userId, note }, clientIp(req), req.headers['user-agent'] as string | undefined)
    notifyModeration(appeal.userId, 'Appeal approved', 'Your appeal was approved and your account access has been restored.', { action: 'appeal_approved', appealId: id })
    return reply.send({ success: true })
  })

  app.post('/admin/appeals/:id/reject', { preHandler: [authenticate, adminOrSuper], config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const bodySchema = z.object({ note: z.string().min(1).max(1000) })
    const parsed = bodySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'A decision note is required when rejecting an appeal', 400)
    const appeal = await db.appeal.findUnique({ where: { id }, select: { id: true, status: true, userId: true } })
    if (!appeal) throw Errors.NOT_FOUND('Appeal')
    if (appeal.status !== 'pending' && appeal.status !== 'more_info_requested') throw new AppError('ALREADY_DECIDED', 'This appeal has already been decided', 400)
    await db.appeal.update({ where: { id }, data: { status: 'rejected', reviewedById: req.user!.id, reviewedAt: new Date(), decisionNote: parsed.data.note } })
    await createAuditLog(req.user!.id, 'APPEAL_REJECTED', 'Appeal', id, { userId: appeal.userId, note: parsed.data.note }, clientIp(req), req.headers['user-agent'] as string | undefined)
    notifyModeration(appeal.userId, 'Appeal rejected', `Your appeal was reviewed and rejected. ${parsed.data.note}`, { action: 'appeal_rejected', appealId: id })
    return reply.send({ success: true })
  })

  app.post('/admin/appeals/:id/request-info', { preHandler: [authenticate, adminOrSuper], config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const bodySchema = z.object({ note: z.string().min(1).max(1000) })
    const parsed = bodySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'A note describing the information needed is required', 400)
    const appeal = await db.appeal.findUnique({ where: { id }, select: { id: true, status: true, userId: true } })
    if (!appeal) throw Errors.NOT_FOUND('Appeal')
    if (appeal.status === 'approved' || appeal.status === 'rejected') throw new AppError('ALREADY_DECIDED', 'This appeal has already been decided', 400)
    await db.appeal.update({ where: { id }, data: { status: 'more_info_requested', reviewedById: req.user!.id, reviewedAt: new Date(), decisionNote: parsed.data.note } })
    await createAuditLog(req.user!.id, 'APPEAL_INFO_REQUESTED', 'Appeal', id, { userId: appeal.userId, note: parsed.data.note }, clientIp(req), req.headers['user-agent'] as string | undefined)
    notifyModeration(appeal.userId, 'More information needed', `We need more information about your appeal: ${parsed.data.note}`, { action: 'appeal_info_requested', appealId: id })
    return reply.send({ success: true })
  })

  app.post('/admin/users/:id/seize-collateral', { preHandler: adminStepUp }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const bodySchema = z.object({ reason: z.string().min(1).max(500) })
    const parsed = bodySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    await db.$transaction(async (tx) => {
      const collateralLocks = await tx.collateralLock.findMany({
        where: { userId: id, status: 'locked' },
      })
      if (collateralLocks.length === 0) {
        throw new AppError('NO_COLLATERAL', 'No active collateral locks found for this user', 404)
      }

      for (const lock of collateralLocks) {
        await tx.collateralLock.update({
          where: { id: lock.id },
          data: { status: 'seized', seizedAt: new Date(), seizeReason: parsed.data.reason },
        })
        // Clear locked balance from USDT wallet
        await tx.wallet.updateMany({
          where: { userId: id, coin: lock.coin },
          data: { lockedBalance: { decrement: lock.amount } },
        })
      }
    })

    await createAuditLog(req.user!.id, 'COLLATERAL_SEIZED', 'User', id, { reason: parsed.data.reason }, clientIp(req), req.headers['user-agent'] as string | undefined)
    return reply.send({ success: true })
  })

  app.post('/admin/users/:id/badge', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const bodySchema = z.object({
      badge: z.enum(['new', 'active', 'trusted', 'top', 'elite']),
      badgeLabel: z.string().min(1).max(100).optional(),
      reason: z.string().max(500).optional(),
      clearOverride: z.boolean().optional(),
    })
    const parsed = bodySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    const user = await db.user.findUnique({ where: { id }, select: { id: true } })
    if (!user) throw Errors.NOT_FOUND('User')

    const BADGE_LABELS: Record<string, string> = {
      new: 'New Trader', active: 'Active Trader', trusted: 'Trusted Trader',
      top: 'Top Trader', elite: 'Elite Trader',
    }

    await db.tradeStats.upsert({
      where: { userId: id },
      create: {
        userId: id,
        badge: parsed.data.badge,
        badgeLabel: parsed.data.badgeLabel ?? BADGE_LABELS[parsed.data.badge] ?? parsed.data.badge,
        badgeOverride: !parsed.data.clearOverride,
      },
      update: {
        badge: parsed.data.badge,
        badgeLabel: parsed.data.badgeLabel ?? BADGE_LABELS[parsed.data.badge] ?? parsed.data.badge,
        badgeOverride: !parsed.data.clearOverride,
      },
    })

    await createAuditLog(req.user!.id, 'BADGE_OVERRIDE', 'User', id, {
      badge: parsed.data.badge,
      reason: parsed.data.reason ?? null,
      clearOverride: parsed.data.clearOverride ?? false,
    }, clientIp(req), req.headers['user-agent'] as string | undefined)

    return reply.send({ success: true })
  })

  // POST /admin/stats/recalculate — enqueue a TradeStats/badge recalc for every
  // user who has participated in any trade (USDT, CTM, or Gas). Use this to
  // repair stale rows: the dashboard/KYC card read the persisted
  // TradeStats.completedTrades, which is only refreshed when the badge job runs.
  // CTM/Gas recalc triggers were added after some trades already completed, so
  // those rows can lag the live leaderboard count until a recalc fires. This
  // endpoint forces a recalc for everyone. Idempotent and safe to re-run.
  app.post('/admin/stats/recalculate', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const adminId = req.user!.id

    // Optional single-user target: { userId?: string }
    const body = (req.body ?? {}) as { userId?: string }

    let userIds: string[]
    if (body.userId) {
      userIds = [body.userId]
    } else {
      const [usdt, ctm, gas] = await Promise.all([
        db.trade.findMany({ select: { buyerId: true, sellerId: true } }),
        db.ctmTrade.findMany({ select: { buyerId: true, sellerId: true } }),
        db.gasFeeOrder.findMany({ where: { userId: { not: null } }, select: { userId: true } }),
      ])
      const set = new Set<string>()
      for (const t of usdt) { set.add(t.buyerId); set.add(t.sellerId) }
      for (const t of ctm) { set.add(t.buyerId); set.add(t.sellerId) }
      for (const o of gas) { if (o.userId) set.add(o.userId) }
      userIds = [...set]
    }

    await Promise.all(
      userIds.map((userId) => queues.badgeRecalculate.add('recalc', { userId }).catch(() => {})),
    )

    log.info({ adminId, count: userIds.length }, 'TradeStats recalc enqueued for all users via admin endpoint')
    void createAuditLog(adminId, 'TRADE_STATS_RECALC', 'TradeStats', body.userId ?? 'all', { count: userIds.length })

    return reply.code(202).send({
      success: true,
      data: { enqueued: userIds.length, message: 'Recalculation jobs enqueued. Stats refresh as the badge worker processes them.' },
    })
  })

  // POST /admin/users/sync-kyc-limits — set every approved user's daily limit to
  // match their KYC tier (basic / enhanced) from platform config. One-time repair
  // for users approved before tier-based limits were enforced. Idempotent.
  app.post('/admin/users/sync-kyc-limits', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const adminId = req.user!.id
    const cfg = await getPublicConfig()

    const [enhanced, basic] = await Promise.all([
      db.user.updateMany({
        where: { kycStatus: 'approved', kycLevel: 'enhanced' },
        data: { dailyBuyLimit: cfg.kycLimitEnhancedDaily, dailySellLimit: cfg.kycLimitEnhancedDaily },
      }),
      db.user.updateMany({
        where: { kycStatus: 'approved', kycLevel: 'basic' },
        data: { dailyBuyLimit: cfg.kycLimitBasicDaily, dailySellLimit: cfg.kycLimitBasicDaily },
      }),
    ])

    log.info({ adminId, enhanced: enhanced.count, basic: basic.count }, 'KYC daily limits synced via admin endpoint')
    void createAuditLog(adminId, 'KYC_LIMITS_SYNCED', 'User', 'all', {
      enhanced: enhanced.count, basic: basic.count,
      enhancedLimit: cfg.kycLimitEnhancedDaily, basicLimit: cfg.kycLimitBasicDaily,
    })

    return reply.send({
      success: true,
      data: { updatedEnhanced: enhanced.count, updatedBasic: basic.count },
    })
  })

  // ── Referrals ──────────────────────────────────────────────────────────────

  app.get('/admin/referrals', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const query = req.query as Record<string, string>
    const { page, limit, skip } = paginationParams(query)
    const search = query.search?.trim()

    const where: Prisma.UserWhereInput = { referredById: { not: null } }
    if (search) {
      where.OR = [
        { username: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { referredBy: { username: { contains: search, mode: 'insensitive' } } },
        { referredBy: { email: { contains: search, mode: 'insensitive' } } },
      ]
    }

    const [referred, total] = await Promise.all([
      db.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          username: true,
          email: true,
          createdAt: true,
          kycStatus: true,
          kycLevel: true,
          referralCode: true,
          referredBy: { select: { id: true, username: true, email: true } },
          tradeStats: { select: { completedTrades: true, totalVolumePKR: true } },
          _count: { select: { trades: true, sellTrades: true, ctmBuyTrades: true, ctmSellTrades: true, referrals: true } },
        },
      }),
      db.user.count({ where }),
    ])

    const enriched = referred.map((u) => ({
      ...u,
      liveTradeCount: (u._count.trades ?? 0) + (u._count.sellTrades ?? 0) + (u._count.ctmBuyTrades ?? 0) + (u._count.ctmSellTrades ?? 0),
    }))

    return reply.send({ success: true, data: { referrals: enriched, total, pagination: { page, limit, total, pages: Math.ceil(total / limit) } } })
  })

  // GET /admin/referrals/top-inviters
  app.get('/admin/referrals/top-inviters', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const inviters = await db.user.findMany({
      where: { referrals: { some: {} } },
      select: {
        id: true,
        username: true,
        email: true,
        kycStatus: true,
        referralCode: true,
        _count: { select: { referrals: true } },
      },
      orderBy: { referrals: { _count: 'desc' } },
      take: 25,
    })
    return reply.send({ success: true, data: inviters })
  })

  // GET /admin/referrals/graph — nodes + edges of the whole referral network (for the
  // bubble-map view). Includes every user involved in a referral relationship (referred
  // someone OR was referred); an edge points from referrer → referred. Capped for safety.
  app.get('/admin/referrals/graph', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const users = await db.user.findMany({
      where: { OR: [{ referredById: { not: null } }, { referrals: { some: {} } }] },
      select: {
        id: true,
        username: true,
        kycStatus: true,
        referredById: true,
        _count: { select: { referrals: true } },
      },
      take: 2000,
    })
    const ids = new Set(users.map((u) => u.id))
    const nodes = users.map((u) => ({
      id: u.id,
      username: u.username,
      kycStatus: u.kycStatus,
      referrals: u._count.referrals,
      referredById: u.referredById,
    }))
    // Only keep edges whose referrer is also in the node set (it always is, via the OR).
    const edges = users
      .filter((u) => u.referredById && ids.has(u.referredById))
      .map((u) => ({ source: u.referredById as string, target: u.id }))
    return reply.send({ success: true, data: { nodes, edges } })
  })

  // GET /admin/referrals/by-country — user distribution by geo-IP country (for the
  // country-wise panel next to the network map). Includes an "Unknown" bucket for users
  // whose country hasn't been resolved yet.
  app.get('/admin/referrals/by-country', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const [grouped, total] = await Promise.all([
      db.user.groupBy({ by: ['countryCode', 'country'], _count: { _all: true } }),
      db.user.count(),
    ])
    const countries = grouped
      .map((g) => ({ country: g.country ?? 'Unknown', countryCode: g.countryCode ?? null, count: g._count._all }))
      .sort((a, b) => b.count - a.count)
    return reply.send({ success: true, data: { countries, total } })
  })

  // GET /admin/referrals/:userId — full chain for one user
  app.get('/admin/referrals/:userId', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { userId } = req.params as { userId: string }
    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        email: true,
        createdAt: true,
        kycStatus: true,
        referralCode: true,
        referredBy: { select: { id: true, username: true, email: true, referredBy: { select: { id: true, username: true, email: true } } } },
        referrals: {
          select: {
            id: true, username: true, email: true, createdAt: true, kycStatus: true,
            _count: { select: { trades: true, sellTrades: true, ctmBuyTrades: true, ctmSellTrades: true } },
            referrals: { select: { id: true, username: true, email: true, createdAt: true } },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    })
    if (!user) throw Errors.NOT_FOUND('User')
    return reply.send({ success: true, data: user })
  })

  // GET /admin/referrals/suspicious — same-IP clusters within referral relationships
  app.get('/admin/referrals/suspicious', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    // Find users who share registrationIp AND are in a referral relationship (one referred the other)
    const flagged = await db.$queryRaw<Array<{
      ip: string
      userIds: string[]
      usernames: string[]
      emails: string[]
      createdAts: Date[]
      referredByIds: (string | null)[]
    }>>`
      SELECT
        u."registrationIp" AS ip,
        array_agg(u.id ORDER BY u."createdAt") AS "userIds",
        array_agg(u.username ORDER BY u."createdAt") AS "usernames",
        array_agg(u.email ORDER BY u."createdAt") AS "emails",
        array_agg(u."createdAt" ORDER BY u."createdAt") AS "createdAts",
        array_agg(u."referredById" ORDER BY u."createdAt") AS "referredByIds"
      FROM "User" u
      WHERE u."registrationIp" IS NOT NULL
      GROUP BY u."registrationIp"
      HAVING COUNT(*) > 1
        AND COUNT(*) FILTER (WHERE u."referredById" IS NOT NULL) > 0
      ORDER BY COUNT(*) DESC
      LIMIT 200
    `

    // Filter: at least one user in the group is referred by another in the same group
    const suspicious = flagged.filter((group) => {
      const idSet = new Set(group.userIds)
      return group.referredByIds.some((rid) => rid && idSet.has(rid))
    })

    return reply.send({ success: true, data: suspicious })
  })

  // GET /admin/referrals/export — CSV download of all referred users
  app.get('/admin/referrals/export', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const users = await db.user.findMany({
      where: { referredById: { not: null } },
      select: {
        id: true,
        username: true,
        email: true,
        createdAt: true,
        kycStatus: true,
        kycLevel: true,
        referralCode: true,
        registrationIp: true,
        referredBy: { select: { id: true, username: true, email: true } },
        tradeStats: { select: { completedTrades: true, totalVolumePKR: true } },
      },
      orderBy: { createdAt: 'desc' },
    })

    const header = 'id,username,email,joined,kycStatus,kycLevel,referralCode,referrerId,referrerUsername,referrerEmail,completedTrades,totalVolumePKR,registrationIp'
    const rows = users.map((u) => [
      u.id,
      `"${u.username}"`,
      `"${u.email}"`,
      u.createdAt.toISOString(),
      u.kycStatus,
      u.kycLevel,
      u.referralCode,
      u.referredBy?.id ?? '',
      `"${u.referredBy?.username ?? ''}"`,
      `"${u.referredBy?.email ?? ''}"`,
      u.tradeStats?.completedTrades ?? 0,
      u.tradeStats?.totalVolumePKR?.toString() ?? '0',
      u.registrationIp ?? '',
    ].join(','))

    const csv = [header, ...rows].join('\n')
    reply.header('Content-Type', 'text/csv')
    reply.header('Content-Disposition', 'attachment; filename="referrals.csv"')
    return reply.send(csv)
  })

  // ── KYC ───────────────────────────────────────────────────────────────────

  app.get('/admin/kyc/queue', { preHandler: [authenticate, adminOrSuperOrKyc] }, async (req, reply) => {
    const query = req.query as Record<string, string>
    const { page, limit, skip } = paginationParams(query)

    // Filters — all optional. Omitting `status` (or 'all') returns every
    // submission regardless of review state so nothing is ever hidden.
    const where: Prisma.KycSubmissionWhereInput = {}

    const status = query.status
    if (status && status !== 'all' && ['pending', 'approved', 'rejected'].includes(status)) {
      where.status = status as Prisma.EnumKycStatusFilter
    }

    // The frontend tier tabs send `level`; accept `tier` too for robustness.
    const tier = query.tier || query.level
    if (tier && tier !== 'all' && ['basic', 'enhanced'].includes(tier)) {
      where.tier = tier as Prisma.EnumKycSubmissionTierFilter
    }

    const s = query.search?.trim()
    if (s) {
      where.user = {
        OR: [
          { email: { contains: s, mode: 'insensitive' } },
          { username: { contains: s, mode: 'insensitive' } },
        ],
      }
    }

    // Pending = work queue → oldest first (longest waiting). Otherwise show
    // the most recent submissions first.
    const orderBy: Prisma.KycSubmissionOrderByWithRelationInput =
      where.status === 'pending' ? { createdAt: 'asc' } : { createdAt: 'desc' }

    const [submissions, total] = await Promise.all([
      db.kycSubmission.findMany({
        where,
        orderBy,
        skip,
        take: limit,
        include: {
          user: { select: { id: true, email: true, username: true, fullName: true } },
        },
      }),
      db.kycSubmission.count({ where }),
    ])

    // Duplicate-CNIC detection: for each submission on this page, find OTHER
    // accounts that share the same CNIC hash (any status). Surfaced in the admin
    // review modal so the same identity can't be silently approved twice — the
    // permanent, zero-cost duplicate guard using the CNIC hash we already store.
    const pageHashes = [...new Set(submissions.map((s) => s.cnicNumberHash).filter(Boolean))] as string[]
    const dupRows = pageHashes.length
      ? await db.kycSubmission.findMany({
          where: { cnicNumberHash: { in: pageHashes } },
          select: {
            cnicNumberHash: true,
            userId: true,
            status: true,
            user: { select: { username: true, email: true } },
          },
        })
      : []
    const dupByHash = new Map<string, typeof dupRows>()
    for (const r of dupRows) {
      const arr = dupByHash.get(r.cnicNumberHash!) ?? []
      arr.push(r)
      dupByHash.set(r.cnicNumberHash!, arr)
    }
    const collectDuplicates = (hash: string | null, selfUserId: string) => {
      if (!hash) return []
      const seen = new Set<string>()
      return (dupByHash.get(hash) ?? [])
        .filter((r) => r.userId !== selfUserId)
        .filter((r) => { if (seen.has(r.userId)) return false; seen.add(r.userId); return true })
        .map((r) => ({ userId: r.userId, username: r.user?.username ?? null, email: r.user?.email ?? null, status: r.status }))
    }

    // KYC documents are stored as authenticated Cloudinary assets — sign the
    // delivery URLs so the reviewer's browser can actually load them.
    const signed = submissions.map((s) => ({
      ...s,
      frontUrl: signCloudinaryDeliveryUrl(s.frontUrl),
      backUrl: signCloudinaryDeliveryUrl(s.backUrl),
      selfieUrl: signCloudinaryDeliveryUrl(s.selfieUrl),
      videoUrl: signCloudinaryDeliveryUrl(s.videoUrl),
      cnicDuplicates: collectDuplicates(s.cnicNumberHash, s.userId),
    }))

    return reply.send({
      success: true,
      data: { submissions: signed, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
    })
  })

  app.get('/admin/kyc/:id', { preHandler: [authenticate, adminOrSuperOrKyc] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const submission = await db.kycSubmission.findUnique({
      where: { id },
      include: { user: { select: { id: true, email: true, username: true, fullName: true, kycStatus: true, kycLevel: true } } },
    })
    if (!submission) throw Errors.NOT_FOUND('KYC submission')

    // Other accounts sharing this CNIC hash (duplicate-identity guard).
    const dupRows = submission.cnicNumberHash
      ? await db.kycSubmission.findMany({
          where: { cnicNumberHash: submission.cnicNumberHash, userId: { not: submission.userId } },
          select: { userId: true, status: true, user: { select: { username: true, email: true } } },
        })
      : []
    const seenDup = new Set<string>()
    const cnicDuplicates = dupRows
      .filter((r) => { if (seenDup.has(r.userId)) return false; seenDup.add(r.userId); return true })
      .map((r) => ({ userId: r.userId, username: r.user?.username ?? null, email: r.user?.email ?? null, status: r.status }))

    return reply.send({
      success: true,
      data: {
        ...submission,
        frontUrl: signCloudinaryDeliveryUrl(submission.frontUrl),
        backUrl: signCloudinaryDeliveryUrl(submission.backUrl),
        selfieUrl: signCloudinaryDeliveryUrl(submission.selfieUrl),
        videoUrl: signCloudinaryDeliveryUrl(submission.videoUrl),
        cnicDuplicates,
      },
    })
  })

  // Stream a KYC document through our own API origin. KYC docs are stored as
  // authenticated (private) Cloudinary assets, whose signed delivery URLs can be
  // blocked when loaded directly by the reviewer's browser (CSP / cross-site).
  // Fetching the bytes server-side and streaming them from our origin makes the
  // documents always render — the permanent fix for "KYC images not visible".
  app.get('/admin/kyc/:id/doc/:kind', { preHandler: [authenticate, adminOrSuperOrKyc] }, async (req, reply) => {
    const { id, kind } = req.params as { id: string; kind: string }
    const FIELD: Record<string, 'frontUrl' | 'backUrl' | 'selfieUrl' | 'videoUrl'> = {
      front: 'frontUrl', back: 'backUrl', selfie: 'selfieUrl', video: 'videoUrl',
    }
    const field = FIELD[kind]
    if (!field) throw new AppError('VALIDATION_ERROR', 'Invalid document kind', 400)

    const submission = await db.kycSubmission.findUnique({
      where: { id },
      select: { frontUrl: true, backUrl: true, selfieUrl: true, videoUrl: true },
    })
    if (!submission) throw Errors.NOT_FOUND('KYC submission')

    const storedUrl = submission[field]
    if (!storedUrl) throw Errors.NOT_FOUND('Document')

    const asset = await fetchCloudinaryAsset(storedUrl)
    if (!asset) {
      throw new AppError('UPSTREAM_ERROR', 'Could not load the document from storage', 502)
    }

    reply.header('Content-Type', asset.contentType)
    reply.header('Cache-Control', 'private, max-age=300')
    reply.header('Content-Disposition', 'inline')
    return reply.send(asset.buffer)
  })

  app.post('/admin/kyc/:id/approve', { preHandler: [authenticate, adminOrSuperOrKyc], config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const submission = await db.kycSubmission.findUnique({
      where: { id },
      include: { user: { select: { email: true } } },
    })
    if (!submission) throw Errors.NOT_FOUND('KYC submission')
    if (submission.status !== 'pending') {
      throw new AppError('INVALID_STATUS', 'Submission is not pending', 400)
    }

    // Hard guard: never approve a CNIC that is already verified on a DIFFERENT
    // account. This is the safety net for a reviewer approving many KYCs in a
    // row — a duplicate CNIC can't slip through even if it's visually missed.
    if (submission.cnicNumberHash) {
      const conflict = await db.kycSubmission.findFirst({
        where: {
          cnicNumberHash: submission.cnicNumberHash,
          status: 'approved',
          userId: { not: submission.userId },
        },
        include: { user: { select: { username: true, email: true } } },
      })
      if (conflict) {
        const who = conflict.user?.username || conflict.user?.email || conflict.userId
        throw new AppError(
          'CNIC_DUPLICATE',
          `This CNIC is already verified on another account (${who}). Reject this submission instead of approving it.`,
          409,
        )
      }
    }

    const kycLevel = submission.tier === 'enhanced' ? 'enhanced' : 'basic'

    // Apply the tier's daily transaction limit so Enhanced KYC actually grants
    // higher limits (single source of truth: platform config, with safe defaults).
    const cfg = await getPublicConfig()
    const dailyLimit = kycLevel === 'enhanced' ? cfg.kycLimitEnhancedDaily : cfg.kycLimitBasicDaily

    // Non-custodial mode: on approval, lock the user's display name to the CNIC
    // legal name so it is canonical everywhere and can no longer be self-edited.
    // Flag OFF (default) leaves the name untouched, preserving current behavior.
    const nonCustodial = await isFlagEnabled(FLAGS.NONCUSTODIAL_P2P)
    const lockLegalName = nonCustodial && !!submission.legalName?.trim()

    await db.$transaction(async (tx) => {
      await tx.kycSubmission.update({
        where: { id },
        data: { status: 'approved', reviewedAt: new Date(), reviewedBy: req.user!.id },
      })
      await tx.user.update({
        where: { id: submission.userId },
        data: {
          kycStatus: 'approved',
          kycLevel,
          dailyBuyLimit: dailyLimit,
          dailySellLimit: dailyLimit,
          ...(lockLegalName
            ? { fullName: submission.legalName!.trim(), legalNameLockedAt: new Date() }
            : {}),
        },
      })
    })

    // Promote the submission's social links to the user's permanent VERIFIED set
    // (they can hide but never delete these). Best-effort — never blocks approval.
    try {
      const submitted = Array.isArray(submission.socialLinks)
        ? (submission.socialLinks as Array<{ platform?: unknown; url?: unknown }>)
            .filter((l) => typeof l?.platform === 'string' && typeof l?.url === 'string')
            .map((l) => ({ platform: l.platform as string, url: l.url as string }))
        : []
      await mergeVerifiedFromKyc(submission.userId, submitted)
    } catch { /* best-effort — social sync must not fail approval */ }

    await createAuditLog(req.user!.id, 'KYC_APPROVED', 'KycSubmission', id, { userId: submission.userId, level: kycLevel }, clientIp(req), req.headers['user-agent'] as string | undefined)
    await sendKycEmail('approved', submission.user.email, { level: kycLevel })
    notify(submission.userId, 'kyc', 'KYC Approved', 'Your identity has been verified. You now have full platform access.', { tier: kycLevel })

    return reply.send({ success: true })
  })

  app.post('/admin/kyc/:id/reject', { preHandler: [authenticate, adminOrSuperOrKyc], config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const bodySchema = z.object({ reason: z.string().min(1).max(500) })
    const parsed = bodySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    const submission = await db.kycSubmission.findUnique({
      where: { id },
      include: { user: { select: { email: true } } },
    })
    if (!submission) throw Errors.NOT_FOUND('KYC submission')

    await db.kycSubmission.update({
      where: { id },
      data: { status: 'rejected', rejectionReason: parsed.data.reason, reviewedAt: new Date(), reviewedBy: req.user!.id },
    })
    await db.user.update({
      where: { id: submission.userId },
      data: { kycStatus: 'rejected' },
    })

    await createAuditLog(req.user!.id, 'KYC_REJECTED', 'KycSubmission', id, { reason: parsed.data.reason }, clientIp(req), req.headers['user-agent'] as string | undefined)
    await sendKycEmail('rejected', submission.user.email, { reason: parsed.data.reason })
    notify(submission.userId, 'kyc', 'KYC Rejected', `Your KYC submission was rejected. Reason: ${parsed.data.reason}`, { rejectionReason: parsed.data.reason })

    return reply.send({ success: true })
  })

  // ── Merchant KYC ───────────────────────────────────────────────────────────

  app.get('/admin/merchants/queue', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const query = req.query as Record<string, string>
    const { page, limit, skip } = paginationParams(query)

    const [submissions, total] = await Promise.all([
      db.merchantKycSubmission.findMany({
        where: { status: 'pending' },
        orderBy: { createdAt: 'asc' },
        skip,
        take: limit,
      }),
      db.merchantKycSubmission.count({ where: { status: 'pending' } }),
    ])

    return reply.send({
      success: true,
      data: { submissions, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
    })
  })

  app.post('/admin/merchants/:id/approve', { preHandler: [authenticate, adminOrSuper], config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const submission = await db.merchantKycSubmission.findUnique({ where: { id } })
    if (!submission) throw Errors.NOT_FOUND('Merchant KYC submission')

    const user = await db.user.findUnique({ where: { id: submission.userId }, select: { email: true } })
    if (!user) throw Errors.NOT_FOUND('User')

    await db.merchantKycSubmission.update({
      where: { id },
      data: { status: 'approved', reviewedAt: new Date(), reviewedBy: req.user!.id },
    })
    await db.merchant.upsert({
      where: { userId: submission.userId },
      create: {
        userId: submission.userId,
        businessName: submission.businessName,
        status: 'approved',
        approvedAt: new Date(),
      },
      update: {
        businessName: submission.businessName,
        status: 'approved',
        approvedAt: new Date(),
      },
    })

    await createAuditLog(req.user!.id, 'MERCHANT_KYC_APPROVED', 'MerchantKycSubmission', id, { userId: submission.userId }, clientIp(req), req.headers['user-agent'] as string | undefined)
    await sendKycEmail('merchant_approved', user.email)

    return reply.send({ success: true })
  })

  app.post('/admin/merchants/:id/reject', { preHandler: [authenticate, adminOrSuper], config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const bodySchema = z.object({ reason: z.string().min(1).max(500) })
    const parsed = bodySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    const submission = await db.merchantKycSubmission.findUnique({ where: { id } })
    if (!submission) throw Errors.NOT_FOUND('Merchant KYC submission')

    const user = await db.user.findUnique({ where: { id: submission.userId }, select: { email: true } })

    await db.merchantKycSubmission.update({
      where: { id },
      data: { status: 'rejected', rejectionReason: parsed.data.reason, reviewedAt: new Date(), reviewedBy: req.user!.id },
    })

    await createAuditLog(req.user!.id, 'MERCHANT_KYC_REJECTED', 'MerchantKycSubmission', id, { reason: parsed.data.reason }, clientIp(req), req.headers['user-agent'] as string | undefined)
    if (user) await sendKycEmail('merchant_rejected', user.email, { reason: parsed.data.reason })

    return reply.send({ success: true })
  })

  // ── Trades ─────────────────────────────────────────────────────────────────

  app.get('/admin/trades', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const query = req.query as Record<string, string>
    const { page, limit, skip } = paginationParams(query)

    const where: Prisma.TradeWhereInput = {}
    if (query.status && query.status !== 'all') where.status = query.status as Prisma.EnumTradeStatusFilter
    if (query.coin) where.coin = { equals: query.coin.toUpperCase() }
    if (query.dateFrom || query.dateTo) {
      where.createdAt = {
        ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
        ...(query.dateTo ? { lte: new Date(query.dateTo + 'T23:59:59') } : {}),
      }
    }
    if (query.search) {
      const s = query.search.trim()
      where.OR = [
        { id: { contains: s, mode: 'insensitive' } },
        { orderRef: { contains: s, mode: 'insensitive' } },
        { coin: { contains: s, mode: 'insensitive' } },
        { buyer: { username: { contains: s, mode: 'insensitive' } } },
        { buyer: { email: { contains: s, mode: 'insensitive' } } },
        { seller: { username: { contains: s, mode: 'insensitive' } } },
        { seller: { email: { contains: s, mode: 'insensitive' } } },
      ]
    }

    const [trades, total] = await Promise.all([
      db.trade.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          buyer: { select: { username: true, email: true } },
          seller: { select: { username: true, email: true } },
          dispute: { select: { id: true, status: true } },
        },
      }),
      db.trade.count({ where }),
    ])

    return reply.send({
      success: true,
      data: { trades, total, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
    })
  })

  // GET /admin/trades/:id — full trade detail for admin investigation
  app.get('/admin/trades/:id', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const trade = await db.trade.findUnique({
      where: { id },
      include: {
        buyer: { select: { id: true, username: true, email: true, kycStatus: true, kycLevel: true } },
        seller: { select: { id: true, username: true, email: true, kycStatus: true, kycLevel: true } },
        messages: { orderBy: { createdAt: 'asc' }, select: { id: true, senderId: true, message: true, attachmentUrl: true, createdAt: true } },
        dispute: {
          include: {
            messages: { orderBy: { createdAt: 'asc' }, select: { id: true, senderId: true, message: true, createdAt: true } },
          },
        },
        ratings: { select: { id: true, rating: true, comment: true, ratedByUserId: true, createdAt: true } },
        ad: { select: { id: true, side: true, price: true, paymentMethods: true, coin: true, network: true } },
      },
    })
    if (!trade) throw Errors.NOT_FOUND('Trade')

    // Admin audit trail for this trade (by id or order ref) — powers the
    // investigation timeline + audit log sections.
    const auditLogs = await db.auditLog.findMany({
      where: { targetType: { in: ['Trade', 'trade'] }, OR: [{ targetId: id }, { targetId: trade.orderRef }] },
      orderBy: { createdAt: 'desc' }, take: 100,
      select: { id: true, action: true, actorId: true, ipAddress: true, metadata: true, createdAt: true },
    })

    return reply.send({ success: true, data: { ...trade, auditLogs } })
  })

  app.post('/admin/trades/:id/confirm-payment', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const trade = await db.trade.findUnique({ where: { id } })
    if (!trade) throw Errors.NOT_FOUND('Trade')

    await db.trade.update({
      where: { id },
      data: { status: 'payment_confirmed' },
    })
    await createAuditLog(req.user!.id, 'TRADE_PAYMENT_CONFIRMED_ADMIN', 'Trade', id, {}, clientIp(req), req.headers['user-agent'] as string | undefined)

    return reply.send({ success: true })
  })

  app.post('/admin/trades/:id/cancel', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const bodySchema = z.object({ reason: z.string().min(1).max(500) })
    const parsed = bodySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    await db.trade.update({
      where: { id },
      data: { status: 'cancelled', cancelReason: parsed.data.reason, cancelledBy: req.user!.id, cancelledAt: new Date() },
    })
    await createAuditLog(req.user!.id, 'TRADE_CANCELLED_ADMIN', 'Trade', id, { reason: parsed.data.reason }, clientIp(req), req.headers['user-agent'] as string | undefined)

    // Neutral admin cancel → return the maker's bond. (To penalise a maker the
    // admin resolves a dispute against them instead, which seizes the bond.)
    await releaseMakerBond({ tradeType: 'usdt', tradeId: id })
      .catch((err) => log.error({ err, tradeId: id }, 'Failed to release maker bond on admin cancel'))

    return reply.send({ success: true })
  })

  // POST /admin/trades/:id/approve-tx-verification
  // Manually approve a pending tx hash for chains we cannot verify automatically
  // (non-EVM) or when our RPC was unavailable. Unlocks the buyer's release button.
  app.post('/admin/trades/:id/approve-tx-verification', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const bodySchema = z.object({
      reason: z.string().min(5).max(500),
    })
    const parsed = bodySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'reason required', 400)

    const trade = await db.trade.findUnique({
      where: { id },
      select: { id: true, status: true, txVerificationStatus: true, sellerTxHash: true, orderRef: true },
    })
    if (!trade) throw Errors.NOT_FOUND('Trade')
    if (trade.status !== 'crypto_sent') {
      throw new AppError('INVALID_STATUS', `Trade must be in crypto_sent status to approve verification (current: ${trade.status})`, 400)
    }
    const allowedToApprove = ['skipped', 'rpc_error', 'pending', 'not_found']
    if (trade.txVerificationStatus && !allowedToApprove.includes(trade.txVerificationStatus)) {
      throw new AppError('INVALID_STATUS', `Trade txVerificationStatus is "${trade.txVerificationStatus}" — only skipped/rpc_error/pending/not_found can be admin-approved`, 400)
    }

    await db.trade.update({
      where: { id },
      data: {
        txVerificationStatus: 'admin_verified',
        txVerificationDetails: {
          adminVerifiedBy: req.user!.id,
          adminVerifiedAt: new Date().toISOString(),
          adminReason: parsed.data.reason,
          previousStatus: trade.txVerificationStatus,
        },
      },
    })
    await createAuditLog(req.user!.id, 'TRADE_TX_VERIFICATION_APPROVED', 'Trade', id, {
      sellerTxHash: trade.sellerTxHash,
      previousStatus: trade.txVerificationStatus,
      reason: parsed.data.reason,
    }, clientIp(req), req.headers['user-agent'] as string | undefined)

    log.info({ tradeId: id, adminId: req.user!.id, orderRef: trade.orderRef }, 'Admin approved tx verification — buyer can now release')
    return reply.send({ success: true, message: 'Transaction verification approved. Buyer can now release the trade.' })
  })

  // ── Disputes ───────────────────────────────────────────────────────────────

  app.get('/admin/disputes', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const query = req.query as Record<string, string>
    const { page, limit, skip } = paginationParams(query)

    const where: Record<string, unknown> = {}
    if (query.status && query.status !== 'all') {
      if (query.status === 'open') {
        where.status = { in: ['open', 'escalated'] }
      } else {
        where.status = query.status
      }
    }

    const [disputes, total] = await Promise.all([
      db.dispute.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip,
        take: limit,
        include: {
          trade: {
            include: {
              buyer: { select: { id: true, username: true, email: true, tradeStats: { select: { disputesWon: true, disputesLost: true } } } },
              seller: { select: { id: true, username: true, email: true, tradeStats: { select: { disputesWon: true, disputesLost: true } } } },
              messages: { orderBy: { createdAt: 'asc' }, select: { id: true, senderId: true, message: true, createdAt: true } },
              ad: { select: { side: true } },
            },
          },
          messages: { orderBy: { createdAt: 'asc' } },
          _count: { select: { messages: true } },
        },
      }),
      db.dispute.count({ where }),
    ])

    // Resolve openedBy user for each dispute
    const openedByIds = [...new Set(disputes.map((d) => d.openedById).filter(Boolean))]
    const openedByUsers = openedByIds.length > 0
      ? await db.user.findMany({ where: { id: { in: openedByIds as string[] } }, select: { id: true, username: true, email: true } })
      : []
    const openedByMap = Object.fromEntries(openedByUsers.map((u) => [u.id, u]))

    const enriched = disputes.map((d) => ({
      ...d,
      openedBy: openedByMap[d.openedById] ?? null,
    }))

    return reply.send({
      success: true,
      data: { disputes: enriched, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
    })
  })

  app.get('/admin/disputes/:id', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const dispute = await db.dispute.findUnique({
      where: { id },
      include: {
        trade: {
          include: {
            buyer: { select: { id: true, username: true, email: true, tradeStats: { select: { disputesWon: true, disputesLost: true } } } },
            seller: { select: { id: true, username: true, email: true, tradeStats: { select: { disputesWon: true, disputesLost: true } } } },
            messages: { orderBy: { createdAt: 'asc' }, select: { id: true, senderId: true, message: true, createdAt: true } },
            ad: { select: { side: true } },
          },
        },
        messages: { orderBy: { createdAt: 'asc' } },
      },
    })
    if (!dispute) throw Errors.NOT_FOUND('Dispute')
    const openedBy = dispute.openedById
      ? await db.user.findUnique({ where: { id: dispute.openedById }, select: { id: true, username: true, email: true } })
      : null
    return reply.send({ success: true, data: { ...dispute, openedBy } })
  })

  // Close a dispute without picking a winner
  app.post('/admin/disputes/:id/close', { preHandler: [authenticate, adminOrSuper], config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const bodySchema = z.object({ note: z.string().min(1).max(2000) })
    const parsed = bodySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    const dispute = await db.dispute.findUnique({ where: { id } })
    if (!dispute) throw Errors.NOT_FOUND('Dispute')
    if (dispute.status === 'resolved') throw new AppError('ALREADY_RESOLVED', 'Dispute is already resolved', 400)

    await db.dispute.update({
      where: { id },
      data: { status: 'resolved', resolution: parsed.data.note, resolvedAt: new Date(), resolvedBy: req.user!.id },
    })
    await createAuditLog(req.user!.id, 'DISPUTE_CLOSED', 'Dispute', id, { note: parsed.data.note }, clientIp(req), req.headers['user-agent'] as string | undefined)

    // Closed without a winner = no fault assigned → return the maker's bond
    // (idempotent; no-op when bonds are off or none was held). Without this the
    // bond would stay locked forever on a no-winner close.
    await releaseMakerBond({ tradeType: 'usdt', tradeId: dispute.tradeId })
      .catch((err) => log.error({ err, tradeId: dispute.tradeId }, 'Failed to release maker bond on dispute close'))

    return reply.send({ success: true })
  })

  // Add admin note to dispute (as a DisputeMessage from the admin)
  app.post('/admin/disputes/:id/note', { preHandler: [authenticate, adminOrSuper], config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const bodySchema = z.object({ note: z.string().min(1).max(2000) })
    const parsed = bodySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    const dispute = await db.dispute.findUnique({ where: { id } })
    if (!dispute) throw Errors.NOT_FOUND('Dispute')

    await db.disputeMessage.create({
      data: { disputeId: id, senderId: req.user!.id, message: `[Admin Note] ${parsed.data.note}` },
    })
    await createAuditLog(req.user!.id, 'DISPUTE_NOTE_ADDED', 'Dispute', id, { note: parsed.data.note }, clientIp(req), req.headers['user-agent'] as string | undefined)
    return reply.send({ success: true })
  })

  app.post('/admin/disputes/:id/resolve', { preHandler: [authenticate, adminOrSuper], config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const bodySchema = z.object({
      winner: z.enum(['buyer', 'seller']),
      resolution: z.string().min(1).max(2000),
      resolutionNote: z.string().max(2000).optional(),
      // Optional escalation against the losing party. Defaults to 'none' so the
      // existing resolve behavior is unchanged.
      loserPenalty: z.enum(['none', 'review', 'ban']).default('none'),
    })
    const parsed = bodySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    const dispute = await db.dispute.findUnique({
      where: { id },
      include: {
        trade: {
          include: {
            buyer: { select: { id: true, email: true } },
            seller: { select: { id: true, email: true } },
          },
        },
      },
    })
    if (!dispute) throw Errors.NOT_FOUND('Dispute')
    if (dispute.status === 'resolved') {
      throw new AppError('ALREADY_RESOLVED', 'Dispute is already resolved', 400)
    }

    const winnerId = parsed.data.winner === 'buyer' ? dispute.trade.buyer.id : dispute.trade.seller.id
    const loserId  = parsed.data.winner === 'buyer' ? dispute.trade.seller.id : dispute.trade.buyer.id
    let loserLossCount = 0

    await db.$transaction(async (tx) => {
      await tx.dispute.update({
        where: { id },
        data: {
          status: 'resolved',
          winner: parsed.data.winner,
          resolution: parsed.data.resolution,
          resolvedAt: new Date(),
          resolvedBy: req.user!.id,
        },
      })
      // Move the trade to its terminal "dispute_resolved" state so it stops showing
      // as "Disputed" forever (and the reduced concurrency cap lifts). The platform
      // never moves funds — parties settle directly per the ruling.
      await tx.trade.update({ where: { id: dispute.tradeId }, data: { status: 'dispute_resolved' } })
      // Increment dispute win/loss counts for both parties
      await tx.tradeStats.upsert({
        where: { userId: winnerId },
        create: { userId: winnerId, disputesWon: 1 },
        update: { disputesWon: { increment: 1 } },
      })
      const loserStats = await tx.tradeStats.upsert({
        where: { userId: loserId },
        create: { userId: loserId, disputesLost: 1 },
        update: { disputesLost: { increment: 1 } },
      })
      loserLossCount = loserStats.disputesLost
    })

    await createAuditLog(req.user!.id, 'DISPUTE_RESOLVED', 'Dispute', id, {
      winner: parsed.data.winner,
      resolution: parsed.data.resolution,
    }, clientIp(req), req.headers['user-agent'] as string | undefined)

    // Maker collateral bond (Phase 5): seize to the winner if the maker lost,
    // else release. Idempotent + no-op when bonds are off or none was held.
    // Outside the resolve tx — a bond hiccup must never block the ruling.
    await resolveBondOnDispute({ tradeType: 'usdt', tradeId: dispute.tradeId, loserId, winnerId })
      .catch((err) => log.error({ err, tradeId: dispute.tradeId }, 'Failed to resolve maker bond on dispute'))

    // Airdrop clawback: if the trade had already completed and awarded points, pull
    // back the LOSER's points (and any referral override earned on them). No-op when
    // airdrop is off or the trade never completed (the usual case). Best-effort.
    await clawbackTradePoints('usdt', dispute.tradeId, 'dispute_lost', loserId)
      .catch((err) => log.error({ err, tradeId: dispute.tradeId }, 'Failed to claw back airdrop points on dispute'))

    // Optional escalation against the losing party, via the proper moderation
    // pipeline (so it shows up in ModerationAction history like a normal ban).
    if (parsed.data.loserPenalty !== 'none') {
      const loser = await db.user.findUnique({ where: { id: loserId }, select: MODERATION_SELECT })
      if (loser) {
        const prevStatus = computeModerationStatus(loser)
        const penaltyReason = `Lost dispute on trade ${dispute.trade.orderRef}`
        if (parsed.data.loserPenalty === 'ban') {
          await db.user.update({
            where: { id: loserId },
            data: { isBanned: true, banType: 'permanent', bannedUntil: null, moderationReason: penaltyReason, suspendReason: penaltyReason },
          })
          await recordModerationAction({ targetUserId: loserId, moderatorId: req.user!.id, action: 'ban_permanent', reason: penaltyReason, previousStatus: prevStatus, newStatus: 'permanently_banned', durationLabel: 'Permanent' })
          notifyModeration(loserId, 'Account banned', `Your account has been permanently banned. Reason: ${penaltyReason}`, { action: 'ban', reason: penaltyReason })
        } else {
          await db.user.update({ where: { id: loserId }, data: { underReview: true } })
          await recordModerationAction({ targetUserId: loserId, moderatorId: req.user!.id, action: 'flag_review', reason: penaltyReason, previousStatus: prevStatus, newStatus: computeModerationStatus({ ...loser, underReview: true }) })
        }
        await createAuditLog(req.user!.id, 'DISPUTE_LOSER_PENALTY', 'User', loserId, { penalty: parsed.data.loserPenalty, disputeId: id }, clientIp(req), req.headers['user-agent'] as string | undefined)
      }
    }

    // ── Automatic dispute-loss strike escalation ─────────────────────────────────
    // Graduated, NON-destructive consequence based on how many disputes the loser
    // has now lost. We only ever apply a trading cooldown (blocks STARTING new
    // trades — does not lock the account) and an under-review flag. Permanent /
    // temporary bans stay an explicit admin decision (loserPenalty:'ban' above), so
    // a single bad ruling can never auto-lock someone out. Skipped when the admin
    // already chose to ban the loser.
    if (parsed.data.loserPenalty !== 'ban' && loserLossCount > 0) {
      let cooldownHours = 0
      let flagReview = false
      let tierMsg = ''
      if (loserLossCount === 1) {
        tierMsg = 'This is your first dispute loss — consider it a formal warning.'
      } else if (loserLossCount === 2) {
        cooldownHours = 48
        tierMsg = 'Second dispute loss — a 48-hour trading cooldown has been applied.'
      } else if (loserLossCount === 3) {
        cooldownHours = 168
        flagReview = true
        tierMsg = 'Third dispute loss — a 7-day trading cooldown has been applied and your account is under review.'
      } else {
        cooldownHours = 168
        flagReview = true
        tierMsg = `You have now lost ${loserLossCount} disputes — your account is under review and may be suspended.`
      }

      if (cooldownHours > 0 || flagReview) {
        await db.user.update({
          where: { id: loserId },
          data: {
            ...(cooldownHours > 0 ? { tradeCooldownUntil: new Date(Date.now() + cooldownHours * 3600 * 1000) } : {}),
            ...(flagReview ? { underReview: true } : {}),
          },
        }).catch((err) => log.error({ err, loserId }, 'Failed to apply dispute-loss strike escalation'))
        await createAuditLog(req.user!.id, 'DISPUTE_LOSS_STRIKE', 'User', loserId, { lossCount: loserLossCount, cooldownHours, flagReview, disputeId: id }, clientIp(req), req.headers['user-agent'] as string | undefined)
      }
      notify(loserId, 'dispute', `Dispute strike #${loserLossCount}`, tierMsg, { tradeId: dispute.tradeId }, dispute.tradeId)
    }

    // Notify both parties of the ruling. Non-custodial: the platform never moves
    // funds — the parties settle directly per the ruling.
    notify(winnerId, 'dispute', 'Dispute Resolved', `The dispute on trade #${dispute.trade.orderRef} was resolved in your favour. The platform does not move funds — settle directly with your counterparty per the ruling.`, { tradeId: dispute.tradeId }, dispute.tradeId)
    notify(loserId, 'dispute', 'Dispute Resolved', `The dispute on trade #${dispute.trade.orderRef} was resolved in favour of the other party. Resolution: ${parsed.data.resolution}`, { tradeId: dispute.tradeId }, dispute.tradeId)

    // Record the resolution as an admin notification (both parties already
    // notified above). No Telegram DM — the acting admin just performed this.
    await import('../services/adminNotification.service').then(({ createAdminNotif }) =>
      createAdminNotif({
        category: 'DISPUTE',
        title: `Dispute ${id} resolved`,
        body: `Trade: ${dispute.trade.orderRef}\nWinner: ${parsed.data.winner}\nResolution: ${parsed.data.resolution}\nLoser penalty: ${parsed.data.loserPenalty}`,
        href: '/admin/disputes',
        telegram: false,
      }),
    )

    return reply.send({ success: true })
  })

  // ── Instant Buy ────────────────────────────────────────────────────────────

  app.get('/admin/instant-buy', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const query = req.query as Record<string, string>
    const { page, limit, skip } = paginationParams(query)

    const where: Record<string, unknown> = {}
    if (query.status) where.status = query.status

    const [orders, total] = await Promise.all([
      db.instantBuyOrder.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          user: { select: { username: true, email: true } },
        },
      }),
      db.instantBuyOrder.count({ where }),
    ])

    return reply.send({
      success: true,
      data: { orders, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
    })
  })

  app.get('/admin/instant-buy/:id', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const order = await db.instantBuyOrder.findUnique({
      where: { id },
      include: { user: { select: { id: true, username: true, email: true } } },
    })
    if (!order) throw Errors.NOT_FOUND('Instant buy order')
    return reply.send({ success: true, data: order })
  })

  app.post('/admin/instant-buy/:id/approve', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const bodySchema = z.object({ txHash: z.string().min(1) })
    const parsed = bodySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    await db.instantBuyOrder.update({
      where: { id },
      data: { status: 'completed', verificationStatus: 'layer2_approved', incomingTxHash: parsed.data.txHash },
    })
    await createAuditLog(req.user!.id, 'INSTANT_BUY_APPROVED', 'InstantBuyOrder', id, { txHash: parsed.data.txHash }, clientIp(req), req.headers['user-agent'] as string | undefined)

    return reply.send({ success: true })
  })

  app.post('/admin/instant-buy/:id/reject', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const bodySchema = z.object({ reason: z.string().min(1).max(500) })
    const parsed = bodySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    const order = await db.instantBuyOrder.findUnique({
      where: { id },
      include: { user: { select: { email: true } } },
    })
    if (!order) throw Errors.NOT_FOUND('Order')

    await db.instantBuyOrder.update({
      where: { id },
      data: { status: 'rejected', verificationStatus: 'layer2_rejected', rejectionReason: parsed.data.reason },
    })
    await createAuditLog(req.user!.id, 'INSTANT_BUY_REJECTED', 'InstantBuyOrder', id, { reason: parsed.data.reason }, clientIp(req), req.headers['user-agent'] as string | undefined)

    return reply.send({ success: true })
  })

  // ── Withdrawals ────────────────────────────────────────────────────────────

  // GET /admin/moralis-streams/status — per-chain stream config + counts +
  // reachability check. Lets ops see at a glance which chains are wired up,
  // how many addresses are subscribed/pending/failed, and whether the
  // Moralis API answered on the latest probe.
  app.get('/admin/moralis-streams/status', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const summary = await getStreamStatusSummary()
    return reply.send({ success: true, data: summary })
  })

  // GET /admin/moralis-streams/subscriptions — paginated subscription rows.
  // Useful for inspecting "what's stuck in failed".
  app.get('/admin/moralis-streams/subscriptions', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const query = req.query as Record<string, string>
    const { page, limit, skip } = paginationParams(query)
    const where: Record<string, unknown> = {}
    if (query.status) where.status = query.status
    if (query.chain) where.chain = query.chain
    const [subscriptions, total] = await Promise.all([
      db.moralisStreamSubscription.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip,
        take: limit,
        include: {
          depositAddress: {
            select: {
              address: true,
              user: { select: { id: true, username: true, email: true } },
            },
          },
        },
      }),
      db.moralisStreamSubscription.count({ where }),
    ])
    return reply.send({
      success: true,
      data: { subscriptions, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
    })
  })

  // POST /admin/moralis-streams/backfill — walk all existing DepositAddress
  // rows, create any missing MoralisStreamSubscription rows, and enqueue
  // subscribe jobs for everything that's pending. Idempotent. Returns 202
  // immediately and runs in the background — operator polls /status to watch
  // it complete. Safe to call repeatedly (e.g. after adding a new chain).
  app.post('/admin/moralis-streams/backfill', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const adminId = req.user!.id
    const total = await db.depositAddress.count({ where: { chainFamily: 'EVM' } })
    const runId = randomUUID()

    log.info({ runId, adminId, totalRows: total }, 'Moralis backfill started via admin endpoint')

    // Fire-and-forget. We don't await — operator gets an immediate 202 with
    // the row count to expect, and the work proceeds asynchronously while
    // /admin/moralis-streams/status reflects progress in real time. Errors
    // on individual rows are logged and counted but never abort the loop —
    // a single problematic address must not block the rest of the backfill.
    ;(async () => {
      const batchSize = 100
      let cursor: string | undefined
      let scanned = 0
      let perAddressErrors = 0
      let enqueuedJobs = 0
      const startedAt = Date.now()
      try {
        for (;;) {
          const batch = await db.depositAddress.findMany({
            where: { chainFamily: 'EVM' },
            orderBy: { createdAt: 'asc' },
            take: batchSize,
            ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
            select: { id: true },
          })
          if (batch.length === 0) break
          for (const da of batch) {
            try {
              await ensureSubscriptionRows(da.id)
              const pending = await db.moralisStreamSubscription.count({
                where: { depositAddressId: da.id, status: 'pending' },
              })
              await enqueuePendingSubscriptions(da.id)
              enqueuedJobs += pending
              scanned += 1
            } catch (rowErr) {
              perAddressErrors += 1
              log.error(
                { runId, depositAddressId: da.id, err: rowErr instanceof Error ? rowErr.message : 'unknown' },
                'Backfill failed for one address — continuing',
              )
            }
          }
          cursor = batch[batch.length - 1]!.id
          log.info({ runId, scanned, total, enqueuedJobs, perAddressErrors }, 'Backfill batch complete')
        }
      } catch (err) {
        log.error({ runId, err: err instanceof Error ? err.message : 'unknown' }, 'Moralis backfill aborted')
      }
      log.info(
        { runId, scanned, total, enqueuedJobs, perAddressErrors, elapsedMs: Date.now() - startedAt },
        'Moralis backfill complete',
      )
    })()

    void createAuditLog(adminId, 'MORALIS_STREAMS_BACKFILL_STARTED', 'MoralisStreamSubscription', 'all', { total, runId })
    return reply.code(202).send({
      success: true,
      data: {
        runId,
        startedFor: total,
        message: 'Backfill running in background. Poll /admin/moralis-streams/status to watch progress.',
      },
    })
  })

  // GET /admin/moralis-streams/debug — single consolidated payload for ops.
  // Returns everything the operator wants to glance at on one screen:
  //   - per-chain status + counts
  //   - sample of pending and failed subscriptions
  //   - last 25 deposits (any status) with user info
  //   - last 25 credited deposits
  //   - last 25 webhook events that hit `Deposit` rows
  //   - audit-log entries for MORALIS_* and DEPOSIT_* actions
  // No secrets or full payloads are included. Safe to give super_admin access.
  app.get('/admin/moralis-streams/debug', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const [status, pendingSubs, failedSubs, recentDeposits, recentCredited, recentAuditLogs] = await Promise.all([
      getStreamStatusSummary(),
      db.moralisStreamSubscription.findMany({
        where: { status: 'pending' },
        take: 25,
        orderBy: { updatedAt: 'desc' },
        include: {
          depositAddress: {
            select: {
              address: true,
              user: { select: { id: true, username: true, email: true } },
            },
          },
        },
      }),
      db.moralisStreamSubscription.findMany({
        where: { status: 'failed' },
        take: 25,
        orderBy: { updatedAt: 'desc' },
        include: {
          depositAddress: {
            select: {
              address: true,
              user: { select: { id: true, username: true, email: true } },
            },
          },
        },
      }),
      db.deposit.findMany({
        take: 25,
        orderBy: { detectedAt: 'desc' },
        include: { user: { select: { id: true, username: true, email: true } } },
      }),
      db.deposit.findMany({
        where: { status: 'credited' },
        take: 25,
        orderBy: { creditedAt: 'desc' },
        include: { user: { select: { id: true, username: true, email: true } } },
      }),
      db.auditLog.findMany({
        where: {
          OR: [
            { action: { startsWith: 'MORALIS_' } },
            { action: { startsWith: 'DEPOSIT_' } },
            { action: { startsWith: 'WITHDRAWAL_' } },
          ],
        },
        take: 50,
        orderBy: { createdAt: 'desc' },
        include: { actor: { select: { id: true, username: true, email: true } } },
      }),
    ])

    return reply.send({
      success: true,
      data: {
        status,
        subscriptions: {
          pending: pendingSubs,
          failed: failedSubs,
        },
        deposits: {
          recent: recentDeposits,
          credited: recentCredited,
        },
        auditLogs: recentAuditLogs,
      },
    })
  })

  // POST /admin/moralis-streams/retry/:id — re-enqueue a single failed sub.
  app.post('/admin/moralis-streams/retry/:id', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const sub = await db.moralisStreamSubscription.findUnique({ where: { id } })
    if (!sub) throw Errors.NOT_FOUND('Subscription')
    await db.moralisStreamSubscription.update({
      where: { id },
      data: { status: 'pending', lastError: null },
    })
    await queues.moralisSubscribe.add('subscribe', { subscriptionId: id }, { jobId: 'moralis-sub-retry-' + id + '-' + Date.now() })
    void createAuditLog(req.user!.id, 'MORALIS_SUBSCRIPTION_RETRIED', 'MoralisStreamSubscription', id, {})
    return reply.send({ success: true })
  })

  // POST /admin/moralis-streams/retry-all-failed — bulk retry every failed
  // subscription. Useful after a Moralis-side outage where many rows ended
  // up in `failed` due to fatal API codes (e.g. a stream id was wrong then
  // corrected). Each row is flipped back to `pending` and re-enqueued.
  app.post('/admin/moralis-streams/retry-all-failed', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const failedRows = await db.moralisStreamSubscription.findMany({
      where: { status: 'failed' },
      select: { id: true },
    })
    if (failedRows.length === 0) {
      return reply.send({ success: true, data: { retried: 0 } })
    }
    await db.moralisStreamSubscription.updateMany({
      where: { id: { in: failedRows.map((r) => r.id) } },
      data: { status: 'pending', lastError: null },
    })
    await Promise.all(
      failedRows.map((r) =>
        queues.moralisSubscribe
          .add('subscribe', { subscriptionId: r.id }, { jobId: 'moralis-sub-retry-' + r.id + '-' + Date.now() })
          .catch((err) => log.warn({ err, id: r.id }, 'Bulk retry enqueue failed')),
      ),
    )
    void createAuditLog(req.user!.id, 'MORALIS_SUBSCRIPTIONS_BULK_RETRIED', 'MoralisStreamSubscription', 'all', {
      count: failedRows.length,
    })
    return reply.send({ success: true, data: { retried: failedRows.length } })
  })

  // GET /admin/deposits/detection-health — liveness of every deposit-detection
  // path in one place: last Moralis webhook delivery, EVM RPC poller heartbeat
  // (per-chain), Aptos poller heartbeat. A stale Moralis stamp with a healthy
  // poller means the backstop is carrying detection — investigate the stream.
  app.get('/admin/deposits/detection-health', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const [moralisLastWebhookAt, evmPollerRaw, aptosPollerRaw] = await Promise.all([
      redis.get('moralis_last_webhook_at').catch(() => null),
      redis.get('evm_deposit_poller_health').catch(() => null),
      redis.get('poller_heartbeat:APTOS_DEPOSIT').catch(() => null),
    ])
    const parse = (raw: string | null) => {
      if (!raw) return null
      try { return JSON.parse(raw) as unknown } catch { return raw }
    }
    return reply.send({
      success: true,
      data: {
        moralisLastWebhookAt,
        evmPoller: parse(evmPollerRaw),
        aptosPoller: parse(aptosPollerRaw),
      },
    })
  })

  // GET /admin/deposit-addresses/:id/balances — live on-chain balances of a
  // user's EVM deposit address across every configured EVM chain (native +
  // whitelisted tokens). Read-only; powers the admin sweep UI.
  app.get('/admin/deposit-addresses/:id/balances', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const row = await db.depositAddress.findUnique({ where: { id } })
    if (!row) throw Errors.NOT_FOUND('Deposit address')
    if (row.chainFamily !== 'EVM') {
      throw new AppError('UNSUPPORTED_FAMILY', 'Balance scan supports EVM deposit addresses only', 400)
    }
    const balances = await getDepositAddressBalances(row.address)
    return reply.send({ success: true, data: { address: row.address, balances } })
  })

  // POST /admin/deposit-addresses/:id/sweep — move funds sitting on a user's
  // HD deposit address to a platform-controlled destination (default: the EVM
  // gas hot wallet). Recovery tool for deposits detection missed — it does NOT
  // credit the user's internal balance (use deposits rescan for that).
  // A custom external destination requires super_admin. Heavily audit-logged.
  app.post('/admin/deposit-addresses/:id/sweep', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const schema = z.object({
      chain: z.string().min(1),
      // 'native' or a whitelisted token contract address on that chain.
      asset: z.string().min(1),
      destination: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
      reason: z.string().min(5).max(500),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    if (parsed.data.destination && req.user!.role !== 'super_admin') {
      throw new AppError('SUPER_ADMIN_REQUIRED', 'Only super_admin may sweep to a custom destination (default sweeps go to the gas hot wallet)', 403)
    }

    const row = await db.depositAddress.findUnique({ where: { id } })
    if (!row) throw Errors.NOT_FOUND('Deposit address')

    log.warn(
      { depositAddressId: id, userId: row.userId, adminId: req.user!.id, chain: parsed.data.chain, asset: parsed.data.asset, destination: parsed.data.destination ?? 'hot-wallet', reason: parsed.data.reason },
      'Admin deposit-address sweep initiated',
    )

    const result = await sweepDepositAddress({
      depositAddressId: id,
      chain: parsed.data.chain,
      asset: parsed.data.asset,
      ...(parsed.data.destination ? { destination: parsed.data.destination } : {}),
    })

    void createAuditLog(req.user!.id, 'DEPOSIT_ADDRESS_SWEPT', 'DepositAddress', id, {
      userId: row.userId,
      reason: parsed.data.reason,
      ...result,
    })

    return reply.send({ success: true, data: result })
  })

  // POST /admin/deposits/rescan — manual reconciliation. The operator pastes
  // a txHash + chain + asset + amount and we feed it through the same
  // processDepositEvent pipeline a real webhook would. Use this when a
  // Moralis webhook was missed (outage, dropped delivery, stream not
  // subscribed at the time) and a user is waiting on credit they actually
  // sent. The watcher's idempotency (unique txHash+chain+asset) makes this
  // safe to call multiple times — a previously-credited tx is a no-op.
  app.post('/admin/deposits/rescan', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const schema = z.object({
      txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'txHash must be 0x + 64 hex chars'),
      chain: z.string().min(1),
      asset: z.string().min(1), // '0x...' contract address or 'native'
      symbol: z.string().optional(),
      fromAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'fromAddress must be 0x + 40 hex chars'),
      toAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'toAddress must be 0x + 40 hex chars'),
      rawAmount: z.string().regex(/^\d+$/, 'rawAmount must be a decimal integer string (raw on-chain units)'),
      confirmations: z.number().int().nonnegative(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    const { txHash, chain, asset, symbol, fromAddress, toAddress, rawAmount, confirmations } = parsed.data

    const chainCfg = await getChainById(chain)
    if (!chainCfg || chainCfg.chainId == null) {
      throw new AppError('UNSUPPORTED_CHAIN', `Chain ${chain} is not supported`, 400)
    }

    const result = await processDepositEvent({
      chainId: chainCfg.chainId,
      txHash,
      fromAddress,
      toAddress,
      asset,
      symbol: symbol ?? '',
      amount: rawAmount,
      confirmations,
    })

    void createAuditLog(req.user!.id, 'DEPOSIT_RESCAN_TRIGGERED', 'Deposit', txHash, {
      chain, asset, rawAmount, confirmations, result,
    })
    return reply.send({ success: true, data: { result } })
  })

  // POST /admin/deposits/:id/force-credit — admin-driven credit. Now requires
  // either (a) a successful on-chain RPC verification that the tx exists, was
  // not reverted, and was sent to the deposit row's `toAddress`, OR (b) the
  // `skipChainVerification: true` override + a super_admin (NOT admin) actor.
  // Heavily audit-logged either way.
  app.post('/admin/deposits/:id/force-credit', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const schema = z.object({
      reason: z.string().min(10).max(500),
      // Last-resort override for cases where the chain RPC is unavailable but
      // the operator has separately verified the tx (e.g. via block explorer).
      // Must be paired with a super_admin actor — adminOrSuper covers that
      // here but we additionally enforce it below.
      skipChainVerification: z.boolean().optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Reason is required (10-500 chars)', 400)

    const deposit = await db.deposit.findUnique({ where: { id } })
    if (!deposit) throw Errors.NOT_FOUND('Deposit')
    if (deposit.status === 'credited') {
      throw new AppError('ALREADY_CREDITED', 'Deposit is already credited', 409)
    }
    if (!deposit.userId) {
      throw new AppError('NO_USER', 'Deposit has no associated user — cannot force-credit', 400)
    }

    const chainCfg = await getChainById(deposit.chain)
    if (!chainCfg) {
      throw new AppError('UNSUPPORTED_CHAIN', `Chain ${deposit.chain} not configured`, 400)
    }

    // On-chain verification — required unless the actor opts out.
    let verification:
      | { verified: true; receiptStatus: '0x0' | '0x1'; txBlock: string; currentBlock: string; confirmations: number; onChainTo: string | null }
      | { verified: false; reason: string }
    if (parsed.data.skipChainVerification) {
      if (req.user!.role !== 'super_admin') {
        throw new AppError(
          'SUPER_ADMIN_REQUIRED',
          'Only super_admin may force-credit without on-chain verification',
          403,
        )
      }
      verification = { verified: false, reason: 'skipped_by_super_admin' }
    } else {
      const rpcUrl = getRpcUrl(deposit.chain)
      if (!rpcUrl) {
        throw new AppError('NO_RPC_URL', `No RPC configured for chain ${deposit.chain}`, 503)
      }
      try {
        const [currentBlock, receipt] = await Promise.all([
          getBlockNumber(rpcUrl, deposit.chain),
          getTransactionReceipt(rpcUrl, deposit.chain, deposit.txHash),
        ])
        if (!receipt) {
          throw new AppError(
            'TX_NOT_FOUND',
            'Transaction receipt not found on chain. Tx may be unmined, dropped, or txHash mismatched.',
            400,
          )
        }
        if (receipt.status === '0x0') {
          throw new AppError('TX_REVERTED', 'On-chain transaction reverted (status=0x0). Refusing to credit.', 400)
        }
        // For ERC20 transfers, receipt.to is the token contract — not the
        // recipient. For native transfers, receipt.to is the recipient. We
        // only enforce the to-address check on native transfers.
        if (deposit.asset === 'native' && receipt.to && receipt.to.toLowerCase() !== deposit.toAddress.toLowerCase()) {
          throw new AppError(
            'TX_RECIPIENT_MISMATCH',
            `On-chain recipient ${receipt.to} does not match deposit toAddress ${deposit.toAddress}`,
            400,
          )
        }
        const confirmations = currentBlock >= receipt.blockNumber
          ? Number(currentBlock - receipt.blockNumber + 1n)
          : 0
        verification = {
          verified: true,
          receiptStatus: receipt.status,
          txBlock: receipt.blockNumber.toString(),
          currentBlock: currentBlock.toString(),
          confirmations,
          onChainTo: receipt.to,
        }
      } catch (err) {
        if (err instanceof AppError) throw err
        throw new AppError(
          'RPC_VERIFICATION_FAILED',
          `On-chain verification failed: ${err instanceof Error ? err.message : 'unknown'}`,
          502,
        )
      }
    }

    log.warn(
      {
        depositId: deposit.id,
        adminId: req.user!.id,
        adminRole: req.user!.role,
        txHash: deposit.txHash,
        chain: deposit.chain,
        symbol: deposit.symbol,
        amount: deposit.amount.toString(),
        skipChainVerification: !!parsed.data.skipChainVerification,
        verification,
        reason: parsed.data.reason,
      },
      'Admin force-credit initiated',
    )

    const outcome = await creditDetectedDeposit(deposit.id, {
      source: 'admin-force',
      allowFromRejected: true,
      extraMetadata: {
        forceCredit: true,
        adminId: req.user!.id,
        adminRole: req.user!.role,
        reason: parsed.data.reason,
        verification,
      },
    })

    void createAuditLog(req.user!.id, 'DEPOSIT_FORCE_CREDITED', 'Deposit', deposit.id, {
      reason: parsed.data.reason,
      userId: deposit.userId,
      symbol: deposit.symbol,
      amount: deposit.amount.toString(),
      txHash: deposit.txHash,
      skipChainVerification: !!parsed.data.skipChainVerification,
      verification,
      outcome,
    })

    return reply.send({ success: true, data: { outcome, verification } })
  })

  // POST /admin/deposits/:id/refresh-confirmations — re-fetch the deposit's
  // current on-chain confirmation count via RPC and update the row. If the
  // refreshed count crosses the chain threshold the deposit is credited via
  // the same atomic credit helper used by the webhook and reconciler paths.
  // Safe to call repeatedly. Returns the verification + credit outcome.
  app.post('/admin/deposits/:id/refresh-confirmations', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const deposit = await db.deposit.findUnique({ where: { id } })
    if (!deposit) throw Errors.NOT_FOUND('Deposit')

    const refresh = await refreshDepositFromRpc(id)
    log.info({ depositId: id, adminId: req.user!.id, refresh }, 'Admin refresh-confirmations')

    let credit: unknown = null
    if (refresh.ok && refresh.receiptStatus === '0x1' && refresh.after >= refresh.threshold && deposit.status === 'detected') {
      credit = await creditDetectedDeposit(id, {
        source: 'admin-refresh',
        extraMetadata: {
          adminId: req.user!.id,
          refresh: {
            confirmations: refresh.after,
            currentBlock: refresh.currentBlock.toString(),
            txBlock: refresh.txBlock.toString(),
          },
        },
      })
    }

    void createAuditLog(req.user!.id, 'DEPOSIT_REFRESH_CONFIRMATIONS', 'Deposit', id, {
      txHash: deposit.txHash,
      chain: deposit.chain,
      refresh: refresh.ok
        ? {
            ok: true,
            before: refresh.before,
            after: refresh.after,
            threshold: refresh.threshold,
            receiptStatus: refresh.receiptStatus,
            txBlock: refresh.txBlock.toString(),
            currentBlock: refresh.currentBlock.toString(),
          }
        : refresh,
      credit,
    })

    return reply.send({ success: true, data: { refresh, credit } })
  })

  // POST /admin/deposits/reconcile-by-tx — given (txHash, chain), look up the
  // tx on chain via RPC, find or create the Deposit row, and run the standard
  // detection + credit pipeline. Used when:
  //   - Moralis never delivered the unconfirmed webhook (so no Deposit row exists)
  //   - or the user pastes a txHash from their wallet and asks for manual help
  // Idempotent — a previously-credited deposit just returns its status.
  app.post('/admin/deposits/reconcile-by-tx', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const schema = z.object({
      txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'txHash must be 0x + 64 hex chars'),
      chain: z.string().min(1),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    const chainCfg = await getChainById(parsed.data.chain)
    if (!chainCfg || chainCfg.chainId == null) {
      throw new AppError('UNSUPPORTED_CHAIN', `Chain ${parsed.data.chain} is not supported`, 400)
    }
    const rpcUrl = getRpcUrl(chainCfg.id)
    if (!rpcUrl) {
      throw new AppError('NO_RPC_URL', `No RPC configured for chain ${chainCfg.id}`, 503)
    }

    // Pull tx + receipt from chain.
    const [currentBlock, tx, receipt] = await Promise.all([
      getBlockNumber(rpcUrl, chainCfg.id),
      getTransactionByHash(rpcUrl, chainCfg.id, parsed.data.txHash),
      getTransactionReceipt(rpcUrl, chainCfg.id, parsed.data.txHash),
    ]).catch((err) => {
      throw new AppError('RPC_FAILED', err instanceof Error ? err.message : 'rpc_failed', 502)
    })

    if (!tx) {
      throw new AppError('TX_NOT_FOUND', `Transaction ${parsed.data.txHash} not found on ${chainCfg.id}`, 404)
    }
    if (!receipt) {
      throw new AppError('TX_UNMINED', 'Transaction has not been mined yet — try again once it confirms', 409)
    }
    if (receipt.status === '0x0') {
      throw new AppError('TX_REVERTED', 'On-chain tx reverted (status=0x0) — cannot credit', 400)
    }

    // Only native transfers carry a usable `value` directly on the tx. For
    // ERC20 transfers the operator should use /admin/deposits/rescan or
    // re-trigger the Moralis backfill — we can't safely reconstruct the
    // recipient + token amount from a single eth_getTransactionByHash call.
    if (tx.value === 0n) {
      throw new AppError(
        'ERC20_NOT_SUPPORTED_HERE',
        'Reconcile-by-tx currently supports native-asset transfers only. For ERC20 deposits, use POST /admin/deposits/rescan with the full (txHash, chain, asset, toAddress, fromAddress, rawAmount) payload.',
        400,
      )
    }
    if (!tx.to) {
      throw new AppError('TX_NO_RECIPIENT', 'Transaction has no recipient (contract creation?)', 400)
    }

    const confirmations = currentBlock >= receipt.blockNumber
      ? Number(currentBlock - receipt.blockNumber + 1n)
      : 0

    log.info(
      {
        adminId: req.user!.id,
        txHash: parsed.data.txHash,
        chain: chainCfg.id,
        from: tx.from,
        to: tx.to,
        valueWei: tx.value.toString(),
        confirmations,
      },
      'Admin reconcile-by-tx via RPC',
    )

    const result = await processDepositEvent({
      chainId: chainCfg.chainId,
      txHash: parsed.data.txHash,
      fromAddress: tx.from,
      toAddress: tx.to,
      asset: 'native',
      symbol: chainCfg.nativeSymbol,
      amount: tx.value.toString(),
      confirmations,
    })

    void createAuditLog(req.user!.id, 'DEPOSIT_RECONCILE_BY_TX', 'Deposit', parsed.data.txHash, {
      chain: chainCfg.id,
      txHash: parsed.data.txHash,
      from: tx.from,
      to: tx.to,
      valueWei: tx.value.toString(),
      confirmations,
      result,
    })

    return reply.send({ success: true, data: { result, onChain: { confirmations, currentBlock: currentBlock.toString(), txBlock: receipt.blockNumber.toString() } } })
  })

  // POST /admin/deposits/:id/reject — mark a Deposit row as rejected.
  // Used when a deposit was a false positive (e.g. test-net leak, internal
  // sweep, spam token). Reversible via force-credit. Heavily audit-logged.
  app.post('/admin/deposits/:id/reject', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const schema = z.object({ reason: z.string().min(10).max(500) })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'Reason is required (10-500 chars)', 400)

    const deposit = await db.deposit.findUnique({ where: { id } })
    if (!deposit) throw Errors.NOT_FOUND('Deposit')
    if (deposit.status === 'credited') {
      throw new AppError('ALREADY_CREDITED', 'Cannot reject an already-credited deposit. Open a manual reversal ticket instead.', 409)
    }

    await db.deposit.update({
      where: { id: deposit.id },
      data: { status: 'rejected', rejectionReason: parsed.data.reason.slice(0, 500) },
    })

    void createAuditLog(req.user!.id, 'DEPOSIT_REJECTED', 'Deposit', deposit.id, {
      reason: parsed.data.reason,
      txHash: deposit.txHash,
      chain: deposit.chain,
    })

    return reply.send({ success: true })
  })

  // GET /admin/deposits — paginated on-chain deposit history with filters.
  // Returns the full Deposit + DepositAddress audit trail so ops can debug
  // stuck/pending credits, failed crediting, suspicious addresses, etc.
  app.get('/admin/deposits', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const query = req.query as Record<string, string>
    const { page, limit, skip } = paginationParams(query)

    const where: Record<string, unknown> = {}
    if (query.status) where.status = query.status
    if (query.chain) where.chain = query.chain
    if (query.userId) where.userId = query.userId
    if (query.toAddress) where.toAddress = query.toAddress

    const [deposits, total] = await Promise.all([
      db.deposit.findMany({
        where,
        orderBy: { detectedAt: 'desc' },
        skip,
        take: limit,
        include: { user: { select: { id: true, username: true, email: true } } },
      }),
      db.deposit.count({ where }),
    ])

    return reply.send({
      success: true,
      data: { deposits, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
    })
  })

  // GET /admin/deposit-addresses — audit who owns which HD-derived address.
  app.get('/admin/deposit-addresses', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const query = req.query as Record<string, string>
    const { page, limit, skip } = paginationParams(query)

    const where: Record<string, unknown> = {}
    if (query.chainFamily) where.chainFamily = query.chainFamily
    if (query.userId) where.userId = query.userId
    if (query.address) where.address = query.address

    const [addresses, total] = await Promise.all([
      db.depositAddress.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { user: { select: { id: true, username: true, email: true } } },
      }),
      db.depositAddress.count({ where }),
    ])

    return reply.send({
      success: true,
      data: { addresses, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
    })
  })

  // ── Withdrawals ────────────────────────────────────────────────────────────

  app.get('/admin/withdrawals', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const query = req.query as Record<string, string>
    const { page, limit, skip } = paginationParams(query)

    const where: Record<string, unknown> = {}
    if (query.status) {
      const statuses = query.status.split(',').map((s) => s.trim()).filter(Boolean)
      where.status = statuses.length === 1 ? statuses[0] : { in: statuses }
    }

    const [withdrawals, total] = await Promise.all([
      db.withdrawal.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { user: { select: { username: true, email: true } } },
      }),
      db.withdrawal.count({ where }),
    ])

    return reply.send({
      success: true,
      data: { withdrawals, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
    })
  })

  // GET /admin/withdrawals/:id — single withdrawal detail (read-only)
  app.get('/admin/withdrawals/:id', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const withdrawal = await db.withdrawal.findUnique({
      where: { id },
      include: { user: { select: { id: true, username: true, email: true } } },
    })
    if (!withdrawal) throw Errors.NOT_FOUND('Withdrawal')
    return reply.send({ success: true, data: withdrawal })
  })

  // Tier-aware approve: tier 1/2 → single approval; tier 3/4 → dual approval.
  app.post('/admin/withdrawals/:id/approve', { preHandler: adminStepUp }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const adminId = req.user!.id

    const withdrawal = await db.withdrawal.findUnique({ where: { id } })
    if (!withdrawal) throw Errors.NOT_FOUND('Withdrawal')
    if (!['pending', 'first_approved'].includes(withdrawal.status)) {
      throw new AppError('INVALID_STATUS', `Withdrawal is in status '${withdrawal.status}' and cannot be approved`, 400)
    }

    const tier = withdrawal.tier ?? 3

    if (withdrawal.status === 'pending') {
      if (tier <= 2) {
        // Single-admin approval path (tier 1 escalated by risk flags, or tier 2).
        // Optimistic lock: include status in WHERE so concurrent approvals are idempotent.
        const updated = await db.withdrawal.updateMany({
          where: { id, status: 'pending' },
          data: { status: 'approved', firstApprovedBy: adminId },
        })
        if (updated.count === 0) {
          throw new AppError('CONFLICT', 'Withdrawal was already approved by another admin', 409)
        }
        await createAuditLog(adminId, 'WITHDRAWAL_APPROVED', 'Withdrawal', id, { tier, singleApproval: true })
        return reply.send({ success: true, message: 'Withdrawal approved and ready to send.' })
      } else {
        // Dual-approval path (tier 3+): first approval with optimistic lock.
        const updated = await db.withdrawal.updateMany({
          where: { id, status: 'pending' },
          data: { status: 'first_approved', firstApprovedBy: adminId },
        })
        if (updated.count === 0) {
          throw new AppError('CONFLICT', 'Withdrawal status changed concurrently — please refresh and try again', 409)
        }
        await createAuditLog(adminId, 'WITHDRAWAL_FIRST_APPROVED', 'Withdrawal', id, { tier })
        return reply.send({ success: true, message: 'First approval recorded. A second admin must approve before it can be sent.' })
      }
    }

    // status === 'first_approved' — requires a different admin unless the approver is super_admin (solo-admin deployments)
    const isSuperAdmin = req.user!.role === 'super_admin'
    if (withdrawal.firstApprovedBy === adminId && !isSuperAdmin) {
      throw new AppError('SAME_ADMIN', 'A different admin must provide the second approval', 403)
    }
    // Optimistic lock: re-validate status is still first_approved when we commit.
    const updated = await db.withdrawal.updateMany({
      where: { id, status: 'first_approved' },
      data: { status: 'approved', secondApprovedBy: adminId },
    })
    if (updated.count === 0) {
      throw new AppError('CONFLICT', 'Withdrawal status changed concurrently — please refresh and try again', 409)
    }
    await createAuditLog(adminId, 'WITHDRAWAL_SECOND_APPROVED', 'Withdrawal', id, { tier })
    return reply.send({ success: true, message: 'Withdrawal fully approved and ready to send.' })
  })

  app.post('/admin/withdrawals/:id/reject', { preHandler: adminStepUp }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const bodySchema = z.object({ reason: z.string().min(1).max(500) })
    const parsed = bodySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    const withdrawal = await db.withdrawal.findUnique({
      where: { id },
      include: { user: { select: { email: true } } },
    })
    if (!withdrawal) throw Errors.NOT_FOUND('Withdrawal')
    if (['completed', 'sent'].includes(withdrawal.status)) {
      throw new AppError('INVALID_STATUS', 'Cannot reject a completed or sent withdrawal', 400)
    }

    // email_pending withdrawals never had their balance deducted — do not refund.
    const balanceWasDeducted = withdrawal.status !== 'email_pending'

    await db.$transaction(async (tx) => {
      const wallet = await tx.wallet.findFirst({
        where: { userId: withdrawal.userId, coin: withdrawal.coin, network: withdrawal.network },
        select: { id: true },
      })

      await tx.withdrawal.update({
        where: { id },
        data: { status: 'rejected', rejectedBy: req.user!.id, rejectionReason: parsed.data.reason },
      })

      if (balanceWasDeducted) {
        await tx.wallet.updateMany({
          where: { userId: withdrawal.userId, coin: withdrawal.coin, network: withdrawal.network },
          data: { balance: { increment: new Prisma.Decimal(Number(withdrawal.amount) + Number(withdrawal.fee)) } },
        })

        if (wallet) {
          await tx.transaction.create({
            data: {
              walletId: wallet.id,
              type: 'withdrawal',
              amount: withdrawal.amount,
              fee: withdrawal.fee,
              status: 'failed',
              metadata: {
                withdrawalId: withdrawal.id,
                orderRef: withdrawal.orderRef,
                toAddress: withdrawal.toAddress,
                rejectionReason: parsed.data.reason,
                rejectedBy: req.user!.id,
                refunded: true,
              } as JsonValue,
            },
          })
        }
      }
    })

    await createAuditLog(req.user!.id, 'WITHDRAWAL_REJECTED', 'Withdrawal', id, { reason: parsed.data.reason }, clientIp(req), req.headers['user-agent'] as string | undefined)
    await sendWithdrawalEmail('rejected', withdrawal.user.email, {
      amount: withdrawal.amount.toString(),
      coin: withdrawal.coin,
      reason: parsed.data.reason,
    })

    return reply.send({ success: true })
  })

  // Place a withdrawal on security hold (any non-terminal status → on_hold).
  app.post('/admin/withdrawals/:id/hold', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const bodySchema = z.object({ reason: z.string().min(1).max(500) })
    const parsed = bodySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    const withdrawal = await db.withdrawal.findUnique({ where: { id } })
    if (!withdrawal) throw Errors.NOT_FOUND('Withdrawal')
    if (['email_pending', 'sent', 'completed', 'rejected', 'cancelled', 'on_hold'].includes(withdrawal.status)) {
      throw new AppError('INVALID_STATUS', `Cannot hold a withdrawal in status '${withdrawal.status}'`, 400)
    }

    await db.withdrawal.update({
      where: { id },
      data: { status: 'on_hold', onHoldBy: req.user!.id, onHoldReason: parsed.data.reason },
    })
    await createAuditLog(req.user!.id, 'WITHDRAWAL_HELD', 'Withdrawal', id, { reason: parsed.data.reason }, clientIp(req), req.headers['user-agent'] as string | undefined)
    return reply.send({ success: true, message: 'Withdrawal placed on hold.' })
  })

  // Release a held withdrawal back to pending for normal approval flow.
  app.post('/admin/withdrawals/:id/release-hold', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const withdrawal = await db.withdrawal.findUnique({ where: { id } })
    if (!withdrawal) throw Errors.NOT_FOUND('Withdrawal')
    if (withdrawal.status !== 'on_hold') {
      throw new AppError('INVALID_STATUS', 'Withdrawal is not on hold', 400)
    }

    await db.withdrawal.update({
      where: { id },
      data: {
        status: 'pending',
        // Reset approval chain so it goes through full approval flow from the top
        firstApprovedBy: null,
        secondApprovedBy: null,
      },
    })
    await createAuditLog(req.user!.id, 'WITHDRAWAL_HOLD_RELEASED', 'Withdrawal', id, {}, clientIp(req), req.headers['user-agent'] as string | undefined)
    return reply.send({ success: true, message: 'Hold released. Withdrawal returned to pending.' })
  })

  // Mark a withdrawal as manually resolved/refunded (for withdrawals handled outside platform).
  app.post('/admin/withdrawals/:id/mark-resolved', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const bodySchema = z.object({ note: z.string().min(1).max(500) })
    const parsed = bodySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    const withdrawal = await db.withdrawal.findUnique({ where: { id } })
    if (!withdrawal) throw Errors.NOT_FOUND('Withdrawal')
    if (['sent', 'completed', 'rejected', 'cancelled'].includes(withdrawal.status)) {
      throw new AppError('INVALID_STATUS', `Withdrawal is already in terminal status '${withdrawal.status}'`, 400)
    }

    await db.withdrawal.update({
      where: { id },
      data: { status: 'completed', completedAt: new Date(), adminNote: parsed.data.note },
    })
    await createAuditLog(req.user!.id, 'WITHDRAWAL_MANUALLY_RESOLVED', 'Withdrawal', id, {
      note: parsed.data.note,
      previousStatus: withdrawal.status,
    }, clientIp(req), req.headers['user-agent'] as string | undefined)
    return reply.send({ success: true, message: 'Withdrawal marked as resolved.' })
  })

  // Admin risk override: acknowledge risk flags and reduce effective tier.
  // Useful when a first-withdrawal by a known/trusted user is safe to approve faster.
  app.post('/admin/withdrawals/:id/risk-override', { preHandler: adminStepUp }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const bodySchema = z.object({
      note: z.string().min(1).max(500),
      overrideTier: z.number().int().min(1).max(4).optional(),
    })
    const parsed = bodySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    const withdrawal = await db.withdrawal.findUnique({ where: { id } })
    if (!withdrawal) throw Errors.NOT_FOUND('Withdrawal')
    if (['sent', 'completed', 'rejected', 'cancelled'].includes(withdrawal.status)) {
      throw new AppError('INVALID_STATUS', 'Cannot override risk on a terminal withdrawal', 400)
    }

    const newTier = parsed.data.overrideTier ?? withdrawal.tier
    await db.withdrawal.update({
      where: { id },
      data: {
        riskOverride: true,
        riskOverrideBy: req.user!.id,
        riskOverrideNote: parsed.data.note,
        tier: newTier,
      },
    })
    await createAuditLog(req.user!.id, 'WITHDRAWAL_RISK_OVERRIDE', 'Withdrawal', id, {
      note: parsed.data.note,
      originalTier: withdrawal.tier,
      newTier,
    }, clientIp(req), req.headers['user-agent'] as string | undefined)
    return reply.send({ success: true, message: 'Risk override applied.' })
  })

  // POST /admin/withdrawals/:id/mark-sent — operator calls this after manually
  // broadcasting the on-chain payout. Accepts both 'approved' and 'auto_approved'.
  app.post('/admin/withdrawals/:id/mark-sent', { preHandler: adminStepUp }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const schema = z.object({
      txHash: z.string().min(1).max(200),
      adminNote: z.string().max(500).optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    const withdrawal = await db.withdrawal.findUnique({
      where: { id },
      include: { user: { select: { email: true } } },
    })
    if (!withdrawal) throw Errors.NOT_FOUND('Withdrawal')
    if (!['approved', 'auto_approved'].includes(withdrawal.status)) {
      throw new AppError(
        'INVALID_STATUS',
        `Withdrawal must be 'approved' or 'auto_approved' to mark as sent (current: ${withdrawal.status})`,
        400,
      )
    }

    // Validate txHash format against the withdrawal's network so admins cannot
    // accidentally (or for testing) enter a fake hash that would leave the user's
    // balance permanently deducted with no real on-chain transaction.
    const txHash = parsed.data.txHash.trim()
    const EVM_TX_RE  = /^0x[0-9a-fA-F]{64}$/
    const TRON_TX_RE = /^[0-9a-fA-F]{64}$/
    const isTron = withdrawal.network.toUpperCase() === 'TRC20'
    const validHash = isTron ? TRON_TX_RE.test(txHash) : EVM_TX_RE.test(txHash)
    if (!validHash) {
      const expected = isTron
        ? '64 hex characters (TRON format)'
        : '0x followed by 64 hex characters (EVM format)'
      throw new AppError(
        'VALIDATION_ERROR',
        `Invalid transaction hash for ${withdrawal.network}. Expected ${expected}. If you need to send this withdrawal manually, complete the on-chain transfer first, then paste the real transaction hash here.`,
        400,
      )
    }

    const wallet = await db.wallet.findFirst({
      where: { userId: withdrawal.userId, coin: withdrawal.coin, network: withdrawal.network },
      select: { id: true },
    })

    await db.$transaction(async (tx) => {
      // Optimistic lock inside the transaction: only update if status is still
      // approved/auto_approved. Guards against two concurrent mark-sent calls
      // both creating a completed Transaction row for the same withdrawal.
      const locked = await tx.withdrawal.updateMany({
        where: { id, status: { in: ['approved', 'auto_approved'] } },
        data: {
          status: 'sent',
          txHash,
          completedAt: new Date(),
          ...(parsed.data.adminNote ? { adminNote: parsed.data.adminNote } : {}),
        },
      })
      if (locked.count === 0) {
        throw new AppError('CONFLICT', 'Withdrawal was already marked as sent by another admin', 409)
      }

      if (wallet) {
        // Try to update the existing pending transaction record to avoid duplicates
        const pendingTx = await tx.transaction.findFirst({
          where: {
            walletId: wallet.id,
            type:     'withdrawal',
            status:   'pending',
            metadata: { path: ['withdrawalId'], equals: withdrawal.id },
          },
        })
        if (pendingTx) {
          await tx.transaction.update({
            where: { id: pendingTx.id },
            data: {
              status:  'completed',
              txHash,
              metadata: {
                withdrawalId: withdrawal.id,
                orderRef:     withdrawal.orderRef,
                toAddress:    withdrawal.toAddress,
                markedSentBy: req.user!.id,
                ...(parsed.data.adminNote ? { adminNote: parsed.data.adminNote } : {}),
              } as JsonValue,
            },
          })
        } else {
          // No pending transaction found — create a new completed one
          await tx.transaction.create({
            data: {
              walletId: wallet.id,
              type:     'withdrawal',
              amount:   withdrawal.amount,
              fee:      withdrawal.fee,
              txHash,
              status:   'completed',
              metadata: {
                withdrawalId: withdrawal.id,
                orderRef:     withdrawal.orderRef,
                toAddress:    withdrawal.toAddress,
                markedSentBy: req.user!.id,
                ...(parsed.data.adminNote ? { adminNote: parsed.data.adminNote } : {}),
              } as JsonValue,
            },
          })
        }
      }
    })

    log.info(
      { adminId: req.user!.id, withdrawalId: id, txHash, coin: withdrawal.coin },
      'Withdrawal marked as sent',
    )

    await createAuditLog(req.user!.id, 'WITHDRAWAL_MARKED_SENT', 'Withdrawal', id, {
      txHash,
      adminNote: parsed.data.adminNote,
      userId: withdrawal.userId,
      coin: withdrawal.coin,
      amount: withdrawal.amount.toString(),
      toAddress: withdrawal.toAddress,
    }, clientIp(req), req.headers['user-agent'] as string | undefined)

    // Record platform fee in the gas ledger (same as auto-send path).
    // The fee stays physically in the hot wallet — only `amount` goes on-chain.
    const withdrawalFee = Number(withdrawal.fee)
    if (withdrawalFee > 0) {
      const gasChain = WITHDRAWAL_NETWORK_TO_GAS_CHAIN[withdrawal.network.toUpperCase()]
      if (gasChain) {
        void appendLedgerEntry({
          entryType:    'platform_fee',
          chain:        gasChain,
          nativeAmount: 0,
          tokenSymbol:  withdrawal.coin.toUpperCase(),
          tokenAmount:  withdrawalFee,
          usdAmount:    withdrawalFee,
          txHash,
          sourceKey:    `platform_fee:withdrawal:${id}`,
          notes:        `Withdrawal fee — marked sent by admin ${req.user!.id}`,
        }).catch((err) => log.error({ err, withdrawalId: id }, 'Failed to write platform_fee ledger entry (mark-sent)'))
      }
    }

    await sendWithdrawalEmail('approved', withdrawal.user.email, {
      amount: withdrawal.amount.toString(),
      coin: withdrawal.coin,
      txHash,
    }).catch(() => {})

    return reply.send({ success: true, data: { status: 'sent', txHash } })
  })

  // POST /admin/withdrawals/:id/refund — refund a "sent" withdrawal where the
  // on-chain transaction never actually happened (e.g. fake txHash entered during
  // testing, or a failed broadcast). Restores amount + fee to the user's wallet
  // and marks the withdrawal as rejected so it is no longer treated as finalised.
  app.post('/admin/withdrawals/:id/refund', { preHandler: adminStepUp }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const bodySchema = z.object({ reason: z.string().min(1).max(500) })
    const parsed = bodySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    const withdrawal = await db.withdrawal.findUnique({
      where: { id },
      include: { user: { select: { email: true } } },
    })
    if (!withdrawal) throw Errors.NOT_FOUND('Withdrawal')
    if (withdrawal.status !== 'sent') {
      throw new AppError(
        'INVALID_STATUS',
        `Only 'sent' withdrawals can be refunded this way (current: ${withdrawal.status}). For pending/approved withdrawals use Reject instead.`,
        400,
      )
    }

    const refundReason = `Refunded by admin: ${parsed.data.reason}`

    await db.$transaction(async (tx) => {
      await tx.withdrawal.update({
        where: { id },
        data: {
          status: 'rejected',
          rejectedBy: req.user!.id,
          rejectionReason: refundReason,
        },
      })

      // Credit amount + fee back to the user's wallet
      await tx.wallet.updateMany({
        where: { userId: withdrawal.userId, coin: withdrawal.coin, network: withdrawal.network },
        data: { balance: { increment: new Prisma.Decimal(Number(withdrawal.amount) + Number(withdrawal.fee)) } },
      })

      const wallet = await tx.wallet.findFirst({
        where: { userId: withdrawal.userId, coin: withdrawal.coin, network: withdrawal.network },
        select: { id: true },
      })
      if (wallet) {
        await tx.transaction.create({
          data: {
            walletId: wallet.id,
            type:     'withdrawal',
            amount:   withdrawal.amount,
            fee:      withdrawal.fee,
            status:   'failed',
            metadata: {
              withdrawalId:    withdrawal.id,
              orderRef:        withdrawal.orderRef,
              toAddress:       withdrawal.toAddress,
              rejectionReason: refundReason,
              refundedBy:      req.user!.id,
              refunded:        true,
            } as JsonValue,
          },
        })
      }
    })

    await createAuditLog(req.user!.id, 'WITHDRAWAL_REFUNDED', 'Withdrawal', id, {
      reason: parsed.data.reason,
      previousTxHash: withdrawal.txHash ?? null,
      userId: withdrawal.userId,
      coin: withdrawal.coin,
      amount: withdrawal.amount.toString(),
    }, clientIp(req), req.headers['user-agent'] as string | undefined)

    await sendWithdrawalEmail('rejected', withdrawal.user.email, {
      amount: withdrawal.amount.toString(),
      coin: withdrawal.coin,
      reason: `Your withdrawal has been refunded to your RupChain balance. Reason: ${parsed.data.reason}`,
    }).catch(() => {})

    return reply.send({ success: true, message: 'Withdrawal refunded — balance restored to user.' })
  })

  // GET /admin/withdrawal-tiers — read current tier thresholds + risk config
  app.get('/admin/withdrawal-tiers', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const config = await getWithdrawalTierConfig(db)
    return reply.send({ success: true, data: config })
  })

  // PUT /admin/withdrawal-tiers — update tier thresholds + risk config
  app.put('/admin/withdrawal-tiers', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const schema = z.object({
      tier1MaxUsd: z.number().positive().optional(),
      tier2MaxUsd: z.number().positive().optional(),
      tier3MaxUsd: z.number().positive().optional(),
      autoApproveEnabled: z.boolean().optional(),
      firstWithdrawalReview: z.boolean().optional(),
      newWalletReview: z.boolean().optional(),
      velocityWindowMins: z.number().int().min(1).optional(),
      velocityMaxCount: z.number().int().min(1).optional(),
      coinPricesUsd: z.record(z.string(), z.number().positive()).optional(),
      emailConfirmationEnabled: z.boolean().optional(),
      emailConfirmationTtlMins: z.number().int().min(1).max(1440).optional(),
      addressActivationHours: z.number().int().min(0).max(168).optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    const updated = await upsertWithdrawalTierConfig(db, { ...parsed.data, updatedBy: req.user!.id })
    await createAuditLog(req.user!.id, 'WITHDRAWAL_TIERS_UPDATED', 'WithdrawalTierConfig', '1', parsed.data)
    return reply.send({ success: true, data: updated })
  })

  // ── Config ─────────────────────────────────────────────────────────────────

  app.get('/admin/config', { preHandler: [authenticate, superAdminOnly] }, async (_req, reply) => {
    const config = await db.platformConfig.findMany({ orderBy: { key: 'asc' } })
    return reply.send({ success: true, data: config })
  })

  app.patch('/admin/config', { preHandler: superStepUp }, async (req, reply) => {
    const bodySchema = z.object({ key: z.string().min(1), value: z.string() })
    const parsed = bodySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    const updated = await db.platformConfig.upsert({
      where: { key: parsed.data.key },
      create: { key: parsed.data.key, value: parsed.data.value },
      update: { value: parsed.data.value },
    })
    await createAuditLog(req.user!.id, 'CONFIG_UPDATED', 'PlatformConfig', updated.id, { key: parsed.data.key, value: parsed.data.value }, clientIp(req), req.headers['user-agent'] as string | undefined)

    return reply.send({ success: true, data: updated })
  })

  // POST /admin/media-retention/run — manually trigger the trade-media purge now.
  // Forces a run even while the daily schedule is disabled, but still honours the
  // `media_retention_days` window, so it can only ever delete already-settled,
  // past-cutoff trade media (never KYC, never recent/disputed trades).
  app.post('/admin/media-retention/run', { preHandler: superStepUp }, async (req, reply) => {
    const result = await runMediaRetention({ force: true })
    await createAuditLog(req.user!.id, 'MEDIA_RETENTION_RUN', 'PlatformConfig', 'media_retention', result ?? {}, clientIp(req), req.headers['user-agent'] as string | undefined)
    return reply.send({ success: true, data: result })
  })

  // ── Analytics ──────────────────────────────────────────────────────────────

  app.get('/admin/analytics', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const query = req.query as Record<string, string>
    // Supported periods: today, 7d, 30d, 12m. (90d kept for backward compat.)
    const rawPeriod = (query.period as string) ?? '30d'
    const period = (['today', '7d', '30d', '90d', '12m'].includes(rawPeriod) ? rawPeriod : '30d') as
      'today' | '7d' | '30d' | '90d' | '12m'
    const granularity: 'day' | 'month' = period === '12m' ? 'month' : 'day'

    // Build the dense bucket list (every day/month in the window) up front so the
    // chart always renders a full axis and 12m groups by month instead of 365 days.
    const buckets: string[] = []
    let since: Date
    if (period === '12m') {
      const now = new Date()
      for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
        buckets.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
      }
      since = new Date(`${buckets[0]}-01T00:00:00.000Z`)
    } else if (period === 'today') {
      since = new Date(); since.setHours(0, 0, 0, 0)
      buckets.push(since.toISOString().slice(0, 10))
    } else {
      const daysMap: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90 }
      const days = daysMap[period] ?? 30
      since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      for (let i = days - 1; i >= 0; i--) {
        buckets.push(new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10))
      }
    }

    const [badgeRows, topTraderRows, recentUsers, recentTrades, recentCtmTrades, p2pTotal, ctmTotal, gasTotal, p2pPeriod, ctmPeriod, gasPeriod] = await Promise.all([
      db.tradeStats.groupBy({ by: ['badge'], _count: { badge: true } }),
      db.tradeStats.findMany({
        orderBy: { completedTrades: 'desc' },
        take: 15,
        include: { user: { select: { username: true, kycStatus: true } } },
      }),
      db.user.findMany({
        where: { createdAt: { gte: since } },
        select: { createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      db.trade.findMany({
        where: { status: 'crypto_released', updatedAt: { gte: since } },
        select: { updatedAt: true, fiatAmount: true },
        orderBy: { updatedAt: 'asc' },
        take: 2000,
      }),
      db.ctmTrade.findMany({
        where: { status: 'completed', updatedAt: { gte: since } },
        select: { updatedAt: true, fiatAmount: true },
        orderBy: { updatedAt: 'asc' },
        take: 2000,
      }),
      // Summary counts (all-time)
      db.trade.count({ where: { status: 'crypto_released' } }),
      db.ctmTrade.count({ where: { status: 'completed' } }),
      db.gasFeeOrder.count({ where: { status: 'delivered' } }),
      // Period counts
      db.trade.count({ where: { status: 'crypto_released', updatedAt: { gte: since } } }),
      db.ctmTrade.count({ where: { status: 'completed', updatedAt: { gte: since } } }),
      db.gasFeeOrder.count({ where: { status: 'delivered', updatedAt: { gte: since } } }),
    ])

    // Bucket key respects the chosen granularity (YYYY-MM-DD for days, YYYY-MM for months).
    function bucketKey(d: Date) {
      const iso = d.toISOString()
      return granularity === 'month' ? iso.slice(0, 7) : iso.slice(0, 10)
    }

    // Dense series: seed every bucket with 0 so the chart always renders a full axis.
    const userGrowthMap: Record<string, number> = {}
    for (const k of buckets) userGrowthMap[k] = 0
    for (const u of recentUsers) {
      const k = bucketKey(u.createdAt)
      if (k in userGrowthMap) userGrowthMap[k] = (userGrowthMap[k] ?? 0) + 1
    }

    const tradeVolumeMap: Record<string, { count: number; volume: number }> = {}
    for (const t of [...recentTrades, ...recentCtmTrades]) {
      const k = bucketKey(t.updatedAt)
      if (!tradeVolumeMap[k]) tradeVolumeMap[k] = { count: 0, volume: 0 }
      tradeVolumeMap[k].count += 1
      tradeVolumeMap[k].volume += t.fiatAmount ? parseFloat(t.fiatAmount.toString()) : 0
    }

    const userGrowth = buckets.map((date) => ({ date, newUsers: userGrowthMap[date] ?? 0 }))
    const tradeVolume = Object.entries(tradeVolumeMap)
      .map(([date, { count, volume }]) => ({
        date,
        count,
        // Convert PKR volume to approximate USD (rough 1 USD ≈ 280 PKR)
        volume: (volume / 280).toFixed(2),
      }))
      .sort((a, b) => a.date.localeCompare(b.date))

    // Badge distribution: always include every tier (0 default) and fold users
    // who have no TradeStats row yet into the entry tier ('new'/Bronze) so the
    // breakdown reflects the whole user base, not just users who have traded.
    const badgeDistribution: Record<string, number> = { new: 0, active: 0, trusted: 0, top: 0, elite: 0 }
    let statsUserCount = 0
    for (const b of badgeRows) {
      badgeDistribution[b.badge] = (badgeDistribution[b.badge] ?? 0) + b._count.badge
      statsUserCount += b._count.badge
    }
    const totalUserCount = await db.user.count()
    const usersWithoutStats = Math.max(0, totalUserCount - statsUserCount)
    badgeDistribution.new = (badgeDistribution.new ?? 0) + usersWithoutStats

    // Top traders: use TradeStats but enrich with live counts
    const topTradersWithLive = await Promise.all(
      topTraderRows.slice(0, 10).map(async (t) => {
        const [liveP2p, liveCTM, liveGas] = await Promise.all([
          db.trade.count({ where: { OR: [{ buyerId: t.userId }, { sellerId: t.userId }], status: 'crypto_released' } }),
          db.ctmTrade.count({ where: { OR: [{ buyerId: t.userId }, { sellerId: t.userId }], status: 'completed' } }),
          db.gasFeeOrder.count({ where: { userId: t.userId, status: 'delivered' } }),
        ])
        const totalCompleted = liveP2p + liveCTM + liveGas
        const totalAllTrades = Math.max(t.totalTrades, totalCompleted)
        const completionRate = totalAllTrades > 0 ? Math.round((totalCompleted / totalAllTrades) * 100) : 0
        return {
          userId: t.userId,
          username: t.user.username,
          badge: t.badge || 'new',
          volume: t.totalVolumePKR ? (parseFloat(t.totalVolumePKR.toString()) / 280).toFixed(2) : '0',
          tradeCount: totalCompleted,
          completionRate,
        }
      }),
    )

    // ── Engagement + conversion metrics (Phase 8) ──
    const nowMs = Date.now()
    const [dau, wau, mau, kycApproved, totalTradesAll, totalCtmAll] = await Promise.all([
      db.user.count({ where: { lastSeenAt: { gte: new Date(nowMs - 24 * 60 * 60 * 1000) } } }),
      db.user.count({ where: { lastSeenAt: { gte: new Date(nowMs - 7 * 24 * 60 * 60 * 1000) } } }),
      db.user.count({ where: { lastSeenAt: { gte: new Date(nowMs - 30 * 24 * 60 * 60 * 1000) } } }),
      db.user.count({ where: { kycStatus: 'approved' } }),
      db.trade.count(),
      db.ctmTrade.count(),
    ])
    const completedAll = p2pTotal + ctmTotal
    const attemptedAll = totalTradesAll + totalCtmAll
    const engagement = { dau, wau, mau, stickiness: mau > 0 ? Math.round((dau / mau) * 100) : 0 }
    const conversion = {
      kycApproved,
      totalUsers: totalUserCount,
      kycApprovedPct: totalUserCount > 0 ? Math.round((kycApproved / totalUserCount) * 1000) / 10 : 0,
      completedTrades: completedAll,
      attemptedTrades: attemptedAll,
      tradeCompletionPct: attemptedAll > 0 ? Math.round((completedAll / attemptedAll) * 1000) / 10 : 0,
    }

    return reply.send({
      success: true,
      data: {
        period,
        granularity,
        since,
        userGrowth,
        tradeVolume,
        badgeDistribution,
        engagement,
        conversion,
        topTraders: topTradersWithLive.filter((t) => t.tradeCount > 0 || parseFloat(t.volume) > 0).sort((a, b) => b.tradeCount - a.tradeCount),
        summary: {
          p2p:  { allTime: p2pTotal,  period: p2pPeriod },
          ctm:  { allTime: ctmTotal,  period: ctmPeriod },
          gas:  { allTime: gasTotal,  period: gasPeriod },
          total: { allTime: p2pTotal + ctmTotal + gasTotal, period: p2pPeriod + ctmPeriod + gasPeriod },
        },
      },
    })
  })

  // ── Wallet Addresses ───────────────────────────────────────────────────────

  app.get('/admin/wallet/addresses', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const addresses = await db.platformConfig.findMany({
      where: { key: { startsWith: 'deposit_address_' } },
    })
    return reply.send({ success: true, data: addresses })
  })

  app.post('/admin/wallet/addresses', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const bodySchema = z.object({
      coin: z.string().min(1).max(20),
      network: z.string().min(1).max(50),
      address: z.string().min(1),
    })
    const parsed = bodySchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    const key = `deposit_address_${parsed.data.coin.toLowerCase()}_${parsed.data.network.toLowerCase()}`
    const config = await db.platformConfig.upsert({
      where: { key },
      create: { key, value: parsed.data.address },
      update: { value: parsed.data.address },
    })
    await createAuditLog(req.user!.id, 'WALLET_ADDRESS_UPDATED', 'PlatformConfig', config.id, {
      coin: parsed.data.coin,
      network: parsed.data.network,
      address: parsed.data.address,
    }, clientIp(req), req.headers['user-agent'] as string | undefined)

    return reply.send({ success: true, data: config })
  })

  app.get('/admin/wallet/pending-payouts', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const query = req.query as Record<string, string>
    const { page, limit, skip } = paginationParams(query)

    const [withdrawals, total] = await Promise.all([
      db.withdrawal.findMany({
        where: { status: 'approved' },
        orderBy: { createdAt: 'asc' },
        skip,
        take: limit,
        include: { user: { select: { username: true, email: true } } },
      }),
      db.withdrawal.count({ where: { status: 'approved' } }),
    ])

    return reply.send({
      success: true,
      data: { withdrawals, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
    })
  })

  // GET /admin/wallet/status — aggregated platform wallet status for admin UI
  app.get('/admin/wallet/status', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const { redis: redisClient } = await import('../lib/redis')
    const { GAS_CHAINS, fromDbChain } = await import('../lib/gas/gas.chains')
    const { gasWalletIsConfigured, getEvmHotWalletAddress } = await import('../lib/gas/gasWalletService')

    const mnemonicConfigured = gasWalletIsConfigured()
    const evmHotWallet = mnemonicConfigured ? getEvmHotWalletAddress() : null
    const { getAptosHotWalletAddress } = await import('../lib/gas/aptosWalletService')
    const aptosHotWallet = mnemonicConfigured ? getAptosHotWalletAddress() : null

    // Deposit addresses: DB override → ENV var → mnemonic-derived (EVM or chain-specific)
    const envDepositMap: Array<{ coin: string; network: string; envVar: string; chain: string; evmFallback?: boolean; customFallback?: string | null }> = [
      { coin: 'USDT', network: 'TRC20',  envVar: 'GAS_FEE_DEPOSIT_ADDRESS_TRC20', chain: 'TRON' },
      { coin: 'USDT', network: 'BEP20',  envVar: 'GAS_FEE_DEPOSIT_ADDRESS_BEP20', chain: 'BSC',  evmFallback: true },
      { coin: 'USDT', network: 'ERC20',  envVar: 'GAS_FEE_DEPOSIT_ADDRESS_ERC20', chain: 'ETH',  evmFallback: true },
      { coin: 'USDT', network: 'APTOS',  envVar: 'GAS_FEE_DEPOSIT_ADDRESS_APTOS', chain: 'APT',  customFallback: aptosHotWallet },
    ]

    const dbAddresses = await db.platformConfig.findMany({
      where: { key: { startsWith: 'deposit_address_' } },
    })
    const dbMap = Object.fromEntries(dbAddresses.map((r) => [r.key, r]))

    const depositAddresses = envDepositMap.map(({ coin, network, envVar, chain, evmFallback, customFallback }) => {
      const dbKey   = `deposit_address_${coin.toLowerCase()}_${network.toLowerCase()}`
      const dbEntry = dbMap[dbKey]
      const envValue = (env as unknown as Record<string, string | undefined>)[envVar]
      // Priority: DB override → ENV var → mnemonic-derived (EVM hot wallet or chain-specific)
      const mnemonicValue = (evmFallback && evmHotWallet) ? evmHotWallet : (customFallback ?? null)
      const address = dbEntry?.value ?? envValue ?? mnemonicValue ?? null
      const source  = dbEntry ? 'db' : envValue ? 'env' : mnemonicValue ? 'mnemonic' : null
      return {
        coin,
        network,
        chain,
        address,
        source,
        configured: !!address,
        updatedAt: dbEntry?.updatedAt ?? null,
      }
    })

    // Hot wallets with balances from cache
    const allWallets = await db.gasHotWallet.findMany()
    const chainThresholds = await db.gasChainConfig.findMany({
      where: { backendChainId: { not: null } },
      select: { backendChainId: true, alertThresholdUsd: true, pauseThresholdUsd: true },
    })
    const thresholdMap = Object.fromEntries(chainThresholds.map((c) => [c.backendChainId!, c]))
    const hotWallets = await Promise.all(
      allWallets.map(async (w) => {
        const chainConfig = GAS_CHAINS[fromDbChain(w.chain)]
        const [balanceCached, isPaused, balanceUsdCached, lastFetchError] = await Promise.all([
          redisClient.get(`gas_wallet_balance:${w.chain}`),
          redisClient.get(`gas_wallet_paused:${w.chain}`),
          redisClient.get(`gas_wallet_balance_usd:${w.chain}`),
          redisClient.get(`gas_wallet_error:${w.chain}`),
        ])
        const balance = balanceCached ? parseFloat(balanceCached) : null
        const cfg = thresholdMap[w.chain as string]
        const alertThresholdUsd = cfg?.alertThresholdUsd ?? null
        const pauseThresholdUsd = cfg?.pauseThresholdUsd ?? null
        const balanceUsd = balanceUsdCached
          ? parseFloat(balanceUsdCached)
          : balance !== null && chainConfig
          ? await getNativeUsdPrice(fromDbChain(w.chain)).then((p) => balance * p).catch(() => null)
          : null
        let status: 'healthy' | 'low' | 'paused' | 'unavailable' = 'healthy'
        if (!w.isActive || isPaused) status = 'paused'
        else if (balanceUsd === null) status = 'unavailable'
        else if (pauseThresholdUsd !== null && balanceUsd <= pauseThresholdUsd) status = 'paused'
        else if (alertThresholdUsd !== null && balanceUsd <= alertThresholdUsd) status = 'low'
        // For TON, also expose user-friendly (UQ...) address for display
        const { tonRawToFriendly } = await import('../lib/gas/tonWalletService')
        const friendlyAddress = w.chain === 'TON' ? tonRawToFriendly(w.address) : null

        return {
          chain:                w.chain,
          address:              w.address,
          friendlyAddress,
          isActive:             w.isActive,
          balance,
          balanceUsd,
          nativeSymbol:         chainConfig?.nativeSymbol ?? w.chain,
          alertThresholdUsd,
          pauseThresholdUsd,
          status,
          lastFetchError:       lastFetchError ?? null,
          lastBalanceRefreshAt: w.lastBalanceRefreshAt ?? null,
        }
      }),
    )

    // Gas order summary by status
    const statusGroups = await db.gasFeeOrder.groupBy({
      by: ['status'],
      _count: { status: true },
    })
    const orderSummary = Object.fromEntries(statusGroups.map((g) => [g.status, g._count.status])) as Record<string, number>

    // Config warnings: flag missing env vars. Mnemonic system is now required.
    // When mnemonic is configured, BEP20/ERC20 deposit addresses are derived from the HD wallet —
    // their env vars are not needed and must not be flagged as warnings.
    const requiredEnvChecks: Array<{ key: string; label: string; required: boolean }> = [
      { key: 'GAS_MASTER_KEY',                 label: 'Gas wallet master key (mnemonic)',          required: true  },
      { key: 'GAS_SEED_CIPHERTEXT',            label: 'Gas wallet seed ciphertext',                required: true  },
      { key: 'GAS_FEE_DEPOSIT_ADDRESS_TRC20',  label: 'TRON deposit address',                      required: true  },
      { key: 'TRON_FULLNODE_URL',              label: 'TRON full node URL',                        required: true  },
      { key: 'TRONGRID_API_KEY',               label: 'TronGrid API key (rate-limit enhancement)', required: false },
      // Only warn if mnemonic is NOT configured — otherwise the EVM hot wallet covers these
      ...(!mnemonicConfigured ? [
        { key: 'GAS_FEE_DEPOSIT_ADDRESS_BEP20', label: 'BSC deposit address (override for non-mnemonic)', required: false },
        { key: 'GAS_FEE_DEPOSIT_ADDRESS_ERC20', label: 'ETH deposit address (override for non-mnemonic)', required: false },
      ] : []),
    ]
    const configWarnings = requiredEnvChecks
      .filter(({ key }) => !(env as unknown as Record<string, string | undefined>)[key])
      .map(({ key, label, required }) => ({ key, label, required }))

    return reply.send({
      success: true,
      data: {
        depositAddresses,
        hotWallets,
        orderSummary,
        configWarnings,
        mnemonicConfigured,
        evmHotWallet,
      },
    })
  })

  // ── Audit Log ──────────────────────────────────────────────────────────────

  app.get('/admin/audit-log', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const query = req.query as Record<string, string>
    const { limit, skip } = paginationParams(query)

    const where: Record<string, unknown> = {}
    if (query.adminId) where.actorId = query.adminId
    if (query.targetType) where.targetType = query.targetType

    const [logs, total] = await Promise.all([
      db.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          actor: { select: { username: true, email: true } },
        },
      }),
      db.auditLog.count({ where }),
    ])

    const entries = logs.map((l) => {
      const meta = (l.metadata ?? {}) as Record<string, unknown>
      // Strip legacy _ip/_ua keys from the displayed metadata — they now live in
      // dedicated columns and would otherwise duplicate in the raw JSON view.
      const { _ip, _ua, ...cleanMeta } = meta as Record<string, unknown> & { _ip?: unknown; _ua?: unknown }
      return {
        id:         l.id,
        userId:     l.actorId,
        user:       l.actor,
        action:     l.action,
        targetType: l.targetType,
        targetId:   l.targetId,
        details:    cleanMeta,
        // Prefer the dedicated column; fall back to legacy metadata for old rows.
        ip:         l.ipAddress ?? (typeof _ip === 'string' ? _ip : null),
        userAgent:  l.userAgent ?? (typeof _ua === 'string' ? _ua : null),
        createdAt:  l.createdAt,
      }
    })

    return reply.send({
      success: true,
      data: { entries, total },
    })
  })

  // ── Tx-verification override audit ────────────────────────────────────────
  // GET /admin/reports/tx-verification-overrides
  // Returns all manual "approve-tx-verification" override events so operators
  // can audit admin behaviour and detect abuse. Includes a spike flag when
  // more than SPIKE_THRESHOLD overrides occurred in the last 24 hours.
  app.get('/admin/reports/tx-verification-overrides', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const query = req.query as Record<string, string>
    const { page, limit, skip } = paginationParams(query)
    const SPIKE_THRESHOLD = 10          // alert if > 10 overrides in any rolling 24h window
    const ROLLING_WINDOW_MS = 24 * 3_600_000

    const [logs, total, last24h] = await Promise.all([
      db.auditLog.findMany({
        where: { action: 'TRADE_TX_VERIFICATION_APPROVED' },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { actor: { select: { id: true, username: true, email: true } } },
      }),
      db.auditLog.count({ where: { action: 'TRADE_TX_VERIFICATION_APPROVED' } }),
      db.auditLog.count({
        where: {
          action: 'TRADE_TX_VERIFICATION_APPROVED',
          createdAt: { gte: new Date(Date.now() - ROLLING_WINDOW_MS) },
        },
      }),
    ])

    const spikeDetected = last24h > SPIKE_THRESHOLD

    const overrides = logs.map((l) => ({
      id:         l.id,
      adminId:    l.actorId,
      adminName:  l.actor.username,
      adminEmail: l.actor.email,
      tradeId:    l.targetId,
      reason:     (l.metadata as Record<string, unknown>)?.reason ?? null,
      txHash:     (l.metadata as Record<string, unknown>)?.sellerTxHash ?? null,
      prevStatus: (l.metadata as Record<string, unknown>)?.previousStatus ?? null,
      createdAt:  l.createdAt,
    }))

    return reply.send({
      success: true,
      data: {
        overrides,
        total,
        last24hCount: last24h,
        spikeDetected,
        spikeThreshold: SPIKE_THRESHOLD,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      },
    })
  })

  // ── Gas Fee Admin ──────────────────────────────────────────────────────────

  // GET /admin/gas/poller-health — at-a-glance liveness of each payment poller.
  // A network is "healthy" if it was scanned within HEALTHY_WINDOW (the poller
  // ticks ~every 60s). APTOS has no automatic detection and is reported as such.
  app.get('/admin/gas/poller-health', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const HEALTHY_WINDOW_MS = 5 * 60 * 1000   // green:  scanned successfully within 5 min
    const DELAYED_WINDOW_MS = 30 * 60 * 1000  // yellow: last success within 30 min (else red)
    const POLLED_NETWORKS = ['TRC20', 'BEP20', 'ERC20', 'APTOS']
    const now = Date.now()
    const iso = (t?: number | null) => (typeof t === 'number' ? new Date(t).toISOString() : null)

    const networks = await Promise.all(
      POLLED_NETWORKS.map(async (network) => {
        const raw = await redis.get(`gas_poller_health:${network}`).catch(() => null)
        let p: Record<string, unknown> = {}
        if (raw) { try { p = JSON.parse(raw) as Record<string, unknown> } catch { /* ignore */ } }

        const lastTickAt = (p.lastTickAt ?? p.at) as number | undefined
        const lastSuccessAt = p.lastSuccessAt as number | undefined
        const lastErrorAt = p.lastErrorAt as number | undefined
        const configured = p.configured !== false
        const sinceSuccess = lastSuccessAt ? now - lastSuccessAt : Infinity

        // Health: red if never succeeded / misconfigured / stale >30m; yellow if
        // a recent success but the latest tick errored, or success is 5–30m old;
        // green if a successful scan within the last 5 min.
        let status: 'green' | 'yellow' | 'red'
        if (!configured) status = 'red'
        else if (sinceSuccess < HEALTHY_WINDOW_MS) status = p.ok === false ? 'yellow' : 'green'
        else if (sinceSuccess < DELAYED_WINDOW_MS) status = 'yellow'
        else status = 'red'

        return {
          network,
          configured,
          status,
          ok: p.ok ?? null,
          lastTickAt: iso(lastTickAt),
          lastSuccessAt: iso(lastSuccessAt),
          lastErrorAt: iso(lastErrorAt),
          lastError: (p.lastError as string | null) ?? null,
          lastFound: (p.found as number | undefined) ?? null,
          currentBlock: (p.currentBlock as number | undefined) ?? null,
          syncedBlock: (p.syncedBlock as number | undefined) ?? null,
          ageSeconds: lastTickAt ? Math.round((now - lastTickAt) / 1000) : null,
          successAgeSeconds: lastSuccessAt ? Math.round((now - lastSuccessAt) / 1000) : null,
          // legacy field kept for any older client
          healthy: status === 'green',
        }
      }),
    )

    return reply.send({ success: true, data: { networks, healthyWindowSeconds: HEALTHY_WINDOW_MS / 1000 } })
  })

  // GET /admin/gas/detection-providers — live health of the providers that DETECT
  // incoming payments (Etherscan / Alchemy / public RPC / Moralis per EVM network,
  // TronGrid for TRC20, Aptos Indexer for APTOS). Answers "can we see payments right
  // now, and on which provider?" — payment detection is the critical money-path.
  // Best-effort: each probe has a short timeout and runs in parallel, so a dead
  // provider can never block this endpoint.
  app.get('/admin/gas/detection-providers', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const { probeDetectionProviders } = await import('../lib/gas/detectionProviders')
    const networks = await probeDetectionProviders().catch(() => [])
    return reply.send({
      success: true,
      data: {
        networks,
        // network-level: false if ANY network can no longer detect payments
        allCanDetect: networks.every((n) => n.canDetect),
        fetchedAt: new Date().toISOString(),
      },
    })
  })

  // GET /admin/gas/chain-health — live RPC health for EVERY supported gas chain
  // (Ethereum, BNB, Base, Polygon, Arbitrum, Optimism, Avalanche, Tron, Solana,
  // TON, Sui). green = reachable & fresh, yellow = reachable but stale node,
  // red = unreachable. Complements poller-health (which is payment-detection).
  app.get('/admin/gas/chain-health', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const { GAS_CHAINS } = await import('../lib/gas/gas.chains')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ids = Object.keys(GAS_CHAINS) as any[]
    const results = await Promise.allSettled(
      ids.map(async (id) => {
        const cfg = GAS_CHAINS[id as keyof typeof GAS_CHAINS]
        const health = await testRpcHealth(id)
        const status: 'green' | 'yellow' | 'red' = !health.reachable ? 'red' : health.isStale ? 'yellow' : 'green'
        return {
          chain: id as string,
          name: cfg.name,
          nativeSymbol: cfg.nativeSymbol,
          networkLabel: cfg.networkLabel,
          status,
          reachable: health.reachable,
          blockNumber: health.blockNumber ?? null,
          latencyMs: health.latencyMs,
          isStale: !!health.isStale,
          error: health.error ?? null,
          deliveryImplemented: cfg.deliveryImplemented,
        }
      }),
    )
    const chains = results.map((r, i) => r.status === 'fulfilled' ? r.value : {
      chain: ids[i] as string, name: ids[i] as string, nativeSymbol: '', networkLabel: '',
      status: 'red' as const, reachable: false, blockNumber: null, latencyMs: 0, isStale: false,
      error: r.reason instanceof Error ? r.reason.message : 'health check failed', deliveryImplemented: false,
    })
    const summary = {
      green: chains.filter((c) => c.status === 'green').length,
      yellow: chains.filter((c) => c.status === 'yellow').length,
      red: chains.filter((c) => c.status === 'red').length,
    }
    return reply.send({ success: true, data: { chains, summary, fetchedAt: new Date().toISOString() } })
  })

  app.get('/admin/gas/orders', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const query = req.query as Record<string, string>
    const { page, limit, skip } = paginationParams(query)

    const where: Record<string, unknown> = {}
    // 'active' is a dashboard convenience group matching the Active Orders KPI
    // (everything still in flight, pre-delivery). All other values are exact.
    if (query.status === 'active') {
      where.status = { in: ['payment_pending', 'payment_uploaded', 'payment_verified', 'payment_detected', 'sending'] }
    } else if (query.status) {
      where.status = query.status
    }
    // Strict PKR vs crypto separation. PKR orders carry paymentCoin='PKR';
    // crypto orders carry 'USDT' (or any non-PKR coin). Lets the dashboard link
    // straight to "PKR proof review" or "crypto" without mixing payment types.
    if (query.paymentType === 'PKR' || query.paymentCoin === 'PKR') {
      where.paymentCoin = 'PKR'
    } else if (query.paymentType === 'CRYPTO') {
      where.paymentCoin = { not: 'PKR' }
    } else if (query.paymentCoin) {
      where.paymentCoin = query.paymentCoin
    }
    // Free-grant history: platform-funded ($0) deliveries from the Free Gas tool.
    if (query.freeGrant === 'true') where.isFreeGrant = true

    const [orders, total] = await Promise.all([
      db.gasFeeOrder.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { user: { select: { username: true, email: true } } },
      }),
      db.gasFeeOrder.count({ where }),
    ])

    return reply.send({
      success: true,
      data: { orders, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
    })
  })

  // GET /admin/gas/wallet-activity — paginated ledger-based hot-wallet activity feed
  // Queries GasLedgerEntry (the authoritative financial record) which covers:
  //   order_payment            — user USDT payment received
  //   gas_delivery             — gas sent to user
  //   delivery_refund          — refund to user
  //   refill_hot_from_treasury — treasury top-up
  //   drain_hot_to_treasury    — emergency drain
  //   external_hot_wallet_deposit — direct admin top-up (e.g. manual POL send)
  app.get('/admin/gas/wallet-activity', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const query = req.query as Record<string, string>
    const { page, limit, skip } = paginationParams(query)

    const andClauses: Record<string, unknown>[] = []
    if (query.chain)      andClauses.push({ chain: query.chain })
    if (query.entryType)  andClauses.push({ entryType: query.entryType })
    if (query.from)       andClauses.push({ createdAt: { gte: new Date(query.from) } })
    if (query.to)         andClauses.push({ createdAt: { lte: new Date(query.to) } })
    if (query.search) {
      const s = query.search
      andClauses.push({
        OR: [
          { txHash:      { contains: s, mode: 'insensitive' } },
          { fromAddress: { contains: s, mode: 'insensitive' } },
          { toAddress:   { contains: s, mode: 'insensitive' } },
          { notes:       { contains: s, mode: 'insensitive' } },
          // Related gas order: order ref, recipient address, and the user behind it
          { relatedOrder: { orderRef:  { contains: s, mode: 'insensitive' } } },
          { relatedOrder: { toAddress: { contains: s, mode: 'insensitive' } } },
          { relatedOrder: { user: { username: { contains: s, mode: 'insensitive' } } } },
          { relatedOrder: { user: { email:    { contains: s, mode: 'insensitive' } } } },
          { relatedOrder: { user: { fullName: { contains: s, mode: 'insensitive' } } } },
        ],
      })
    }

    const where = andClauses.length > 0 ? { AND: andClauses } : {}

    const [entries, total] = await Promise.all([
      db.gasLedgerEntry.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true, entryType: true, chain: true,
          nativeAmount: true, nativeSymbol: true, tokenSymbol: true, tokenAmount: true, usdAmount: true,
          txHash: true, fromAddress: true, toAddress: true,
          notes: true, createdAt: true,
          relatedOrder: { select: { orderRef: true, status: true, paymentCoin: true, paymentNetwork: true } },
        },
      }),
      db.gasLedgerEntry.count({ where }),
    ])

    return reply.send({
      success: true,
      data: { activity: entries, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
    })
  })

  // GET /admin/gas/wallet-activity/:id/verify — forensic on-chain verification of a
  // single ledger entry. Confirms the recorded txHash actually exists on-chain and
  // that the native receiver + amount match what the ledger claims. Answers
  // questions like "is this +6 BNB hot-wallet deposit a real transaction?".
  app.get('/admin/gas/wallet-activity/:id/verify', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const entry = await db.gasLedgerEntry.findUnique({
      where: { id },
      select: { id: true, chain: true, entryType: true, txHash: true, fromAddress: true, toAddress: true, nativeAmount: true, nativeSymbol: true, tokenSymbol: true, tokenAmount: true },
    })
    if (!entry) throw Errors.NOT_FOUND('Ledger entry')

    const { fromDbChain, GAS_CHAINS } = await import('../lib/gas/gas.chains')
    const EVM_CHAINS = ['BSC', 'ETHEREUM', 'BASE', 'ARB', 'OP', 'MATIC', 'AVAX']

    const respond = (status: string, verified: boolean | null, message: string, extra: Record<string, unknown> = {}) =>
      reply.send({ success: true, data: { status, verified, message, entryId: entry.id, chain: entry.chain, txHash: entry.txHash, ...extra } })

    if (!entry.txHash) {
      return respond('no_tx_hash', null, 'This is an internal ledger entry with no on-chain transaction to verify.')
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let chainId: any
    try { chainId = fromDbChain(entry.chain as string) } catch { chainId = null }
    if (!chainId || !EVM_CHAINS.includes(chainId)) {
      return respond('unsupported_chain', null, `Automated verification isn't available for ${entry.chain} yet — verify this transaction on the block explorer.`)
    }

    const cfg = GAS_CHAINS[chainId as keyof typeof GAS_CHAINS]
    const rpcUrl = cfg?.getRpcUrl?.()
    if (!rpcUrl) {
      return respond('rpc_unavailable', null, `No RPC endpoint is configured for ${entry.chain}; cannot verify automatically.`)
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let tx: any
    try {
      tx = await getTransactionByHash(rpcUrl, chainId, entry.txHash)
    } catch (err) {
      return respond('rpc_error', null, `RPC error while fetching the transaction: ${(err as Error)?.message ?? 'unknown'}`)
    }
    if (!tx) {
      return respond('not_found', false, '⚠ Transaction not found on-chain. This may be an internal adjustment, an import artifact, or a wrong/old hash — investigate.')
    }

    const onChain = {
      from: tx.from ?? null,
      to: (tx.to as string | null) ?? null,
      nativeValue: Number(tx.value) / 1e18,
      blockNumber: tx.blockNumber != null ? Number(tx.blockNumber) : null,
      explorerUrl: cfg.explorerBase ? `${cfg.explorerBase.replace(/\/$/, '')}/tx/${entry.txHash}` : null,
    }
    const expectedTo = (entry.toAddress ?? '').toLowerCase()
    const receiverMatch = !expectedTo || (onChain.to ?? '').toLowerCase() === expectedTo

    // Token transfers (e.g. USDT order payments) carry native value 0 — the amount
    // lives in an ERC20 Transfer log. For chains where we know the USDT contract we
    // parse the receipt logs and verify the exact token amount + receiver.
    if (entry.tokenSymbol) {
      const USDT_CONTRACTS: Record<string, { addr: string; decimals: number }> = {
        BSC:      { addr: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
        ETHEREUM: { addr: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
      }
      const usdtCfg = /usdt/i.test(entry.tokenSymbol) ? USDT_CONTRACTS[chainId] : undefined
      const expectedTokenAmt = entry.tokenAmount != null ? Math.abs(Number(entry.tokenAmount)) : null

      if (usdtCfg) {
        const { getTransactionReceiptWithLogs, parseErc20Transfers } = await import('../lib/evmRpc')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let receipt: any
        try {
          receipt = await getTransactionReceiptWithLogs(rpcUrl, chainId, entry.txHash)
        } catch (err) {
          return respond('rpc_error', null, `RPC error while fetching the receipt: ${(err as Error)?.message ?? 'unknown'}`)
        }
        if (!receipt) return respond('not_found', false, '⚠ Transaction receipt not found on-chain — investigate.')
        if (receipt.status === '0x0') return respond('reverted', false, '⚠ On-chain transaction reverted (status 0) — no tokens moved.')

        const transfers = parseErc20Transfers(receipt.logs, usdtCfg.addr)
        const tol = expectedTokenAmt != null ? Math.max(1e-6, expectedTokenAmt * 0.001) : 0
        const toMatches = transfers.filter((t) => !expectedTo || t.to.toLowerCase() === expectedTo)
        const exact = toMatches.find((t) => expectedTokenAmt == null || Math.abs(Number(t.value) / 10 ** usdtCfg.decimals - expectedTokenAmt) <= tol)
        const tokenOnChain = { to: exact?.to ?? toMatches[0]?.to ?? null, amount: exact ? Number(exact.value) / 10 ** usdtCfg.decimals : (toMatches[0] ? Number(toMatches[0].value) / 10 ** usdtCfg.decimals : null), blockNumber: receipt.blockNumber != null ? Number(receipt.blockNumber) : null, explorerUrl: onChain.explorerUrl }

        if (exact) {
          return respond('verified', true, `✓ Verified: ${tokenOnChain.amount} ${entry.tokenSymbol} to ${exact.to} confirmed on-chain at block ${tokenOnChain.blockNumber}.`,
            { onChain: tokenOnChain, expected: { to: entry.toAddress, tokenAmount: expectedTokenAmt, tokenSymbol: entry.tokenSymbol } })
        }
        if (toMatches.length > 0) {
          return respond('mismatch_amount', false, `Amount mismatch: on-chain ${tokenOnChain.amount} ${entry.tokenSymbol} to the wallet, ledger recorded ${expectedTokenAmt} ${entry.tokenSymbol}.`,
            { onChain: tokenOnChain, expected: { to: entry.toAddress, tokenAmount: expectedTokenAmt, tokenSymbol: entry.tokenSymbol } })
        }
        return respond('mismatch_receiver', false, `No ${entry.tokenSymbol} transfer to ${entry.toAddress} found in this transaction.`,
          { onChain: tokenOnChain, expected: { to: entry.toAddress, tokenAmount: expectedTokenAmt, tokenSymbol: entry.tokenSymbol } })
      }

      // Unknown token contract for this chain — fall back to existence + receiver.
      return respond(receiverMatch ? 'token_confirmed' : 'mismatch_receiver', receiverMatch,
        receiverMatch
          ? `On-chain transaction confirmed (block ${onChain.blockNumber}). ${entry.tokenSymbol} token-amount verification isn't automated for ${entry.chain} — confirm on the explorer.`
          : `Receiver mismatch: on-chain recipient is ${onChain.to}, ledger expected ${entry.toAddress}.`,
        { onChain, expected: { to: entry.toAddress, nativeAmount: Number(entry.nativeAmount), tokenAmount: expectedTokenAmt, tokenSymbol: entry.tokenSymbol } })
    }

    const expectedAmount = Math.abs(Number(entry.nativeAmount))
    const tolerance = Math.max(1e-9, expectedAmount * 0.001)
    const amountMatch = Math.abs(onChain.nativeValue - expectedAmount) <= tolerance

    let status: string
    let message: string
    if (!receiverMatch) { status = 'mismatch_receiver'; message = `Receiver mismatch: on-chain recipient is ${onChain.to}, ledger expected ${entry.toAddress}.` }
    else if (!amountMatch) { status = 'mismatch_amount'; message = `Amount mismatch: on-chain ${onChain.nativeValue} ${entry.nativeSymbol}, ledger recorded ${expectedAmount} ${entry.nativeSymbol}.` }
    else { status = 'verified'; message = `✓ Verified: ${onChain.nativeValue} ${entry.nativeSymbol} to ${onChain.to} confirmed on-chain at block ${onChain.blockNumber}.` }

    return respond(status, status === 'verified', message,
      { onChain, expected: { to: entry.toAddress, nativeAmount: expectedAmount } })
  })

  // GET /admin/gas/hot-wallet-balances — live on-chain balance for every active hot wallet
  app.get('/admin/gas/hot-wallet-balances', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const { getHotWalletBalance, getNativeUsdPrice } = await import('../lib/gas/gas.balance')
    const { fromDbChain } = await import('../lib/gas/gas.chains')
    const { tonRawToFriendly } = await import('../lib/gas/tonWalletService')

    const wallets = await db.gasHotWallet.findMany({
      where: { isActive: true },
      select: { chain: true, address: true },
      orderBy: { chain: 'asc' },
    })

    // TON addresses are stored raw (0:hex64); expose the user-friendly UQ… form for display.
    const friendlyOf = (chain: string, addr: string) => (chain === 'TON' ? tonRawToFriendly(addr) : null)

    const results = await Promise.allSettled(
      wallets.map(async (w) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chainId = fromDbChain(w.chain) as any
        const [balance, usdPrice, tokens] = await Promise.all([
          getHotWalletBalance(chainId, w.address),
          getNativeUsdPrice(chainId).catch(() => 0),
          getWalletTokenBalances(w.chain as string, w.address).catch(() => []),
        ])
        return {
          chain: w.chain as string,
          address: w.address,
          friendlyAddress: friendlyOf(w.chain as string, w.address),
          balance,
          balanceUsd: balance * usdPrice,
          nativeSymbol: nativeSymbol(chainId as string),
          tokens,
          fetchedAt: new Date().toISOString(),
          error: null as string | null,
        }
      }),
    )

    const balances = results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value
      return {
        chain: wallets[i]!.chain as string,
        address: wallets[i]!.address,
        friendlyAddress: friendlyOf(wallets[i]!.chain as string, wallets[i]!.address),
        balance: null as number | null,
        balanceUsd: null as number | null,
        nativeSymbol: wallets[i]!.chain as string,
        tokens: [] as Array<{ symbol: string; name: string; balanceFormatted: number; tokenAddress: string }>,
        fetchedAt: new Date().toISOString(),
        error: r.reason instanceof Error ? r.reason.message : 'Failed to fetch',
      }
    })

    // Inject Aptos APT gas wallet — inbound-only rail with no GasHotWallet row
    const { getAptosHotWalletAddress: getAptAddr } = await import('../lib/gas/aptosWalletService')
    const aptAddr = getAptAddr()
    let allBalances: typeof balances = balances
    if (aptAddr) {
      const aptCached   = await redis.get('gas_aptos_apt_balance')
      const aptBalance  = aptCached !== null ? parseFloat(aptCached) : null
      const aptUsdRaw   = await redis.get('rate:APT').catch(() => null)
      const aptUsdPrice = aptUsdRaw
        ? (() => { try { return (JSON.parse(aptUsdRaw) as { usdPrice?: number }).usdPrice ?? 0 } catch { return 0 } })()
        : 0
      // Explicit health status so a failed read renders as "Balance Unknown"
      // (never a misleading 0): null balance => unavailable; below the APT gas
      // floor => low; otherwise healthy.
      const aptStatus: 'healthy' | 'low' | 'unavailable' =
        aptBalance === null ? 'unavailable'
        : aptBalance < env.GAS_APTOS_MIN_APT ? 'low'
        : 'healthy'
      const aptEntry = {
        chain: 'APT' as string,
        address: aptAddr,
        friendlyAddress: null as string | null,
        balance: aptBalance as number | null,
        balanceUsd: (aptBalance !== null && aptUsdPrice > 0 ? aptBalance * aptUsdPrice : null) as number | null,
        nativeSymbol: 'APT',
        status: aptStatus,
        pauseReason: null as string | null,
        tokens: [] as Array<{ symbol: string; name: string; balanceFormatted: number; tokenAddress: string }>,
        fetchedAt: new Date().toISOString(),
        error: aptBalance === null ? 'Balance temporarily unavailable — Aptos node unreachable' : null,
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      allBalances = [...balances, aptEntry as any]
    }

    // Inject any other chains registered in GasChainConfig with depositAddressOverride
    // but no GasHotWallet row (and not already handled above as Aptos).
    const coveredChains = new Set([
      ...wallets.map((w) => (w.chain as string).toUpperCase()),
      'APT',
    ])
    const registryOverrides = await db.gasChainConfig.findMany({
      where: { isActive: true, depositAddressOverride: { not: null } },
      select: { slug: true, symbol: true, depositAddressOverride: true },
    }).catch(() => [] as Array<{ slug: string; symbol: string; depositAddressOverride: string | null }>)

    const pendingRegistry = registryOverrides.filter(
      (cfg) => cfg.depositAddressOverride && !coveredChains.has(cfg.slug.toUpperCase()),
    )
    if (pendingRegistry.length > 0) {
      const registryResults = await Promise.allSettled(
        pendingRegistry.map(async (cfg) => {
          const address = cfg.depositAddressOverride!
          const [cachedBal, rateRaw] = await Promise.all([
            redis.get(`gas_wallet_balance:${cfg.slug}`).catch(() => null),
            redis.get(`rate:${cfg.symbol.toUpperCase()}`).catch(() => null),
          ])
          const balance = cachedBal !== null ? parseFloat(cachedBal) : null
          const usdPrice = rateRaw
            ? (() => { try { return (JSON.parse(rateRaw) as { usdPrice?: number }).usdPrice ?? 0 } catch { return 0 } })()
            : 0
          return {
            chain: cfg.slug as string,
            address,
            friendlyAddress: null as string | null,
            balance,
            balanceUsd: (balance !== null && usdPrice > 0 ? balance * usdPrice : null) as number | null,
            nativeSymbol: cfg.symbol,
            tokens: [] as Array<{ symbol: string; name: string; balanceFormatted: number; tokenAddress: string }>,
            fetchedAt: new Date().toISOString(),
            error: null as string | null,
          }
        }),
      )
      for (const r of registryResults) {
        if (r.status === 'fulfilled') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          allBalances = [...allBalances, r.value as any]
        }
      }
    }

    return reply.send({ success: true, data: { balances: allBalances, fetchedAt: new Date().toISOString() } })
  })

  // GET /admin/treasury/overview — aggregated platform treasury snapshot.
  // Real balances only (no placeholders): live hot + treasury native balances
  // per chain, hot-wallet USDT, plus DB-derived escrow (locked collateral),
  // user custody, and lifetime platform revenue. USDT is treated 1:1 with USD.
  app.get('/admin/treasury/overview', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const { getHotWalletBalance, getNativeUsdPrice } = await import('../lib/gas/gas.balance')
    const { fromDbChain } = await import('../lib/gas/gas.chains')

    const usdtRaw = await redis.get('rate:USDT').catch(() => null)
    const usdPkr = usdtRaw ? (() => { try { return (JSON.parse(usdtRaw) as { rate?: number }).rate ?? 278.5 } catch { return 278.5 } })() : 278.5

    const activeWallets = await db.gasHotWallet.findMany({ where: { isActive: true }, select: { chain: true, address: true }, orderBy: { chain: 'asc' } })

    const settled = await Promise.allSettled(
      activeWallets.map(async (w) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chainId = fromDbChain(w.chain) as any
        // NOTE: on EVM/TRON the treasury address is derived at the same HD index
        // as the hot wallet (index 0), so it IS the hot wallet — reading it again
        // double-counts the same on-chain funds. Treasury is therefore not a
        // separate balance and is excluded here (treasuryNative kept at 0).
        const [hotNative, price, tokens] = await Promise.all([
          getHotWalletBalance(chainId, w.address).catch(() => 0),
          getNativeUsdPrice(chainId).catch(() => 0),
          getWalletTokenBalances(w.chain as string, w.address).catch(() => [] as Array<{ symbol: string; balanceFormatted: number }>),
        ])
        const usdtToken = (tokens ?? []).filter((t) => /usdt/i.test(t.symbol)).reduce((a, t) => a + (t.balanceFormatted || 0), 0)
        return {
          chain: w.chain as string,
          symbol: nativeSymbol(chainId as string),
          hotNative, hotUsd: hotNative * price,
          treasuryNative: 0, treasuryUsd: 0,
          usdtUsd: usdtToken,
          error: null as string | null,
        }
      }),
    )
    const wallets = settled.map((r, i) => r.status === 'fulfilled' ? r.value : {
      chain: activeWallets[i]!.chain as string, symbol: activeWallets[i]!.chain as string,
      hotNative: 0, hotUsd: 0, treasuryNative: 0, treasuryUsd: 0, usdtUsd: 0,
      error: r.reason instanceof Error ? r.reason.message : 'Failed to fetch',
    })

    const [lockedAgg, custodyAgg, revenueAgg] = await Promise.all([
      db.wallet.aggregate({ _sum: { lockedBalance: true } }),
      db.wallet.aggregate({ _sum: { balance: true } }),
      db.gasLedgerEntry.aggregate({ _sum: { usdAmount: true }, where: { entryType: { in: ['platform_fee', 'platform_fee_sweep'] } } }),
    ])
    const escrowUsdt = Number(lockedAgg._sum.lockedBalance ?? 0)
    const custodyUsdt = Number(custodyAgg._sum.balance ?? 0)
    const platformRevenueUsd = Number(revenueAgg._sum.usdAmount ?? 0)

    const hotNativeUsd = wallets.reduce((a, w) => a + w.hotUsd, 0)
    const hotUsdtUsd = wallets.reduce((a, w) => a + w.usdtUsd, 0)
    const treasuryUsd = wallets.reduce((a, w) => a + w.treasuryUsd, 0)
    const hotTotalUsd = hotNativeUsd + hotUsdtUsd
    const platformControlledUsd = hotTotalUsd + treasuryUsd

    const perChain = wallets
      .map((w) => ({ chain: w.chain, symbol: w.symbol, hotNative: w.hotNative, treasuryNative: w.treasuryNative, usd: w.hotUsd + w.treasuryUsd + w.usdtUsd }))
      .sort((a, b) => b.usd - a.usd)

    const tokenMap: Record<string, { symbol: string; amount: number; usd: number }> = {}
    for (const w of wallets) {
      const k = w.symbol
      tokenMap[k] = tokenMap[k] ?? { symbol: k, amount: 0, usd: 0 }
      tokenMap[k].amount += w.hotNative + w.treasuryNative
      tokenMap[k].usd += w.hotUsd + w.treasuryUsd
    }
    if (hotUsdtUsd > 0) tokenMap.USDT = { symbol: 'USDT', amount: hotUsdtUsd, usd: hotUsdtUsd }
    const perToken = Object.values(tokenMap).filter((t) => t.usd > 0 || t.amount > 0).sort((a, b) => b.usd - a.usd)

    return reply.send({
      success: true,
      data: {
        usdPkrRate: usdPkr,
        platformControlledUsd,
        categories: {
          hot: { usd: hotTotalUsd, nativeUsd: hotNativeUsd, usdtUsd: hotUsdtUsd },
          treasury: { usd: treasuryUsd },
          escrow: { usdt: escrowUsdt },
          custody: { usdt: custodyUsdt },
          revenue: { usd: platformRevenueUsd },
        },
        perChain, perToken, wallets,
        fetchedAt: new Date().toISOString(),
      },
    })
  })

  // POST /admin/gas/wallet-activity/manual — super_admin creates a manual ledger entry for a missed deposit
  app.post('/admin/gas/wallet-activity/manual', { preHandler: [authenticate, superAdminOnly] }, async (req, reply) => {
    const body = req.body as {
      chain: string
      nativeAmount: number
      txHash?: string
      fromAddress?: string
      toAddress?: string
      notes?: string
    }

    if (!body.chain || !body.nativeAmount || body.nativeAmount <= 0) {
      return reply.code(400).send({ success: false, error: 'chain and nativeAmount (> 0) are required' })
    }

    const { fromDbChain } = await import('../lib/gas/gas.chains')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chainId = fromDbChain(body.chain as any) as any

    const entry = await appendLedgerEntry({
      entryType:   'external_hot_wallet_deposit',
      chain:       chainId,
      nativeAmount: body.nativeAmount,
      ...(body.txHash      ? { txHash:      body.txHash }      : {}),
      ...(body.fromAddress ? { fromAddress: body.fromAddress } : {}),
      ...(body.toAddress   ? { toAddress:   body.toAddress }   : {}),
      notes: body.notes ?? 'Manual entry by admin',
    })
    if (!entry) throw new Error('appendLedgerEntry returned null unexpectedly for manual entry')

    await createAuditLog(req.user!.id, 'GAS_MANUAL_LEDGER_ENTRY', 'GasLedgerEntry', entry.id, {
      chain: body.chain, nativeAmount: body.nativeAmount, txHash: body.txHash ?? null,
    }, clientIp(req), req.headers['user-agent'] as string | undefined)

    return reply.code(201).send({ success: true, data: entry })
  })

  app.post('/admin/gas/orders/:id/retry', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }

    // CAS: transition failed/awaiting_refund → payment_detected so the delivery
    // worker can re-claim it. For awaiting_refund we also clear the refund window.
    // Concurrent retries find count=0 on the second call and fall through below.
    const claimed = await db.gasFeeOrder.updateMany({
      where: { id, status: { in: ['failed', 'awaiting_refund'] } },
      data: { status: 'payment_detected', failureReason: null, refundEligibleAt: null, retryCount: { increment: 1 } },
    })

    let previousStatus = 'failed'
    if (claimed.count === 0) {
      const order = await db.gasFeeOrder.findUnique({ where: { id } })
      if (!order) throw Errors.NOT_FOUND('Gas fee order')
      // An order paused on insufficient hot-wallet balance sits in payment_detected
      // (not failed). After the admin refills the wallet, "Retry" simply re-enqueues
      // the delivery job — the order is already in the claimable state.
      if (order.status === 'payment_detected') {
        previousStatus = 'payment_detected'
        await db.gasFeeOrder.update({ where: { id }, data: { failureReason: null } })
      } else {
        throw new AppError('CONFLICT', `Order is in '${order.status}' — only failed, stuck (payment_detected), or awaiting_refund orders can be retried`, 409)
      }
    } else {
      // Came from awaiting_refund (or failed): drop the pending safety-net auto-refund
      // so it can't fire after a manual retry. The retry-delivery chain self-stops.
      try { await queues.gasFee.remove(`gas-auto-refund-${id}`) } catch { /* non-fatal */ }
    }

    await queues.gasFee.add('deliver', { orderId: id }, { priority: 1 })
    await createAuditLog(req.user!.id, 'GAS_ORDER_RETRY', 'GasFeeOrder', id, { previousStatus }, clientIp(req), req.headers['user-agent'] as string | undefined)

    return reply.send({ success: true })
  })

  app.post('/admin/gas/orders/:id/refund', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const order = await db.gasFeeOrder.findUnique({ where: { id } })
    if (!order) throw Errors.NOT_FOUND('Gas fee order')

    // A refund only makes sense for orders that took a payment but never delivered.
    // 'payment_detected' is included so an order stuck because the hot wallet is
    // empty (insufficient balance — delivery paused, not yet failed) can be
    // refunded directly from the admin order page without waiting for expiry.
    // 'awaiting_refund' is the post-delivery-failure window: the system is still
    // retrying and the user can self-refund once it elapses, but an admin may also
    // force the refund immediately from here.
    if (!['failed', 'refund_pending', 'expired', 'payment_detected', 'awaiting_refund'].includes(order.status)) {
      throw new AppError(
        'INVALID_STATUS',
        `Cannot refund an order with status '${order.status}'. Only failed / refund_pending / expired / payment_detected / awaiting_refund orders can be refunded.`,
        400,
      )
    }

    // Two modes:
    //   auto   — resolve the original payer from the payment tx and send back to them.
    //   manual — send to an admin-specified address (e.g. when the payer asked for a
    //            different address, or there is no resolvable on-chain sender).
    // Either way the refund settles on the PAYMENT network's chain (BEP20→BSC,
    // APTOS→Aptos, …), never the gas-delivery chain — enforced in processGasRefund
    // and, for the manual address, validated here against that same network.
    const body = (req.body ?? {}) as { mode?: string; toAddress?: string; toNetwork?: string }
    const mode = body.mode === 'manual' ? 'manual' : 'auto'

    let toAddressOverride: string | undefined
    let networkOverride: string | undefined
    if (mode === 'manual') {
      const addr = (body.toAddress ?? '').trim()
      if (!addr) throw new AppError('VALIDATION_ERROR', 'Manual refund requires a destination address.', 400)
      // The refund settles on a chosen USDT rail. Default to the order's own payment
      // network (crypto orders), but allow an explicit override — a PKR-paid order has
      // no crypto payment network, so the admin picks the rail the user asked for.
      const requestedNet = (body.toNetwork ?? '').trim().toUpperCase()
      const net = requestedNet || order.paymentNetwork.toUpperCase()
      let valid = false
      let hint = `No automated USDT refund for network ${net}.`
      if (net === 'TRC20') {
        valid = /^T[A-Za-z1-9]{33}$/.test(addr); hint = 'Expected a TRON (TRC20) address starting with T.'
      } else if (net === 'BEP20' || net === 'ERC20') {
        valid = /^0x[0-9a-fA-F]{40}$/.test(addr); hint = 'Expected a 0x EVM address (40 hex characters).'
      } else if (net === 'APTOS') {
        const { validateAptosAddress } = await import('../lib/gas/aptosWalletService')
        valid = validateAptosAddress(addr); hint = 'Expected a valid Aptos 0x address.'
      } else {
        hint = `Refunds are only supported to BEP20, ERC20, TRC20 or APTOS USDT rails (got ${net || 'none'}).`
      }
      if (!valid) throw new AppError('VALIDATION_ERROR', `Invalid refund address for ${net}. ${hint}`, 400)
      toAddressOverride = addr
      // Only carry an override when it differs from the payment network; keeps the
      // common crypto-order path unchanged (settles on payment network as before).
      if (requestedNet && requestedNet !== order.paymentNetwork.toUpperCase()) networkOverride = requestedNet
    } else if (!order.paymentTxHash) {
      throw new AppError(
        'NO_PAYMENT',
        `Order '${order.orderRef}' has no recorded payment tx, so an automatic refund can't resolve the payer. Use a manual refund address instead.`,
        400,
      )
    }

    // Move to refund_pending and enqueue the same automated refund job the system
    // uses on delivery failure. The gasFee queue retains completed/failed jobs, so a
    // plain re-add with the existing jobId would no-op a re-attempt — remove the
    // retained job first so each admin-triggered refund actually runs. One jobId per
    // order still prevents concurrent double-sends; processGasRefund's CAS backs it up.
    //
    // CAS guard: a 'payment_detected' order can be claimed by the delivery worker
    // (payment_detected → sending) at any moment. Only flip to refund_pending if the
    // status is still one of the refundable ones — never overwrite an in-flight
    // 'sending'/'delivered' state, which would double-spend (deliver AND refund).
    const moved = await db.gasFeeOrder.updateMany({
      where: { id, status: { in: ['failed', 'refund_pending', 'expired', 'payment_detected', 'awaiting_refund'] } },
      data: { status: 'refund_pending', failureReason: null },
    })
    if (moved.count === 0) {
      const fresh = await db.gasFeeOrder.findUnique({ where: { id }, select: { status: true } })
      throw new AppError('CONFLICT', `Order moved to '${fresh?.status ?? 'unknown'}' before the refund could start — it can no longer be refunded from here.`, 409)
    }
    // If this was sitting in the post-failure window, cancel its pending safety-net auto-refund.
    try { await queues.gasFee.remove(`gas-auto-refund-${id}`) } catch { /* non-fatal */ }
    const jobId = `gas-refund-${id}`
    try { await queues.gasFee.remove(jobId) } catch { /* active or absent — add() stays a safe no-op */ }
    await queues.gasFee.add(
      'process-refund',
      { orderId: id, ...(toAddressOverride ? { toAddressOverride } : {}), ...(networkOverride ? { networkOverride } : {}) },
      { jobId, attempts: 5, backoff: { type: 'exponential', delay: 30_000 } },
    )
    const settleNet = networkOverride ?? order.paymentNetwork
    await createAuditLog(req.user!.id, 'GAS_ORDER_REFUND_TRIGGERED', 'GasFeeOrder', id, {
      previousStatus: order.status,
      orderRef: order.orderRef,
      paymentNetwork: order.paymentNetwork,
      amount: order.paymentAmount.toString(),
      mode,
      ...(toAddressOverride ? { toAddress: toAddressOverride } : {}),
      ...(networkOverride ? { networkOverride } : {}),
    }, clientIp(req), req.headers['user-agent'] as string | undefined)

    return reply.send({
      success: true,
      message: mode === 'manual'
        ? `Refund queued — ${order.paymentAmount} USDT will be sent to the specified address on ${settleNet}.`
        : 'Refund queued — USDT will be sent back to the payer automatically.',
    })
  })

  // GET /admin/gas/orders/:ref — order detail
  app.get('/admin/gas/orders/:ref', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { ref } = req.params as { ref: string }
    const order = await db.gasFeeOrder.findUnique({
      where: { orderRef: ref },
      include: { user: { select: { username: true, email: true } } },
    })
    if (!order) throw Errors.NOT_FOUND('Gas fee order')
    // Full payment-attribution + delivery audit trail (Redis-backed journal).
    const { getGasAudit } = await import('../lib/gas/gas.matching')
    const audit = await getGasAudit(order.id)

    // Lazily resolve + persist the original payer's address so the admin can see
    // "Paid from" and pre-fill the automatic refund destination. EVM/TRON matches
    // already persist it at detection time; Aptos (and any older order) is resolved
    // here once, from the payment tx, then cached on the row.
    let paymentSenderAddress = order.paymentSenderAddress
    if (!paymentSenderAddress && order.paymentTxHash) {
      try {
        const net = (order.paymentNetwork || '').toUpperCase()
        if (net === 'APTOS') {
          const { getAptosSenderFromTx } = await import('../lib/gas/aptosRefund')
          paymentSenderAddress = await getAptosSenderFromTx(order.paymentTxHash)
        } else {
          const { paymentNetworkSettlementChain, fromDbChain } = await import('../lib/gas/gas.chains')
          const { getSenderAddressFromTx } = await import('../lib/gas/gas.refund')
          const settle = paymentNetworkSettlementChain(order.paymentNetwork)
          if (settle) paymentSenderAddress = await getSenderAddressFromTx(fromDbChain(settle.dbChain), order.paymentTxHash)
        }
        if (paymentSenderAddress) {
          await db.gasFeeOrder.update({ where: { id: order.id }, data: { paymentSenderAddress } })
        }
      } catch { /* best-effort — the UI retries on next load */ }
    }

    // TON hot-wallet addresses are stored in raw (0:hex64) form, but the gas
    // wallet card and TON explorers show the user-friendly (UQ…) form. Surface the
    // friendly form here too so admins don't mistake the raw value for a different
    // wallet — both encode the SAME address (see tonRawToFriendly).
    let fromHotWallet = order.fromHotWallet
    if (order.chain === 'TON' && fromHotWallet) {
      const { tonRawToFriendly } = await import('../lib/gas/tonWalletService')
      fromHotWallet = tonRawToFriendly(fromHotWallet)
    }

    return reply.send({ success: true, data: { ...order, fromHotWallet, paymentSenderAddress, audit } })
  })

  // ── Financial aggregation helper ─────────────────────────────────────────────
  async function gasFinancialAgg(from?: Date, to?: Date) {
    const { redis: redisForFinancials } = await import('../lib/redis')
    const dateFilter = from || to
      ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
      : {}
    const deliveredFilter = { ...dateFilter, status: 'delivered' as const }
    const refundedFilter  = { ...dateFilter, status: { in: ['refunded', 'refund_pending'] as ('refunded' | 'refund_pending')[] } }

    const [totalOrders, paymentAgg, gasAgg, refundAgg, usdtPkrRaw] = await Promise.all([
      db.gasFeeOrder.count({ where: dateFilter }),
      db.gasFeeOrder.aggregate({ where: deliveredFilter, _sum: { paymentAmount: true } }),
      db.gasFeeOrder.aggregate({ where: deliveredFilter, _sum: { gasAmountUSD: true } }),
      db.gasFeeOrder.aggregate({ where: refundedFilter, _sum: { refundAmount: true } }),
      redisForFinancials.get('rate:USDT'),
    ])

    const usdPkr = usdtPkrRaw
      ? (() => { try { return (JSON.parse(usdtPkrRaw) as { rate?: number }).rate ?? 278.5 } catch { return 278.5 } })()
      : 278.5

    const paymentReceivedUsdt = Number(paymentAgg._sum.paymentAmount ?? 0)
    const gasSpentUsdt        = Number(gasAgg._sum.gasAmountUSD ?? 0)
    const refundCostUsdt      = Number(refundAgg._sum?.refundAmount ?? 0)
    const netProfitUsdt       = paymentReceivedUsdt - gasSpentUsdt - refundCostUsdt
    const marginPct           = paymentReceivedUsdt > 0 ? (netProfitUsdt / paymentReceivedUsdt) * 100 : 0

    return {
      totalOrders,
      paymentReceivedUsdt,
      paymentReceivedPkr:  paymentReceivedUsdt * usdPkr,
      gasSpentUsdt,
      gasSpentPkr:         gasSpentUsdt * usdPkr,
      refundCostUsdt,
      refundCostPkr:       refundCostUsdt * usdPkr,
      netProfitUsdt,
      netProfitPkr:        netProfitUsdt * usdPkr,
      marginPct,
      usdPkrRate:          usdPkr,
    }
  }

  // GET /admin/gas/financials?from=ISO&to=ISO — date-range financial KPIs
  app.get('/admin/gas/financials', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const q = req.query as { from?: string; to?: string }
    const from = q.from ? new Date(q.from) : undefined
    const to   = q.to   ? new Date(q.to)   : undefined
    if (from && isNaN(from.getTime())) return reply.status(400).send({ success: false, error: 'Invalid from date' })
    if (to   && isNaN(to.getTime()))   return reply.status(400).send({ success: false, error: 'Invalid to date' })
    const data = await gasFinancialAgg(from, to)
    return reply.send({ success: true, data })
  })

  // GET /admin/gas/stats — today's metrics + all hot wallet statuses
  app.get('/admin/gas/stats', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const { redis: redisClient } = await import('../lib/redis')
    const { GAS_CHAINS, fromDbChain } = await import('../lib/gas/gas.chains')
    const { tonRawToFriendly } = await import('../lib/gas/tonWalletService')

    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const [todayOrders, todayRevenue, pendingCount, failedCount, refundPendingCount, pendingCustomRequests, allWallets,
           todayFinancials, allTimeFinancials] = await Promise.all([
      db.gasFeeOrder.count({ where: { createdAt: { gte: today } } }),
      db.gasFeeOrder.aggregate({
        where: { status: 'delivered', deliveredAt: { gte: today } },
        _sum: { paymentAmount: true },
      }),
      db.gasFeeOrder.count({ where: { status: { in: ['payment_pending', 'payment_uploaded', 'payment_verified', 'payment_detected', 'sending'] } } }),
      db.gasFeeOrder.count({ where: { status: 'failed' } }),
      db.gasFeeOrder.count({ where: { status: 'refund_pending' } }),
      db.gasCustomRequest.count({ where: { status: 'pending' } }),
      db.gasHotWallet.findMany(),
      gasFinancialAgg(today),
      gasFinancialAgg(),
    ])

    const statsThresholds = await db.gasChainConfig.findMany({
      where: { backendChainId: { not: null } },
      select: { backendChainId: true, alertThresholdUsd: true, pauseThresholdUsd: true },
    })
    const statsThresholdMap = Object.fromEntries(statsThresholds.map((c) => [c.backendChainId!, c]))
    const wallets = await Promise.all(
      allWallets.map(async (w) => {
        const chainConfig = GAS_CHAINS[fromDbChain(w.chain)]
        const [balanceCached, isPaused, balanceUsdCached, rpcError] = await Promise.all([
          redisClient.get(`gas_wallet_balance:${w.chain}`),
          redisClient.get(`gas_wallet_paused:${w.chain}`),
          redisClient.get(`gas_wallet_balance_usd:${w.chain}`),
          redisClient.get(`gas_wallet_error:${w.chain}`),
        ])
        const balance = balanceCached ? parseFloat(balanceCached) : null
        const cfg = statsThresholdMap[w.chain as string]
        const alertThresholdUsd = cfg?.alertThresholdUsd ?? null
        const pauseThresholdUsd = cfg?.pauseThresholdUsd ?? null
        // Guard: only multiply by price if price > 0; a 0 price means "unavailable",
        // not "worth zero" — multiplying gives balanceUsd=0 which triggers false pauses.
        const balanceUsd = balanceUsdCached
          ? parseFloat(balanceUsdCached)
          : balance !== null && chainConfig
          ? await getNativeUsdPrice(fromDbChain(w.chain)).then((p) => p > 0 ? balance * p : null).catch(() => null)
          : null

        let status: 'healthy' | 'low' | 'paused' | 'unavailable' | 'rpc_error' | 'price_unavailable' = 'healthy'
        let pauseReason: 'manual' | 'low_balance' | null = null

        if (!w.isActive) {
          // Admin explicitly disabled this chain via the toggle button
          status = 'paused'
          pauseReason = 'manual'
        } else if (balance === null) {
          // Balance fetch has never succeeded or RPC is down
          status = rpcError ? 'rpc_error' : 'unavailable'
        } else if (balanceUsd === null) {
          // Balance is known but USD price is unavailable — cannot evaluate USD thresholds.
          // Fall back to the stale auto-pause key only as a last resort so we don't show
          // "healthy" for a chain that was genuinely paused before the price feed went down.
          status = isPaused ? 'paused' : 'price_unavailable'
          if (isPaused) pauseReason = 'low_balance'
        } else if (pauseThresholdUsd !== null && balanceUsd <= pauseThresholdUsd) {
          // Live USD balance below pause threshold — definitive auto-pause
          status = 'paused'
          pauseReason = 'low_balance'
        } else if (alertThresholdUsd !== null && balanceUsd <= alertThresholdUsd) {
          status = 'low'
        }
        // else: healthy (default)
        // NOTE: when balanceUsd IS computable and above thresholds we intentionally
        // ignore any stale gas_wallet_paused key — the live threshold check wins.

        return {
          chain:                w.chain,
          address:              w.address,
          // TON addresses are stored raw (0:hex64); expose the user-friendly UQ… form for display.
          friendlyAddress:      w.chain === 'TON' ? tonRawToFriendly(w.address) : null,
          isActive:             w.isActive,
          balance,
          balanceUsd,
          nativeSymbol:         chainConfig?.nativeSymbol ?? w.chain,
          status,
          pauseReason,
          alertThresholdUsd,
          pauseThresholdUsd,
          lastBalanceRefreshAt: w.lastBalanceRefreshAt ?? null,
        }
      }),
    )

    // Backward-compat: surface TRON wallet as primary `wallet` field
    const tronWallet = wallets.find((w) => w.chain === 'TRON') ?? null

    // Aptos APT gas health — inbound-only rail with no GasHotWallet row, but its
    // wallet needs native APT to pay gas for USDT refunds. Surface a low warning.
    const { getAptosHotWalletAddress } = await import('../lib/gas/aptosWalletService')
    const aptosAddress = getAptosHotWalletAddress()
    let aptosGas: { address: string; balance: number | null; minApt: number; lowApt: boolean } | null = null
    if (aptosAddress) {
      const aptCached = await redisClient.get('gas_aptos_apt_balance')
      const apt = aptCached !== null ? parseFloat(aptCached) : null
      aptosGas = {
        address: aptosAddress,
        balance: apt,
        minApt:  env.GAS_APTOS_MIN_APT,
        lowApt:  apt !== null && apt < env.GAS_APTOS_MIN_APT,
      }
    }

    return reply.send({
      success: true,
      data: {
        todayOrders,
        todayRevenue: todayRevenue._sum.paymentAmount ?? 0,
        pendingCount,
        failedCount,
        refundPendingCount,
        pendingCustomRequests,
        wallet: tronWallet,
        wallets,
        aptosGas,
        today:   todayFinancials,
        allTime: allTimeFinancials,
      },
    })
  })

  // GET /admin/gas/wallets — list hot wallets with cached balances
  app.get('/admin/gas/wallets', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const { redis: redisClient } = await import('../lib/redis')

    const wallets = await db.gasHotWallet.findMany()
    const walletsWithBalance = await Promise.all(
      wallets.map(async (w) => {
        const balanceCached = await redisClient.get(`gas_wallet_balance:${w.chain}`)
        const isPaused = await redisClient.get(`gas_wallet_paused:${w.chain}`)
        return {
          ...w,
          balanceTRX: balanceCached ? parseFloat(balanceCached) : null,
          isAutoPaused: !!isPaused,
        }
      }),
    )
    return reply.send({ success: true, data: { wallets: walletsWithBalance } })
  })

  // GET /admin/gas/hot-wallet/:chain/tokens — native + non-native token balances
  // held by a chain's gas hot wallet. Reads live on-chain ERC-20/TRC-20/Aptos-FA
  // balances so admins can see (and external token deposits become visible) how
  // much USDT/USDC each hot wallet holds. Aptos has no GasHotWallet row — its
  // address is derived and APT native balance comes from the monitor cache.
  app.get('/admin/gas/hot-wallet/:chain/tokens', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { chain } = req.params as { chain: string }
    const dbChain = chain.toUpperCase() === 'ETHEREUM' ? 'ETH' : chain.toUpperCase()
    const isAptos = dbChain === 'APT' || dbChain === 'APTOS'

    const { redis: redisClient } = await import('../lib/redis')
    const { getHotWalletTokenBalance } = await import('../lib/gas/gas.tokenBalance')
    const { GAS_CHAINS, fromDbChain } = await import('../lib/gas/gas.chains')

    // ── Resolve hot wallet address + native balance ──────────────────────────
    let address: string | null = null
    let nativeSymbol = dbChain
    let nativeBalance: number | null = null
    if (isAptos) {
      const { getAptosHotWalletAddress } = await import('../lib/gas/aptosWalletService')
      address = getAptosHotWalletAddress()
      nativeSymbol = 'APT'
      const cached = await redisClient.get('gas_aptos_apt_balance')
      nativeBalance = cached !== null ? parseFloat(cached) : null
    } else {
      const w = await db.gasHotWallet.findFirst({ where: { chain: dbChain as 'TRON' | 'BSC' | 'ETH' | 'SOL' | 'MATIC' | 'ARB' | 'BASE' | 'OP' | 'AVAX' | 'TON' | 'SUI' } })
      address = w?.address ?? null
      try { nativeSymbol = GAS_CHAINS[fromDbChain(dbChain)]?.nativeSymbol ?? dbChain } catch { nativeSymbol = dbChain }
      const cached = await redisClient.get(`gas_wallet_balance:${dbChain}`)
      nativeBalance = cached !== null ? parseFloat(cached) : null
    }
    if (!address) throw Errors.NOT_FOUND('Gas hot wallet')

    // ── Native USD value ─────────────────────────────────────────────────────
    let nativeUsd: number | null = null
    if (nativeBalance !== null) {
      try {
        if (isAptos) {
          const raw = await redisClient.get('rate:APT')
          const p = raw ? ((JSON.parse(raw) as { usdPrice?: number }).usdPrice ?? 0) : 0
          nativeUsd = p > 0 ? nativeBalance * p : null
        } else {
          const { getNativeUsdPrice } = await import('../lib/gas/gas.balance')
          const p = await getNativeUsdPrice(fromDbChain(dbChain))
          nativeUsd = p > 0 ? nativeBalance * p : null
        }
      } catch { nativeUsd = null }
    }

    // ── Configured non-native tokens for this chain (from gas chain registry) ─
    // Match every non-native token, not just the legacy tokenType 'token'. Tokens
    // created via the admin UI carry named standards (erc20, bep20, trc20, fa, …),
    // so filtering on === 'token' silently hid all UI-created tokens (e.g. Base
    // USDC/USDT, Aptos FA) even when active. Backend only ever branches on 'native'.
    // Resolve the chain tolerantly. backendChainId can store the internal
    // 'ETHEREUM' alias (or be left null) while the hot wallet + balance paths use
    // the 'ETH' DB enum, so a strict { backendChainId: 'ETH' } match silently
    // returned zero tokens here — the wallet view showed "0 configured" even though
    // the tokens exist and are active. Match either backendChainId alias or the slug.
    let backendIdAliases = [dbChain]
    try { backendIdAliases = Array.from(new Set([dbChain, fromDbChain(dbChain)])) } catch { /* keep dbChain */ }
    // More than one chain config can resolve to the same hot wallet. In prod a
    // separate "Billions Network" chain was created with backendChainId 'ETH',
    // colliding with the real Ethereum chain. A single findFirst() (no orderBy)
    // then non-deterministically picked the tokenless Billions row, so the view
    // showed "0 configured" even though USDT/USDC live on the canonical ETH chain.
    // Match EVERY config routing to this wallet and aggregate their non-native
    // tokens (deduped by symbol+address) so a tokenless duplicate can never blank
    // the view again — the ETH hot wallet legitimately holds tokens from any config
    // that delivers through it.
    const chainCfgs = await db.gasChainConfig.findMany({
      where: { OR: [
        { backendChainId: { in: backendIdAliases } },
        { slug: { in: [dbChain, chain.toUpperCase()] } },
      ] },
      include: { tokens: { where: { tokenType: { not: 'native' }, isActive: true, contractAddress: { not: null } }, orderBy: { displayOrder: 'asc' } } },
    })
    const seenTokenKeys = new Set<string>()
    const tokenList = chainCfgs.flatMap((c) => c.tokens).filter((t) => {
      const key = `${t.symbol.toUpperCase()}:${(t.contractAddress ?? '').toLowerCase()}`
      if (seenTokenKeys.has(key)) return false
      seenTokenKeys.add(key)
      return true
    })

    const tokens = await Promise.all(tokenList.map(async (t) => {
      let balance: number | null = null
      let decimals: number | null = null
      let error: string | null = null
      try {
        const r = await getHotWalletTokenBalance(dbChain, t.contractAddress!, address!)
        balance = r.balance; decimals = r.decimals
      } catch (e) {
        error = e instanceof Error ? e.message.slice(0, 160) : 'balance read failed'
      }
      // Stablecoins are ~$1; we don't price arbitrary tokens here.
      const sym = t.symbol.toUpperCase()
      const isStable = ['USDT', 'USDC', 'DAI', 'BUSD', 'USD'].some((s) => sym.includes(s))
      const usd = balance !== null && isStable ? balance : null
      return {
        symbol:          t.symbol,
        name:            t.name,
        contractAddress: t.contractAddress,
        logoUrl:         t.logoUrl,
        balance,
        decimals,
        usd,
        error,
      }
    }))

    // TON addresses are stored raw (0:hex64) but wallets/exchanges expect the
    // user-friendly non-bounceable UQ… form. Expose it so the detail view copies
    // the address people can actually send to (matches every other gas view).
    let friendlyAddress: string | null = null
    if (dbChain === 'TON') {
      const { tonRawToFriendly } = await import('../lib/gas/tonWalletService')
      friendlyAddress = tonRawToFriendly(address)
    }

    return reply.send({
      success: true,
      data: { chain: dbChain, address, friendlyAddress, nativeSymbol, nativeBalance, nativeUsd, tokens },
    })
  })

  // GET /admin/gas/token-diagnostics — health-check every configured non-native gas
  // token: will it show in the wallet view, is the stored address canonical, does a
  // real token live there on-chain, and (if not) is the cause a wrong address, a
  // rate-limited/unhealthy RPC, or an unsupported chain. Read-only.
  app.get('/admin/gas/token-diagnostics', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const { diagnoseGasTokens } = await import('../lib/gas/gas.tokenDiagnostics')
    const report = await diagnoseGasTokens()
    const counts = report.reduce<Record<string, number>>((m, d) => { m[d.verdict] = (m[d.verdict] ?? 0) + 1; return m }, {})
    return reply.send({ success: true, data: { report, counts } })
  })

  // POST /admin/gas/token-diagnostics/fix-addresses — rewrite every non-canonical
  // contract address to the canonical one (contractAddress only; never flips
  // isActive/deliveryLive). Super-admin + audit-logged.
  app.post('/admin/gas/token-diagnostics/fix-addresses', { preHandler: [authenticate, superAdminOnly] }, async (req, reply) => {
    const { fixGasTokenAddresses } = await import('../lib/gas/gas.tokenDiagnostics')
    const changes = await fixGasTokenAddresses()
    if (changes.length > 0) {
      await createAuditLog(req.user!.id, 'GAS_TOKEN_ADDRESS_FIX', 'GasTokenConfig', 'bulk', { changes }, clientIp(req), req.headers['user-agent'] as string | undefined)
    }
    return reply.send({ success: true, data: { changes } })
  })

  // ── Gas promo codes (margin-only marketing discounts) ──────────────────────
  // Discounts only ever draw from the platform margin, never the base gas cost
  // (enforced in lib/gas/gas.promo.ts). These routes manage the codes; the engine
  // only takes effect when flag gas_promo_enabled is ON.

  const promoTierSchema = z.object({
    maxRedemptions: z.number().int().positive(),
    discountPct:    z.number().min(0).max(100),
  })
  const promoCreateSchema = z.object({
    code:               z.string().trim().min(2).max(40),
    ownerLabel:         z.string().trim().min(1).max(120),
    tiers:              z.array(promoTierSchema).max(20).default([]),
    defaultDiscountPct: z.number().min(0).max(100).default(0),
    marginBudgetUsdt:   z.number().positive(),
    perUserLimit:       z.number().int().min(1).max(1000).default(1),
    minOrderUsd:        z.number().min(0).default(0),
    expiresAt:          z.string().datetime().optional(),
  })
  const promoUpdateSchema = z.object({
    ownerLabel:         z.string().trim().min(1).max(120).optional(),
    tiers:              z.array(promoTierSchema).max(20).optional(),
    defaultDiscountPct: z.number().min(0).max(100).optional(),
    marginBudgetUsdt:   z.number().positive().optional(),
    perUserLimit:       z.number().int().min(1).max(1000).optional(),
    minOrderUsd:        z.number().min(0).optional(),
    expiresAt:          z.string().datetime().nullable().optional(),
    isActive:           z.boolean().optional(),
  })

  // GET /admin/gas/promo-codes — list with live redemption counts + margin spent
  app.get('/admin/gas/promo-codes', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const codes = await db.gasPromoCode.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { redemptions: true } } },
    })
    const data = codes.map((c) => ({
      id: c.id,
      code: c.code,
      ownerLabel: c.ownerLabel,
      tiers: c.tiers,
      defaultDiscountPct: c.defaultDiscountPct,
      marginBudgetUsdt: c.marginBudgetUsdt,
      marginSpentUsdt: c.marginSpentUsdt,
      budgetRemainingUsdt: Math.max(0, c.marginBudgetUsdt - c.marginSpentUsdt),
      totalRedemptions: c.totalRedemptions,
      redemptionRows: c._count.redemptions,
      perUserLimit: c.perUserLimit,
      minOrderUsd: c.minOrderUsd,
      expiresAt: c.expiresAt,
      isActive: c.isActive,
      createdAt: c.createdAt,
    }))
    return reply.send({ success: true, data })
  })

  // GET /admin/gas/promo-codes/:id/redemptions — per-code redemption history
  app.get('/admin/gas/promo-codes/:id/redemptions', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const rows = await db.gasPromoRedemption.findMany({
      where: { promoCodeId: id },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { order: { select: { orderRef: true, paymentAmount: true, status: true } } },
    })
    return reply.send({ success: true, data: rows })
  })

  // POST /admin/gas/promo-codes — create a code (super-admin: it gives away margin)
  app.post('/admin/gas/promo-codes', { preHandler: [authenticate, superAdminOnly] }, async (req, reply) => {
    const parsed = promoCreateSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    const p = parsed.data
    const code = p.code.toUpperCase()

    const existing = await db.gasPromoCode.findUnique({ where: { code } })
    if (existing) throw new AppError('CONFLICT', `Promo code '${code}' already exists`, 409)

    const created = await db.gasPromoCode.create({
      data: {
        code,
        ownerLabel: p.ownerLabel,
        tiers: p.tiers,
        defaultDiscountPct: p.defaultDiscountPct,
        marginBudgetUsdt: p.marginBudgetUsdt,
        perUserLimit: p.perUserLimit,
        minOrderUsd: p.minOrderUsd,
        ...(p.expiresAt ? { expiresAt: new Date(p.expiresAt) } : {}),
      },
    })
    await createAuditLog(req.user!.id, 'GAS_PROMO_CREATE', 'GasPromoCode', created.id, { code, marginBudgetUsdt: p.marginBudgetUsdt }, clientIp(req), req.headers['user-agent'] as string | undefined)
    return reply.code(201).send({ success: true, data: created })
  })

  // PATCH /admin/gas/promo-codes/:id — edit terms / kill switch (super-admin).
  // The code string itself is immutable once created (it may already be in the wild).
  app.patch('/admin/gas/promo-codes/:id', { preHandler: [authenticate, superAdminOnly] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = promoUpdateSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    const p = parsed.data

    const existing = await db.gasPromoCode.findUnique({ where: { id } })
    if (!existing) throw Errors.NOT_FOUND('Promo code')

    const updated = await db.gasPromoCode.update({
      where: { id },
      data: {
        ...(p.ownerLabel !== undefined ? { ownerLabel: p.ownerLabel } : {}),
        ...(p.tiers !== undefined ? { tiers: p.tiers } : {}),
        ...(p.defaultDiscountPct !== undefined ? { defaultDiscountPct: p.defaultDiscountPct } : {}),
        ...(p.marginBudgetUsdt !== undefined ? { marginBudgetUsdt: p.marginBudgetUsdt } : {}),
        ...(p.perUserLimit !== undefined ? { perUserLimit: p.perUserLimit } : {}),
        ...(p.minOrderUsd !== undefined ? { minOrderUsd: p.minOrderUsd } : {}),
        ...(p.expiresAt !== undefined ? { expiresAt: p.expiresAt ? new Date(p.expiresAt) : null } : {}),
        ...(p.isActive !== undefined ? { isActive: p.isActive } : {}),
      },
    })
    await createAuditLog(req.user!.id, 'GAS_PROMO_UPDATE', 'GasPromoCode', id, { changes: p }, clientIp(req), req.headers['user-agent'] as string | undefined)
    return reply.send({ success: true, data: updated })
  })

  // ── Gas referrals (KOL income overview + controls) ─────────────────────────

  // GET /admin/gas/referrals — referrers ranked by total accrued, with status totals
  app.get('/admin/gas/referrals', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const codes = await db.gasReferralCode.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        owner: { select: { id: true, username: true, email: true, kycLevel: true } },
        _count: { select: { referrals: true } },
      },
    })
    // Aggregate accruals per referrer (owner) in one grouped pass.
    const grouped = await db.gasReferralAccrual.groupBy({
      by: ['referrerId', 'status'],
      _sum: { amountUsdt: true },
    })
    const totals = new Map<string, { available: number; withdrawn: number; total: number }>()
    for (const g of grouped) {
      const cur = totals.get(g.referrerId) ?? { available: 0, withdrawn: 0, total: 0 }
      const amt = Number(g._sum.amountUsdt ?? 0)
      cur.total += amt
      if (g.status === 'available') cur.available += amt
      else if (g.status === 'withdrawn') cur.withdrawn += amt
      totals.set(g.referrerId, cur)
    }
    const data = codes.map((c) => {
      const t = totals.get(c.ownerId) ?? { available: 0, withdrawn: 0, total: 0 }
      return {
        codeId: c.id,
        code: c.code,
        referralPct: c.referralPct,
        isActive: c.isActive,
        owner: c.owner,
        referredCount: c._count.referrals,
        totalAccruedUsdt: Math.round(t.total * 100) / 100,
        availableUsdt: Math.round(t.available * 100) / 100,
        withdrawnUsdt: Math.round(t.withdrawn * 100) / 100,
        createdAt: c.createdAt,
      }
    })
    return reply.send({ success: true, data })
  })

  // PATCH /admin/gas/referrals/:codeId — tune the rate or disable a referrer's code
  const referralUpdateSchema = z.object({
    referralPct: z.number().min(0).max(100).optional(),
    isActive:    z.boolean().optional(),
  })
  app.patch('/admin/gas/referrals/:codeId', { preHandler: [authenticate, superAdminOnly] }, async (req, reply) => {
    const { codeId } = req.params as { codeId: string }
    const parsed = referralUpdateSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    const existing = await db.gasReferralCode.findUnique({ where: { id: codeId } })
    if (!existing) throw Errors.NOT_FOUND('Referral code')
    const updated = await db.gasReferralCode.update({
      where: { id: codeId },
      data: {
        ...(parsed.data.referralPct !== undefined ? { referralPct: parsed.data.referralPct } : {}),
        ...(parsed.data.isActive !== undefined ? { isActive: parsed.data.isActive } : {}),
      },
    })
    await createAuditLog(req.user!.id, 'GAS_REFERRAL_UPDATE', 'GasReferralCode', codeId, { changes: parsed.data }, clientIp(req), req.headers['user-agent'] as string | undefined)
    return reply.send({ success: true, data: updated })
  })

  // ── Gas affiliates (self-service applications + approval) ──────────────────

  // GET /admin/gas/affiliates — all affiliate profiles (applications + approved)
  app.get('/admin/gas/affiliates', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const data = await adminListAffiliates()
    return reply.send({ success: true, data })
  })

  // POST /admin/gas/affiliates/:userId/review — approve (with caps) or reject (super_admin)
  const affiliateReviewSchema = z.object({
    decision:           z.enum(['approve', 'reject']),
    maxMarginPct:       z.number().min(0).max(100).optional(),
    minUserDiscountPct: z.number().min(0).max(100).optional(),
    maxLinks:           z.number().int().min(1).max(50).optional(),
    rejectionReason:    z.string().trim().max(500).nullable().optional(),
  })
  app.post('/admin/gas/affiliates/:userId/review', { preHandler: [authenticate, superAdminOnly] }, async (req, reply) => {
    const { userId } = req.params as { userId: string }
    const parsed = affiliateReviewSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    const result = await adminReviewAffiliate(req.user!.id, userId, parsed.data)
    await createAuditLog(req.user!.id, 'GAS_AFFILIATE_REVIEW', 'GasAffiliate', userId, { changes: parsed.data }, clientIp(req), req.headers['user-agent'] as string | undefined)
    return reply.send({ success: true, data: result })
  })

  // POST /admin/gas/wallets/:chain/balance — manually override cached balance (super_admin)
  app.post('/admin/gas/wallets/:chain/balance', { preHandler: [authenticate, superAdminOnly] }, async (req, reply) => {
    const { chain } = req.params as { chain: string }
    const { balanceTRX } = req.body as { balanceTRX: number }
    if (typeof balanceTRX !== 'number' || balanceTRX < 0) {
      throw new AppError('VALIDATION_ERROR', 'balanceTRX must be a non-negative number', 400)
    }

    const { redis: redisClient } = await import('../lib/redis')
    await redisClient.set(`gas_wallet_balance:${chain}`, String(balanceTRX), 'EX', 1800)
    await createAuditLog(req.user!.id, 'GAS_WALLET_BALANCE_OVERRIDE', 'GasHotWallet', chain, { balanceTRX }, clientIp(req), req.headers['user-agent'] as string | undefined)

    return reply.send({ success: true })
  })

  // POST /admin/gas/wallets/:chain/refresh-balance — fetch live balance and update Redis cache (admin)
  app.post('/admin/gas/wallets/:chain/refresh-balance', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { chain } = req.params as { chain: string }
    const { redis: redisClient } = await import('../lib/redis')
    const { GAS_CHAINS, fromDbChain } = await import('../lib/gas/gas.chains')
    const { getHotWalletBalance } = await import('../lib/gas/gas.balance')

    const wallet = await db.gasHotWallet.findFirst({ where: { chain: chain as 'TRON' | 'BSC' | 'ETH' | 'SOL' | 'MATIC' | 'ARB' | 'BASE' | 'TON', hdIndex: 0 } })
    if (!wallet) throw Errors.NOT_FOUND('Gas hot wallet')

    const chainId = fromDbChain(chain)
    const chainConfig = GAS_CHAINS[chainId]
    if (!chainConfig) throw new AppError('CHAIN_NOT_SUPPORTED', `Balance fetch not supported for ${chain}`, 400)

    let balance: number
    try {
      balance = await getHotWalletBalance(chainId, wallet.address)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await redisClient.set(`gas_wallet_error:${chain}`, msg.slice(0, 200), 'EX', 7200)
      throw new AppError('BALANCE_FETCH_FAILED', `Failed to fetch ${chain} balance: ${msg}`, 502)
    }

    // Successful fetch — clear any stale error
    await redisClient.del(`gas_wallet_error:${chain}`)
    await redisClient.set(`gas_wallet_balance:${chain}`, String(balance), 'EX', 1800)
    await Promise.all([
      createAuditLog(req.user!.id, 'GAS_WALLET_BALANCE_REFRESHED', 'GasHotWallet', wallet.id, { chain, balance }),
      db.gasHotWallet.update({ where: { id: wallet.id }, data: { lastBalanceRefreshAt: new Date() } }),
    ])

    const [isPaused, rpcError] = await Promise.all([
      redisClient.get(`gas_wallet_paused:${chain}`),
      redisClient.get(`gas_wallet_error:${chain}`),
    ])
    const dbThreshold = await db.gasChainConfig.findFirst({
      where: { backendChainId: chain },
      select: { alertThresholdUsd: true, pauseThresholdUsd: true },
    })
    const alertThresholdUsd = dbThreshold?.alertThresholdUsd ?? null
    const pauseThresholdUsd = dbThreshold?.pauseThresholdUsd ?? null
    const usdPrice = await getNativeUsdPrice(chainId).catch(() => 0)
    const balanceUsd = usdPrice > 0 ? balance * usdPrice : null
    if (balanceUsd !== null) {
      await redisClient.set(`gas_wallet_balance_usd:${chain}`, String(balanceUsd.toFixed(4)), 'EX', 1800)
    }

    // Re-evaluate and update the auto-pause key based on the fresh balance so
    // that the manual Refresh Balance button immediately reflects reality.
    if (balanceUsd !== null) {
      if (pauseThresholdUsd !== null && balanceUsd <= pauseThresholdUsd) {
        await redisClient.set(`gas_wallet_paused:${chain}`, '1', 'EX', 360)
      } else {
        await redisClient.del(`gas_wallet_paused:${chain}`)
      }
    }

    let status: 'healthy' | 'low' | 'paused' | 'unavailable' | 'rpc_error' | 'price_unavailable' = 'healthy'
    let pauseReason: 'manual' | 'low_balance' | null = null

    if (!wallet.isActive) {
      status = 'paused'
      pauseReason = 'manual'
    } else if (balanceUsd === null && isPaused) {
      // Price unavailable — respect stale auto-pause rather than showing healthy
      status = 'paused'
      pauseReason = 'low_balance'
    } else if (balanceUsd === null && rpcError) {
      status = 'rpc_error'
    } else if (balanceUsd === null) {
      status = 'price_unavailable'
    } else if (pauseThresholdUsd !== null && balanceUsd <= pauseThresholdUsd) {
      status = 'paused'
      pauseReason = 'low_balance'
    } else if (alertThresholdUsd !== null && balanceUsd <= alertThresholdUsd) {
      status = 'low'
    }

    return reply.send({
      success: true,
      data: { chain, balance, balanceUsd, nativeSymbol: chainConfig.nativeSymbol, status, pauseReason, alertThresholdUsd, pauseThresholdUsd },
    })
  })

  // POST /admin/gas/chains/:chain/toggle — pause/resume a chain (super_admin)
  app.post('/admin/gas/chains/:chain/toggle', { preHandler: [authenticate, superAdminOnly] }, async (req, reply) => {
    const { chain } = req.params as { chain: string }

    // Validate chain exists in DB — toggle ALL wallets for the chain
    const wallet = await db.gasHotWallet.findFirst({ where: { chain: chain as 'TRON' | 'BSC' | 'ETH' | 'SOL' | 'MATIC' | 'ARB' | 'BASE' | 'TON', hdIndex: 0 } })
    if (!wallet) throw Errors.NOT_FOUND('Gas hot wallet')

    // Toggle all wallets for this chain together
    const newIsActive = !wallet.isActive
    await db.gasHotWallet.updateMany({
      where: { chain: chain as 'TRON' | 'BSC' | 'ETH' | 'SOL' | 'MATIC' | 'ARB' | 'BASE' | 'TON' },
      data: { isActive: newIsActive },
    })
    await createAuditLog(req.user!.id, 'GAS_CHAIN_TOGGLED', 'GasHotWallet', wallet.id, {
      chain,
      isActive: newIsActive,
    }, clientIp(req), req.headers['user-agent'] as string | undefined)

    return reply.send({ success: true, data: { chain, isActive: newIsActive } })
  })

  // GET /admin/gas/unattributed — payments received with no matching order
  app.get('/admin/gas/unattributed', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const { redis: redisClient } = await import('../lib/redis')

    // Sorted set: members are JSON strings, scores are epoch timestamps
    const raw = await redisClient.zrevrange('gas_unattributed', 0, 49)
    const payments = raw.flatMap((entry) => {
      try { return [JSON.parse(entry) as Record<string, unknown>] } catch { return [] }
    })
    return reply.send({ success: true, data: { payments, total: payments.length } })
  })

  // POST /admin/gas/unattributed/:txHash/attribute — link an unattributed payment to an order
  app.post('/admin/gas/unattributed/:txHash/attribute', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { txHash } = req.params as { txHash: string }
    const { orderId } = req.body as { orderId: string }
    if (!orderId) throw new AppError('VALIDATION_ERROR', 'orderId is required', 400)

    const { redis: redisClient } = await import('../lib/redis')

    // Find and remove the matching entry from the sorted set
    const raw = await redisClient.zrevrange('gas_unattributed', 0, 99)
    for (const entry of raw) {
      try {
        const parsed = JSON.parse(entry) as { txHash?: string }
        if (parsed.txHash === txHash) {
          await redisClient.zrem('gas_unattributed', entry)
          break
        }
      } catch { /* skip malformed entries */ }
    }

    // Update the gas order to payment_detected and enqueue delivery
    const order = await db.gasFeeOrder.findUnique({ where: { id: orderId } })
    if (!order) throw Errors.NOT_FOUND('Gas fee order')

    await db.gasFeeOrder.update({
      where: { id: orderId },
      data: { status: 'payment_detected', paymentTxHash: txHash },
    })
    await queues.gasFee.add('deliver', { orderId }, { priority: 1 })
    await createAuditLog(req.user!.id, 'GAS_UNATTRIBUTED_ATTRIBUTED', 'GasFeeOrder', orderId, { txHash }, clientIp(req), req.headers['user-agent'] as string | undefined)

    return reply.send({ success: true })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // GAS CHAIN CONFIG CRUD
  // ─────────────────────────────────────────────────────────────────────────

  // GET /admin/gas/chain-lookup?q=<name|symbol> — auto-fill suggestion for the Add Chain form.
  // Combines: local static map (confidence=high) → CoinGecko logo → chainid.network EVM data.
  app.get('/admin/gas/chain-lookup', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { q } = req.query as { q?: string }
    if (!q || q.trim().length < 2) throw new AppError('VALIDATION_ERROR', 'q must be at least 2 characters', 400)

    const query = q.trim().toLowerCase()

    // ── Static map — covers the chains we already know about ─────────────────
    type StaticEntry = {
      name: string; slug: string; symbol: string; category: string
      addressType: string; networkLabel: string; explorerBase: string
      evmChainId?: number; coingeckoId?: string
    }
    const STATIC: Record<string, StaticEntry> = {
      ethereum:  { name: 'Ethereum',         slug: 'ETH',      symbol: 'ETH',  category: 'ethereum',  addressType: 'EVM',        networkLabel: 'ERC20',       explorerBase: 'https://etherscan.io',              evmChainId: 1,      coingeckoId: 'ethereum'  },
      eth:       { name: 'Ethereum',         slug: 'ETH',      symbol: 'ETH',  category: 'ethereum',  addressType: 'EVM',        networkLabel: 'ERC20',       explorerBase: 'https://etherscan.io',              evmChainId: 1,      coingeckoId: 'ethereum'  },
      bnb:       { name: 'BNB Smart Chain',  slug: 'BSC',      symbol: 'BNB',  category: 'bnb',       addressType: 'EVM',        networkLabel: 'BEP20',       explorerBase: 'https://bscscan.com',               evmChainId: 56,     coingeckoId: 'binancecoin' },
      bsc:       { name: 'BNB Smart Chain',  slug: 'BSC',      symbol: 'BNB',  category: 'bnb',       addressType: 'EVM',        networkLabel: 'BEP20',       explorerBase: 'https://bscscan.com',               evmChainId: 56,     coingeckoId: 'binancecoin' },
      tron:      { name: 'TRON',             slug: 'TRON',     symbol: 'TRX',  category: 'tron',      addressType: 'TRC20',      networkLabel: 'TRC20',       explorerBase: 'https://tronscan.org/#',            coingeckoId: 'tron' },
      trx:       { name: 'TRON',             slug: 'TRON',     symbol: 'TRX',  category: 'tron',      addressType: 'TRC20',      networkLabel: 'TRC20',       explorerBase: 'https://tronscan.org/#',            coingeckoId: 'tron' },
      solana:    { name: 'Solana',           slug: 'SOL',      symbol: 'SOL',  category: 'solana',    addressType: 'SOL',        networkLabel: 'SPL',         explorerBase: 'https://solscan.io',                coingeckoId: 'solana' },
      sol:       { name: 'Solana',           slug: 'SOL',      symbol: 'SOL',  category: 'solana',    addressType: 'SOL',        networkLabel: 'SPL',         explorerBase: 'https://solscan.io',                coingeckoId: 'solana' },
      ton:       { name: 'TON',              slug: 'TON',      symbol: 'TON',  category: 'ton',       addressType: 'TON',        networkLabel: 'TON',         explorerBase: 'https://tonscan.org',               coingeckoId: 'the-open-network' },
      sui:       { name: 'SUI',              slug: 'SUI',      symbol: 'SUI',  category: 'sui',       addressType: 'SUI',        networkLabel: 'SUI',         explorerBase: 'https://suiscan.xyz',               coingeckoId: 'sui'  },
      avalanche: { name: 'Avalanche',        slug: 'AVAX',     symbol: 'AVAX', category: 'avalanche', addressType: 'EVM',        networkLabel: 'AVAX C-Chain',explorerBase: 'https://snowtrace.io',              evmChainId: 43114,  coingeckoId: 'avalanche-2' },
      avax:      { name: 'Avalanche',        slug: 'AVAX',     symbol: 'AVAX', category: 'avalanche', addressType: 'EVM',        networkLabel: 'AVAX C-Chain',explorerBase: 'https://snowtrace.io',              evmChainId: 43114,  coingeckoId: 'avalanche-2' },
      polygon:   { name: 'Polygon',          slug: 'MATIC',    symbol: 'POL',  category: 'polygon',   addressType: 'EVM',        networkLabel: 'POLYGON',     explorerBase: 'https://polygonscan.com',           evmChainId: 137,    coingeckoId: 'matic-network' },
      matic:     { name: 'Polygon',          slug: 'MATIC',    symbol: 'POL',  category: 'polygon',   addressType: 'EVM',        networkLabel: 'POLYGON',     explorerBase: 'https://polygonscan.com',           evmChainId: 137,    coingeckoId: 'matic-network' },
      arbitrum:  { name: 'Arbitrum One',     slug: 'ARB',      symbol: 'ETH',  category: 'arbitrum',  addressType: 'EVM',        networkLabel: 'ARBITRUM',    explorerBase: 'https://arbiscan.io',               evmChainId: 42161,  coingeckoId: 'ethereum'  },
      arb:       { name: 'Arbitrum One',     slug: 'ARB',      symbol: 'ETH',  category: 'arbitrum',  addressType: 'EVM',        networkLabel: 'ARBITRUM',    explorerBase: 'https://arbiscan.io',               evmChainId: 42161,  coingeckoId: 'ethereum'  },
      optimism:  { name: 'Optimism',         slug: 'OP',       symbol: 'ETH',  category: 'optimism',  addressType: 'EVM',        networkLabel: 'OPTIMISM',    explorerBase: 'https://optimistic.etherscan.io',   evmChainId: 10,     coingeckoId: 'ethereum'  },
      base:      { name: 'Base',             slug: 'BASE',     symbol: 'ETH',  category: 'base',      addressType: 'EVM',        networkLabel: 'BASE',        explorerBase: 'https://basescan.org',              evmChainId: 8453,   coingeckoId: 'ethereum'  },
      bitcoin:   { name: 'Bitcoin',          slug: 'BTC',      symbol: 'BTC',  category: 'bitcoin',   addressType: 'BTC_BECH32', networkLabel: 'BTC',         explorerBase: 'https://mempool.space',             coingeckoId: 'bitcoin' },
      btc:       { name: 'Bitcoin',          slug: 'BTC',      symbol: 'BTC',  category: 'bitcoin',   addressType: 'BTC_BECH32', networkLabel: 'BTC',         explorerBase: 'https://mempool.space',             coingeckoId: 'bitcoin' },
      aptos:     { name: 'Aptos',            slug: 'APT',      symbol: 'APT',  category: 'aptos',     addressType: 'APTOS',      networkLabel: 'APTOS',       explorerBase: 'https://explorer.aptoslabs.com',    coingeckoId: 'aptos' },
      apt:       { name: 'Aptos',            slug: 'APT',      symbol: 'APT',  category: 'aptos',     addressType: 'APTOS',      networkLabel: 'APTOS',       explorerBase: 'https://explorer.aptoslabs.com',    coingeckoId: 'aptos' },
    }

    const warnings: string[] = []
    let confidence: 'high' | 'partial' | 'low' = 'low'
    let logoUrl: string | null = null

    // ── Step 1: static match ──────────────────────────────────────────────────
    const staticMatch = STATIC[query]

    // ── Step 2: CoinGecko logo ───────────────────────────────────────────────
    const cgId = staticMatch?.coingeckoId ?? null
    if (cgId) {
      try {
        const headers: Record<string, string> = env.COINGECKO_API_KEY
          ? { 'x-cg-demo-api-key': env.COINGECKO_API_KEY }
          : {}
        const res = await fetch(
          `https://api.coingecko.com/api/v3/coins/${cgId}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`,
          { headers, signal: AbortSignal.timeout(6000) }
        )
        if (res.ok) {
          const data = await res.json() as { image?: { large?: string; thumb?: string } }
          logoUrl = data.image?.large ?? data.image?.thumb ?? null
        }
      } catch {
        warnings.push('Could not fetch logo from CoinGecko (will be empty)')
      }
    }

    // ── Step 3: return result ─────────────────────────────────────────────────
    if (staticMatch) {
      confidence = 'high'
      return reply.send({
        success: true,
        data: {
          suggestedName:        staticMatch.name,
          suggestedSlug:        staticMatch.slug,
          suggestedSymbol:      staticMatch.symbol,
          suggestedCategory:    staticMatch.category,
          suggestedAddressType: staticMatch.addressType,
          suggestedNetworkLabel:staticMatch.networkLabel,
          suggestedExplorerBase:staticMatch.explorerBase,
          suggestedLogoUrl:     logoUrl ?? '',
          suggestedEvmChainId:  staticMatch.evmChainId ?? null,
          confidence,
          warnings,
        },
      })
    }

    // ── Step 4: no static match — try CoinGecko search + chainid.network ─────
    let cgResult: { name: string; symbol: string; id: string; thumb: string } | null = null
    try {
      const headers: Record<string, string> = env.COINGECKO_API_KEY
        ? { 'x-cg-demo-api-key': env.COINGECKO_API_KEY }
        : {}
      const res = await fetch(
        `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(q.trim())}`,
        { headers, signal: AbortSignal.timeout(6000) }
      )
      if (res.ok) {
        const data = await res.json() as { coins: Array<{ id: string; name: string; symbol: string; thumb: string; market_cap_rank: number | null }> }
        const best = data.coins
          .filter(c => c.name.toLowerCase().includes(query) || c.symbol.toLowerCase() === query)
          .sort((a, b) => {
            if (a.market_cap_rank === null) return 1
            if (b.market_cap_rank === null) return -1
            return a.market_cap_rank - b.market_cap_rank
          })[0] ?? null
        if (best) {
          cgResult = { name: best.name, symbol: best.symbol.toUpperCase(), id: best.id, thumb: best.thumb }
          logoUrl = best.thumb
        }
      }
    } catch {
      warnings.push('CoinGecko search failed')
    }

    if (!cgResult) {
      warnings.push('No match found in CoinGecko. Fill fields manually.')
      return reply.send({
        success: true,
        data: {
          suggestedName: q.trim(), suggestedSlug: q.trim().toUpperCase().replace(/[^A-Z0-9]/g, ''),
          suggestedSymbol: '', suggestedCategory: '', suggestedAddressType: 'EVM',
          suggestedNetworkLabel: '', suggestedExplorerBase: '', suggestedLogoUrl: '',
          suggestedEvmChainId: null, confidence: 'low', warnings,
        },
      })
    }

    // Try to enrich with chainid.network for EVM
    let evmChainId: number | null = null
    let explorerBase = ''
    try {
      type ChainEntry = { chainId: number; name: string; shortName: string; nativeCurrency: { symbol: string }; explorers?: Array<{ url: string; standard?: string }> }
      const res = await fetch('https://chainid.network/chains.json', { signal: AbortSignal.timeout(8000) })
      if (res.ok) {
        const all = await res.json() as ChainEntry[]
        const match = all.find(c =>
          c.nativeCurrency.symbol.toUpperCase() === cgResult!.symbol ||
          c.name.toLowerCase().includes(query)
        )
        if (match) {
          evmChainId = match.chainId
          const exp = match.explorers?.find(e => e.standard === 'EIP3091')?.url ?? match.explorers?.[0]?.url ?? null
          explorerBase = exp ? exp.replace(/\/$/, '') : ''
          confidence = 'partial'
        } else {
          warnings.push('Not found on chainid.network — may be non-EVM. Set Address Type manually.')
        }
      }
    } catch {
      warnings.push('chainid.network lookup failed')
    }

    // confidence was set to 'partial' inside the chainid.network block only if a match was found
    // if no match found, it stays 'low' — which is correct

    return reply.send({
      success: true,
      data: {
        suggestedName:         cgResult.name,
        suggestedSlug:         cgResult.symbol.replace(/[^A-Z0-9]/g, ''),
        suggestedSymbol:       cgResult.symbol,
        suggestedCategory:     evmChainId ? 'ethereum' : '',
        suggestedAddressType:  evmChainId ? 'EVM' : '',
        suggestedNetworkLabel: evmChainId ? cgResult.symbol : '',
        suggestedExplorerBase: explorerBase,
        suggestedLogoUrl:      logoUrl ?? '',
        suggestedEvmChainId:   evmChainId,
        confidence,
        warnings,
      },
    })
  })

  // GET /admin/gas/token-address-lookup?address=<addr>&chainSlug=<slug>
  // Address-first token lookup: given a contract address, returns name/symbol/decimals/logo.
  // EVM: calls on-chain name()/symbol()/decimals() + CoinGecko contract endpoint.
  // TRON: calls CoinGecko platform=tron contract endpoint.
  // Others: CoinGecko only (best-effort).
  app.get('/admin/gas/token-address-lookup', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { address, chainSlug } = req.query as { address?: string; chainSlug?: string }
    if (!address || !chainSlug) throw new AppError('VALIDATION_ERROR', 'address and chainSlug are required', 400)

    const addr = address.trim()
    const slug = chainSlug.trim().toLowerCase()

    // CoinGecko platform slugs
    const CG_PLATFORM: Record<string, string> = {
      ethereum: 'ethereum', bsc: 'binance-smart-chain', polygon: 'polygon-pos',
      arbitrum: 'arbitrum-one', optimism: 'optimistic-ethereum', base: 'base',
      avalanche: 'avalanche', tron: 'tron',
    }

    // backendChainId → deposit chain slug (for RPC lookup)
    const BACKEND_TO_CHAIN: Record<string, string> = {
      ETH: 'ethereum', BSC: 'bsc', MATIC: 'polygon',
      ARB: 'arbitrum', OP: 'optimism', BASE: 'base', AVAX: 'avalanche',
    }

    // TrustWallet chain folder names
    const TW_CHAIN: Record<string, string> = {
      ethereum: 'ethereum', bsc: 'smartchain', polygon: 'polygon',
      arbitrum: 'arbitrum', optimism: 'optimism', base: 'base',
    }

    let name: string | null = null
    let symbol: string | null = null
    let decimals: number | null = null
    let logoUrl: string | null = null
    let onChainVerified = false
    let coingeckoVerified = false
    const errors: string[] = []

    const cgHeaders: Record<string, string> = env.COINGECKO_API_KEY
      ? { 'x-cg-demo-api-key': env.COINGECKO_API_KEY }
      : {}

    // ── Layer 1: On-chain RPC (EVM only) ──────────────────────────────────────
    // Find the deposit-chain slug for this gas chain by matching backendChainId
    const gasChain = await db.gasChainConfig.findFirst({ where: { slug: chainSlug.toUpperCase() } })
    const depositSlug = gasChain?.backendChainId ? BACKEND_TO_CHAIN[gasChain.backendChainId] : null
    const rpcUrl = depositSlug ? getRpcUrl(depositSlug) : null

    if (rpcUrl && addr.startsWith('0x')) {
      try {
        const nameSelector     = '0x06fdde03' // name()
        const symbolSelector   = '0x95d89b41' // symbol()
        const decimalsSelector = '0x313ce567' // decimals()

        const ethCall = async (data: string): Promise<string> => {
          const body = { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: addr, data }, 'latest'] }
          const r = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) })
          const json = await r.json() as { result?: string; error?: { message: string } }
          if (json.error) throw new Error(json.error.message)
          return json.result ?? '0x'
        }

        const decodeString = (hex: string): string | null => {
          const clean = hex.startsWith('0x') ? hex.slice(2) : hex
          if (clean.length < 128) return null
          const len = parseInt(clean.slice(64, 128), 16)
          const strHex = clean.slice(128, 128 + len * 2)
          return Buffer.from(strHex, 'hex').toString('utf8').replace(/\0/g, '') || null
        }

        const [nameHex, symbolHex, decimalsHex] = await Promise.all([
          ethCall(nameSelector), ethCall(symbolSelector), ethCall(decimalsSelector),
        ])
        name     = decodeString(nameHex)
        symbol   = decodeString(symbolHex)
        decimals = decimalsHex && decimalsHex !== '0x' ? Number(BigInt(decimalsHex)) : null
        if (symbol) onChainVerified = true
      } catch (err) {
        errors.push(`On-chain: ${err instanceof Error ? err.message : 'RPC call failed'}`)
      }
    }

    // ── Layer 2: CoinGecko contract endpoint ──────────────────────────────────
    const cgPlatform = CG_PLATFORM[slug] ?? CG_PLATFORM[depositSlug ?? '']
    if (cgPlatform) {
      try {
        const res = await fetch(
          `https://api.coingecko.com/api/v3/coins/${cgPlatform}/contract/${encodeURIComponent(addr)}`,
          { headers: cgHeaders, signal: AbortSignal.timeout(6000) }
        )
        if (res.ok) {
          const data = await res.json() as {
            name?: string; symbol?: string
            image?: { large?: string; thumb?: string }
            detail_platforms?: Record<string, { decimal_place?: number } | null>
          }
          if (!name   && data.name)   name   = data.name
          if (!symbol && data.symbol) symbol = data.symbol.toUpperCase()
          const platformData = data.detail_platforms?.[cgPlatform]
          if (decimals === null && platformData?.decimal_place != null) decimals = platformData.decimal_place
          logoUrl = data.image?.large ?? data.image?.thumb ?? null
          coingeckoVerified = true
        } else if (res.status !== 404) {
          errors.push(`CoinGecko: HTTP ${res.status}`)
        }
      } catch (err) {
        errors.push(`CoinGecko: ${err instanceof Error ? err.message : 'fetch failed'}`)
      }
    }

    // ── Layer 3: TrustWallet logo (EVM only, fallback) ────────────────────────
    // Use depositSlug as fallback because gas chain slug ('eth') differs from TW key ('ethereum')
    const twKey = TW_CHAIN[slug] ?? TW_CHAIN[depositSlug ?? '']
    if (!logoUrl && twKey) {
      try {
        const twUrl = `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${twKey}/assets/${addr}/logo.png`
        const twRes = await fetch(twUrl, { signal: AbortSignal.timeout(4000) })
        if (twRes.ok) logoUrl = twUrl
      } catch {
        // logo not found — non-fatal
      }
    }

    return reply.send({
      success: true,
      data: {
        address: addr,
        name,
        symbol,
        decimals,
        logoUrl,
        onChainVerified,
        coingeckoVerified,
        errors,
      },
    })
  })

  // GET /admin/gas/chains — list all chains (including inactive)
  app.get('/admin/gas/chains', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const chains = await db.gasChainConfig.findMany({
      orderBy: { displayOrder: 'asc' },
      include: {
        _count: { select: { tokens: true } },
        tokens: { orderBy: { displayOrder: 'asc' } },
      },
    })
    return reply.send({ success: true, data: { chains } })
  })

  // POST /admin/gas/chains — create a new chain
  app.post('/admin/gas/chains', { preHandler: [authenticate, superAdminOnly] }, async (req, reply) => {
    const { z } = await import('zod')
    const schema = z.object({
      name:               z.string().min(1),
      slug:               z.string().min(1),
      symbol:             z.string().min(1),
      category:           z.string().min(1),
      networkLabel:       z.string().min(1),
      addressType:           z.enum(['TRC20', 'EVM', 'SOL', 'SUI', 'TON', 'APTOS', 'BTC_BECH32', 'BTC_LEGACY', 'BTC_P2SH', 'XRP', 'COSMOS', 'NEAR']),
      logoUrl:               z.string().url().refine(validateLogoUrl, { message: 'logoUrl must be a direct image URL (png/jpg/svg/webp). Google Drive share links are not supported.' }).nullable().default(null),
      explorerBase:          z.string().url().nullable().default(null),
      backendChainId:        z.string().nullable().default(null),
      platformFeeUsdt:       z.number().min(0).default(0.25),
      alertThresholdUsd:     z.number().positive().nullable().default(null),
      pauseThresholdUsd:     z.number().positive().nullable().default(null),
      defaultMinAmount:      z.number().positive().nullable().default(null),
      defaultMaxUsdValue:    z.number().positive().nullable().default(null),
      isActive:              z.boolean().default(false),
      isVisibleToUsers:      z.boolean().default(true),
      readinessState:        z.enum(['inactive', 'testing', 'beta', 'stable']).default('inactive'),
      displayOrder:          z.number().int().default(0),
      // Operational / chain-registry fields
      chainType:             z.enum(['EVM', 'APTOS', 'TRON', 'SOLANA', 'TON', 'SUI', 'CUSTOM']).default('EVM'),
      rpcUrl:                z.string().url().nullable().default(null),
      rpcUrlFallback:        z.string().url().nullable().default(null),
      feeMethod:             z.enum(['EVM_RPC', 'APTOS_API', 'TRON_API', 'SOLANA_API', 'TON_API', 'FIXED', 'CUSTOM']).default('EVM_RPC'),
      fixedFeeUsd:           z.number().positive().nullable().default(null),
      coingeckoId:           z.string().nullable().default(null),
      isPaymentEnabled:      z.boolean().default(false),
      depositAddressOverride: z.string().nullable().default(null),
      usdtContractAddress:   z.string().nullable().default(null),
      usdtDecimals:          z.number().int().min(0).max(18).default(6),
    })
    const d = schema.parse(req.body)
    const dupe = await db.gasChainConfig.findUnique({ where: { slug: d.slug.toUpperCase() } })
    if (dupe) throw new AppError('DUPLICATE_CHAIN', `A gas chain with slug ${d.slug.toUpperCase()} already exists (${dupe.name})`, 409)
    const chain = await db.gasChainConfig.create({
      data: {
        name: d.name, slug: d.slug.toUpperCase(), symbol: d.symbol,
        category: d.category, networkLabel: d.networkLabel, addressType: d.addressType,
        logoUrl: d.logoUrl, explorerBase: d.explorerBase,
        backendChainId: d.backendChainId, platformFeeUsdt: d.platformFeeUsdt,
        alertThresholdUsd: d.alertThresholdUsd, pauseThresholdUsd: d.pauseThresholdUsd,
        defaultMinAmount: d.defaultMinAmount, defaultMaxUsdValue: d.defaultMaxUsdValue,
        isActive: d.isActive, isVisibleToUsers: d.isVisibleToUsers,
        readinessState: d.readinessState, displayOrder: d.displayOrder,
        chainType: d.chainType, rpcUrl: d.rpcUrl, rpcUrlFallback: d.rpcUrlFallback,
        feeMethod: d.feeMethod, fixedFeeUsd: d.fixedFeeUsd, coingeckoId: d.coingeckoId,
        isPaymentEnabled: d.isPaymentEnabled, depositAddressOverride: d.depositAddressOverride,
        usdtContractAddress: d.usdtContractAddress, usdtDecimals: d.usdtDecimals,
      },
    })
    await createAuditLog(req.user!.id, 'GAS_CHAIN_CREATED', 'GasChainConfig', chain.id, { slug: chain.slug }, clientIp(req), req.headers['user-agent'] as string | undefined)
    return reply.code(201).send({ success: true, data: chain })
  })

  // PATCH /admin/gas/chains/:id — update chain
  app.patch('/admin/gas/chains/:id', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const chain = await db.gasChainConfig.findUnique({ where: { id }, include: { _count: { select: { tokens: true } } } })
    if (!chain) throw Errors.NOT_FOUND('Gas chain config')

    const body = req.body as Record<string, unknown>
    // Build update data only with keys present in body, converting undefined nullable → null
    const updateData: Record<string, unknown> = {}
    if ('name' in body) updateData.name = body.name
    if ('symbol' in body) updateData.symbol = body.symbol
    if ('category' in body) updateData.category = body.category
    if ('networkLabel' in body) updateData.networkLabel = body.networkLabel
    if ('addressType' in body) updateData.addressType = body.addressType
    if ('logoUrl' in body) {
      const rawLogo = body.logoUrl ?? null
      if (rawLogo !== null) {
        if (typeof rawLogo !== 'string' || !validateLogoUrl(rawLogo))
          throw new AppError('INVALID_URL', 'logoUrl must be a direct image URL (png/jpg/svg/webp). Google Drive share links are not supported.', 400)
      }
      updateData.logoUrl = rawLogo
    }
    if ('explorerBase' in body) updateData.explorerBase = body.explorerBase ?? null
    if ('backendChainId' in body) updateData.backendChainId = body.backendChainId ?? null
    if ('platformFeeUsdt' in body) updateData.platformFeeUsdt = Math.max(0, Number(body.platformFeeUsdt) || 0)
    if ('alertThresholdUsd' in body) updateData.alertThresholdUsd = body.alertThresholdUsd != null ? Math.max(0, Number(body.alertThresholdUsd)) : null
    if ('pauseThresholdUsd' in body) updateData.pauseThresholdUsd = body.pauseThresholdUsd != null ? Math.max(0, Number(body.pauseThresholdUsd)) : null
    if ('defaultMinAmount' in body) updateData.defaultMinAmount = body.defaultMinAmount != null ? Math.max(0, Number(body.defaultMinAmount)) : null
    if ('defaultMaxUsdValue' in body) updateData.defaultMaxUsdValue = body.defaultMaxUsdValue != null ? Math.max(0, Number(body.defaultMaxUsdValue)) : null
    if ('isActive' in body) updateData.isActive = body.isActive
    if ('isVisibleToUsers' in body) updateData.isVisibleToUsers = body.isVisibleToUsers
    // Archiving a chain also forces it hidden from users (archived ⇒ not visible).
    if ('isArchived' in body) {
      updateData.isArchived = !!body.isArchived
      if (body.isArchived) updateData.isVisibleToUsers = false
    }
    if ('displayOrder' in body) updateData.displayOrder = Number(body.displayOrder) || 0
    if ('readinessState' in body) {
      const validStates = ['inactive', 'testing', 'beta', 'stable']
      const state = String(body.readinessState)
      if (!validStates.includes(state)) throw new AppError('VALIDATION_ERROR', `readinessState must be one of: ${validStates.join(', ')}`, 400)
      updateData.readinessState = state
    }
    // Operational / chain-registry fields
    if ('chainType' in body) {
      const valid = ['EVM', 'APTOS', 'TRON', 'SOLANA', 'TON', 'SUI', 'CUSTOM']
      if (!valid.includes(String(body.chainType))) throw new AppError('VALIDATION_ERROR', `chainType must be one of: ${valid.join(', ')}`, 400)
      updateData.chainType = body.chainType
    }
    if ('rpcUrl' in body) updateData.rpcUrl = body.rpcUrl ?? null
    if ('rpcUrlFallback' in body) updateData.rpcUrlFallback = body.rpcUrlFallback ?? null
    if ('feeMethod' in body) {
      const valid = ['EVM_RPC', 'APTOS_API', 'TRON_API', 'SOLANA_API', 'TON_API', 'FIXED', 'CUSTOM']
      if (!valid.includes(String(body.feeMethod))) throw new AppError('VALIDATION_ERROR', `feeMethod must be one of: ${valid.join(', ')}`, 400)
      updateData.feeMethod = body.feeMethod
    }
    if ('fixedFeeUsd' in body) updateData.fixedFeeUsd = body.fixedFeeUsd != null ? Math.max(0, Number(body.fixedFeeUsd)) : null
    if ('coingeckoId' in body) updateData.coingeckoId = body.coingeckoId ?? null
    if ('isPaymentEnabled' in body) updateData.isPaymentEnabled = Boolean(body.isPaymentEnabled)
    if ('depositAddressOverride' in body) updateData.depositAddressOverride = body.depositAddressOverride ?? null
    if ('usdtContractAddress' in body) updateData.usdtContractAddress = body.usdtContractAddress ?? null
    if ('usdtDecimals' in body) updateData.usdtDecimals = Math.max(0, Math.min(18, Number(body.usdtDecimals) || 6))

    // ── Activation guardrails: refuse to enable a chain that isn't operationally ready ──
    const activating = updateData.isActive === true && chain.isActive === false
    if (activating) {
      const effectiveBackendId = (updateData.backendChainId as string | null | undefined) ?? chain.backendChainId
      const effectiveExplorer  = (updateData.explorerBase  as string | null | undefined) ?? chain.explorerBase

      const failures: string[] = []

      // Inbound-only rails (depositAddressOverride set, no GasHotWallet row) are valid
      // for payment reception without gas delivery from this chain — skip hot wallet check.
      const effectiveDepositOverride = (updateData.depositAddressOverride as string | null | undefined) ?? chain.depositAddressOverride
      const isInboundOnlyRail = !!effectiveDepositOverride

      if (!effectiveBackendId && !isInboundOnlyRail) {
        failures.push('backendChainId is not set — delivery is not wired for this chain')
      } else if (effectiveBackendId && !isInboundOnlyRail) {
        // Hot wallet must exist and be active in DB
        const dbChain = effectiveBackendId === 'ETHEREUM' ? 'ETH' : effectiveBackendId
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const hotWallet = await db.gasHotWallet.findFirst({ where: { chain: dbChain as any, isActive: true } })
        if (!hotWallet) failures.push(`No active GasHotWallet row for chain ${effectiveBackendId}`)

        // Live balance fetch must succeed
        if (hotWallet) {
          const { fromDbChain: fdc, GAS_CHAINS } = await import('../lib/gas/gas.chains')
          const { getHotWalletBalance } = await import('../lib/gas/gas.balance')
          try {
            const chainId = fdc(dbChain)
            if (GAS_CHAINS[chainId]) await getHotWalletBalance(chainId, hotWallet.address)
          } catch {
            failures.push(`Balance fetch failed for ${effectiveBackendId} — RPC may be unreachable`)
          }
        }
      }

      if (!effectiveExplorer) failures.push('explorerBase is not configured')
      if (chain._count.tokens === 0) failures.push('No token configs exist for this chain')

      if (failures.length > 0) {
        throw new AppError(
          'CHAIN_NOT_READY',
          `Cannot activate chain — ${failures.length} prerequisite(s) not met:\n• ${failures.join('\n• ')}`,
          422,
        )
      }
    }

    const updated = await db.gasChainConfig.update({ where: { id }, data: updateData })

    // Fine-grained audit: log threshold changes and activation separately
    if ('alertThresholdUsd' in updateData || 'pauseThresholdUsd' in updateData) {
      await createAuditLog(req.user!.id, 'GAS_CHAIN_THRESHOLD_EDITED', 'GasChainConfig', id, {
        slug: chain.slug,
        alertThresholdUsd: updateData.alertThresholdUsd ?? chain.alertThresholdUsd,
        pauseThresholdUsd: updateData.pauseThresholdUsd ?? chain.pauseThresholdUsd,
        prev_alertThresholdUsd: chain.alertThresholdUsd,
        prev_pauseThresholdUsd: chain.pauseThresholdUsd,
      }, clientIp(req), req.headers['user-agent'] as string | undefined)
    }
    if ('isActive' in updateData) {
      await createAuditLog(req.user!.id, activating ? 'GAS_CHAIN_ACTIVATED' : 'GAS_CHAIN_DEACTIVATED', 'GasChainConfig', id, {
        slug: chain.slug, isActive: updateData.isActive,
      })
    }
    if ('isVisibleToUsers' in updateData) {
      await createAuditLog(req.user!.id, updateData.isVisibleToUsers ? 'GAS_CHAIN_SHOWN' : 'GAS_CHAIN_HIDDEN', 'GasChainConfig', id, {
        slug: chain.slug, isVisibleToUsers: updateData.isVisibleToUsers,
      })
    }
    if ('isArchived' in updateData) {
      await createAuditLog(req.user!.id, updateData.isArchived ? 'GAS_CHAIN_ARCHIVED' : 'GAS_CHAIN_UNARCHIVED', 'GasChainConfig', id, {
        slug: chain.slug, isArchived: updateData.isArchived,
      })
    }
    await createAuditLog(req.user!.id, 'GAS_CHAIN_UPDATED', 'GasChainConfig', id, updateData)
    return reply.send({ success: true, data: updated })
  })

  // DELETE /admin/gas/chains/:id — delete chain (only if no orders reference its tokens)
  app.delete('/admin/gas/chains/:id', { preHandler: [authenticate, superAdminOnly] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const chain = await db.gasChainConfig.findUnique({ where: { id }, include: { tokens: { select: { id: true } } } })
    if (!chain) throw Errors.NOT_FOUND('Gas chain config')

    const tokenIds = chain.tokens.map((t) => t.id)
    if (tokenIds.length > 0) {
      const orderCount = await db.gasFeeOrder.count({ where: { gasTokenConfigId: { in: tokenIds } } })
      if (orderCount > 0) {
        throw new AppError('CONFLICT', `Cannot delete chain — ${orderCount} orders reference its tokens`, 409)
      }
    }

    await db.gasChainConfig.delete({ where: { id } })
    await createAuditLog(req.user!.id, 'GAS_CHAIN_DELETED', 'GasChainConfig', id, { slug: chain.slug }, clientIp(req), req.headers['user-agent'] as string | undefined)
    return reply.send({ success: true })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // GAS TOKEN CONFIG CRUD
  // ─────────────────────────────────────────────────────────────────────────

  // GET /admin/gas/tokens — list all tokens, optionally filtered by chainId
  app.get('/admin/gas/tokens', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { chainId } = req.query as { chainId?: string }
    const tokens = await db.gasTokenConfig.findMany({
      where: chainId ? { chainConfigId: chainId } : {},
      orderBy: [{ chain: { displayOrder: 'asc' } }, { displayOrder: 'asc' }],
      include: { chain: { select: { name: true, slug: true, backendChainId: true } } },
    })
    // engineSupported tells the admin UI whether the delivery engine can actually
    // send this token — a non-native token on an unsupported chain stays "coming
    // soon" publicly no matter what flags are set, so the UI must say so.
    const { tokenDeliverySupported } = await import('../lib/gas/gas.delivery')
    const withEngine = tokens.map((t) => ({
      ...t,
      engineSupported: t.tokenType === 'native' ? true : tokenDeliverySupported(t.chain?.backendChainId ?? ''),
    }))
    return reply.send({ success: true, data: { tokens: withEngine } })
  })

  // POST /admin/gas/tokens — create token
  app.post('/admin/gas/tokens', { preHandler: [authenticate, superAdminOnly] }, async (req, reply) => {
    const { z } = await import('zod')
    const schema = z.object({
      chainConfigId:   z.string().min(1),
      name:            z.string().min(1),
      symbol:          z.string().min(1),
      // 'native' | legacy 'token' | named standards from the frontend chain catalog
      // (erc20, bep20, trc20, spl, jetton, coin, fa, …). Backend logic only ever
      // branches on tokenType === 'native', so any named standard is safe to store.
      tokenType:       z.string().regex(/^[a-z0-9_]{2,20}$/, 'tokenType must be a lowercase standard id (e.g. native, erc20, fa)'),
      contractAddress: z.string().nullable().default(null),
      logoUrl:         z.string().url().refine(validateLogoUrl, { message: 'logoUrl must be a direct image URL (png/jpg/svg/webp). Google Drive share links are not supported.' }).nullable().default(null),
      priceSymbol:     z.string().min(1),
      platformFeeUsdt: z.number().min(0).nullable().default(null), // null = inherit from chain
      minAmount:       z.number().positive().nullable().default(null), // null = inherit from chain
      maxUsdValue:     z.number().positive().nullable().default(null), // null = inherit from chain
      presetAmounts:   z.array(z.number().positive()).min(1),
      isActive:        z.boolean().default(true),
      displayOrder:    z.number().int().default(0),
    })
    const d = schema.parse(req.body)
    const chain = await db.gasChainConfig.findUnique({ where: { id: d.chainConfigId } })
    if (!chain) throw Errors.NOT_FOUND('Gas chain config')

    // Guardrail: reject malformed contract addresses for non-native tokens at
    // entry time — a wrong/placeholder address is the root cause of "read failed"
    // balances and potential mis-delivery.
    if (d.tokenType !== 'native' && d.contractAddress) {
      const { addressFormatValid, addressFormatHint } = await import('../lib/gas/gas.tokenAddress')
      if (!addressFormatValid(chain.addressType, chain.chainType, d.contractAddress)) {
        throw new AppError('VALIDATION_ERROR', `Invalid contract address for ${chain.slug} — expected ${addressFormatHint(chain.addressType, chain.chainType)}.`, 400)
      }
    }

    const token = await db.gasTokenConfig.create({
      data: {
        chainConfigId: d.chainConfigId, name: d.name, symbol: d.symbol,
        tokenType: d.tokenType, contractAddress: d.contractAddress, logoUrl: d.logoUrl,
        priceSymbol: d.priceSymbol,
        platformFeeUsdt: d.platformFeeUsdt,
        minAmount: d.minAmount,
        maxUsdValue: d.maxUsdValue,
        presetAmounts: d.presetAmounts, isActive: d.isActive, displayOrder: d.displayOrder,
      },
    })
    await createAuditLog(req.user!.id, 'GAS_TOKEN_CREATED', 'GasTokenConfig', token.id, { symbol: token.symbol, chain: chain.slug }, clientIp(req), req.headers['user-agent'] as string | undefined)
    return reply.code(201).send({ success: true, data: token })
  })

  // PATCH /admin/gas/tokens/:id — update token
  app.patch('/admin/gas/tokens/:id', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const token = await db.gasTokenConfig.findUnique({ where: { id } })
    if (!token) throw Errors.NOT_FOUND('Gas token config')

    const body = req.body as Record<string, unknown>
    const updateData: Record<string, unknown> = {}
    if ('name' in body) updateData.name = body.name
    if ('symbol' in body) updateData.symbol = body.symbol
    if ('tokenType' in body) updateData.tokenType = body.tokenType
    if ('contractAddress' in body) updateData.contractAddress = body.contractAddress ?? null
    if ('logoUrl' in body) {
      const rawLogo = body.logoUrl ?? null
      if (rawLogo !== null) {
        if (typeof rawLogo !== 'string' || !validateLogoUrl(rawLogo))
          throw new AppError('INVALID_URL', 'logoUrl must be a direct image URL (png/jpg/svg/webp). Google Drive share links are not supported.', 400)
      }
      updateData.logoUrl = rawLogo
    }
    if ('priceSymbol' in body) updateData.priceSymbol = body.priceSymbol
    if ('platformFeeUsdt' in body) updateData.platformFeeUsdt = body.platformFeeUsdt != null ? Math.max(0, Number(body.platformFeeUsdt)) : null
    if ('minAmount' in body) updateData.minAmount = body.minAmount != null ? Number(body.minAmount) : null
    if ('maxUsdValue' in body) updateData.maxUsdValue = body.maxUsdValue != null ? Number(body.maxUsdValue) : null
    if ('presetAmounts' in body) updateData.presetAmounts = body.presetAmounts
    if ('isActive' in body) updateData.isActive = body.isActive
    if ('isVisibleToUsers' in body) updateData.isVisibleToUsers = body.isVisibleToUsers
    // Archiving a token also forces it hidden from users (archived ⇒ not visible).
    if ('isArchived' in body) {
      updateData.isArchived = !!body.isArchived
      if (body.isArchived) updateData.isVisibleToUsers = false
    }
    if ('displayOrder' in body) updateData.displayOrder = Number(body.displayOrder) || 0
    // Going live moves real funds — only a super-admin may enable it.
    if ('deliveryLive' in body) {
      if (body.deliveryLive && req.user?.role !== 'super_admin') {
        throw new AppError('FORBIDDEN', 'Only a super-admin can enable token delivery (real funds).', 403)
      }
      updateData.deliveryLive = !!body.deliveryLive
    }

    // ── Guardrails: validate contract address; verify on-chain before go-live ──
    const effType = (updateData.tokenType as string | undefined) ?? token.tokenType
    const effContract = ('contractAddress' in body ? (updateData.contractAddress as string | null) : token.contractAddress)
    const goingLive = updateData.deliveryLive === true
    if (effType !== 'native' && ('contractAddress' in body || 'tokenType' in body || goingLive)) {
      const chain = await db.gasChainConfig.findUnique({ where: { id: token.chainConfigId } })
      if (chain) {
        const { addressFormatValid, addressFormatHint, probeTokenContract } = await import('../lib/gas/gas.tokenAddress')
        if (effContract && !addressFormatValid(chain.addressType, chain.chainType, effContract)) {
          throw new AppError('VALIDATION_ERROR', `Invalid contract address for ${chain.slug} — expected ${addressFormatHint(chain.addressType, chain.chainType)}.`, 400)
        }
        // Going delivery-live moves real funds — confirm a real token lives at the
        // address on-chain first. Blocks the "wrong address" class of failures.
        if (goingLive) {
          // Refuse the flip when the delivery engine has no token sender for this
          // chain — otherwise the token stays "coming soon" publicly despite every
          // admin badge showing green, with nothing actually deliverable.
          const { tokenDeliverySupported } = await import('../lib/gas/gas.delivery')
          if (!tokenDeliverySupported(chain.backendChainId ?? '')) {
            throw new AppError('VALIDATION_ERROR', `Cannot enable delivery: token delivery is not implemented for ${chain.slug} yet — the token would still show "coming soon" publicly.`, 400)
          }
          if (!effContract) throw new AppError('VALIDATION_ERROR', 'Cannot enable delivery: token has no contract address.', 400)
          const owner = await resolveGasHotWalletOwner(chain.backendChainId ?? '')
          if (!owner) throw new AppError('VALIDATION_ERROR', `Cannot verify token: no hot wallet configured for ${chain.slug}.`, 400)
          const probe = await probeTokenContract(chain.backendChainId ?? '', effContract, owner)
          if (!probe.ok) throw new AppError('VALIDATION_ERROR', `On-chain token check failed (${probe.error}). Fix the contract address before enabling delivery.`, 400)
        }
      }
    }

    const updated = await db.gasTokenConfig.update({ where: { id }, data: updateData })
    await createAuditLog(req.user!.id, 'GAS_TOKEN_UPDATED', 'GasTokenConfig', id, updateData)
    return reply.send({ success: true, data: updated })
  })

  // POST /admin/gas/tokens/verify-address — probe a token contract on-chain so the
  // admin UI can validate an address before saving (catches wrong/placeholder
  // addresses that format checks alone can't).
  app.post('/admin/gas/tokens/verify-address', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { chainSlug, contractAddress } = z.object({
      chainSlug: z.string().min(1), contractAddress: z.string().min(1),
    }).parse(req.body)
    const chain = await db.gasChainConfig.findUnique({ where: { slug: chainSlug.toUpperCase() } })
    if (!chain) throw Errors.NOT_FOUND('Gas chain config')
    const { addressFormatValid, addressFormatHint, probeTokenContract } = await import('../lib/gas/gas.tokenAddress')
    if (!addressFormatValid(chain.addressType, chain.chainType, contractAddress)) {
      return reply.send({ success: true, data: { ok: false, decimals: null, error: `Malformed address — expected ${addressFormatHint(chain.addressType, chain.chainType)}.` } })
    }
    const owner = await resolveGasHotWalletOwner(chain.backendChainId ?? '')
    if (!owner) return reply.send({ success: true, data: { ok: false, decimals: null, error: `No hot wallet configured for ${chain.slug}.` } })
    const probe = await probeTokenContract(chain.backendChainId ?? '', contractAddress, owner)
    return reply.send({ success: true, data: probe })
  })

  // DELETE /admin/gas/tokens/:id — delete token (only if no orders reference it)
  app.delete('/admin/gas/tokens/:id', { preHandler: [authenticate, superAdminOnly] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const token = await db.gasTokenConfig.findUnique({ where: { id } })
    if (!token) throw Errors.NOT_FOUND('Gas token config')

    const orderCount = await db.gasFeeOrder.count({ where: { gasTokenConfigId: id } })
    if (orderCount > 0) {
      throw new AppError('CONFLICT', `Cannot delete token — ${orderCount} orders reference it`, 409)
    }

    await db.gasTokenConfig.delete({ where: { id } })
    await createAuditLog(req.user!.id, 'GAS_TOKEN_DELETED', 'GasTokenConfig', id, { symbol: token.symbol }, clientIp(req), req.headers['user-agent'] as string | undefined)
    return reply.send({ success: true })
  })

  // POST /admin/gas/logo-presign — Cloudinary presign for chain/token logo uploads (admin only)
  app.post('/admin/gas/logo-presign', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const schema = z.object({
      mimeType: z.string().regex(/^image\/(png|jpe?g|svg\+xml|webp)$/, 'Only PNG, JPG, SVG, and WebP are allowed'),
    })
    schema.parse(req.body) // validate MIME type only

    if (!env.CLOUDINARY_API_SECRET || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_CLOUD_NAME) {
      throw new AppError('CONFIG_ERROR', 'File upload is not configured', 503)
    }

    const folder = CLOUDINARY_FOLDERS.GAS_LOGO
    const publicId = randomUUID()
    const timestamp = Math.round(Date.now() / 1000)
    const paramsToSign = { timestamp, public_id: publicId, folder }
    const signature = cloudinary.utils.api_sign_request(paramsToSign, env.CLOUDINARY_API_SECRET)

    return reply.send({
      success: true,
      data: {
        url: `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/upload`,
        fields: {
          api_key: env.CLOUDINARY_API_KEY,
          timestamp,
          public_id: publicId,
          folder,
          signature,
        },
        publicUrl: `https://res.cloudinary.com/${env.CLOUDINARY_CLOUD_NAME}/image/upload/${folder}/${publicId}`,
      },
    })
  })

  // ── POST /admin/gas/orders/:id/approve-pkr — approve a payment_uploaded PKR order ──

  app.post('/admin/gas/orders/:id/approve-pkr', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }

    // Read first so we can check expiry before queuing delivery
    const order = await db.gasFeeOrder.findUnique({ where: { id } })
    if (!order) throw Errors.NOT_FOUND('Gas fee order')

    if (order.status !== 'payment_uploaded' || order.paymentCoin !== 'PKR') {
      throw new AppError('CONFLICT', `Order is in '${order.status}' — can only approve payment_uploaded PKR orders`, 409)
    }

    if (order.expiresAt < new Date()) {
      throw new AppError('ORDER_EXPIRED', 'Order has expired. The user must create a new order.', 409)
    }

    // CAS: transition payment_uploaded → payment_detected (guards against race with another admin)
    const claimed = await db.gasFeeOrder.updateMany({
      where: { id, status: 'payment_uploaded', paymentCoin: 'PKR' },
      data:  { status: 'payment_detected' },
    })
    if (claimed.count === 0) {
      throw new AppError('CONFLICT', 'Order was already processed by another admin', 409)
    }
    await queues.gasFee.add('deliver', { orderId: id }, { priority: 1 })
    await createAuditLog(req.user!.id, 'GAS_PKR_APPROVED', 'GasFeeOrder', id, {
      orderRef:   order.orderRef,
      oldStatus:  'payment_uploaded',
      newStatus:  'payment_detected',
      paymentCoin: order.paymentCoin,
      pkrAmount:  order.pkrAmount?.toString() ?? null,
    }, clientIp(req), req.headers['user-agent'] as string | undefined)
    return reply.send({ success: true, data: { status: 'payment_detected' } })
  })

  // ── POST /admin/gas/orders/:id/reject-pkr — reject a payment_uploaded PKR order ────

  app.post('/admin/gas/orders/:id/reject-pkr', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as { reason?: string }
    const reason = body?.reason ?? 'PKR payment rejected by admin'
    const claimed = await db.gasFeeOrder.updateMany({
      where: { id, status: 'payment_uploaded', paymentCoin: 'PKR' },
      data:  { status: 'failed', failureReason: reason },
    })
    if (claimed.count === 0) {
      const order = await db.gasFeeOrder.findUnique({ where: { id } })
      if (!order) throw Errors.NOT_FOUND('Gas fee order')
      throw new AppError('CONFLICT', `Order is in '${order.status}' — can only reject payment_uploaded PKR orders`, 409)
    }
    await createAuditLog(req.user!.id, 'GAS_PKR_REJECTED', 'GasFeeOrder', id, { reason }, clientIp(req), req.headers['user-agent'] as string | undefined)
    return reply.send({ success: true, data: { status: 'failed' } })
  })

  // ── POST /admin/gas/orders/:id/mark-payment — manually confirm payment received ────

  app.post('/admin/gas/orders/:id/mark-payment', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as { txHash?: string }
    const txHash = body?.txHash?.trim() || null

    const order = await db.gasFeeOrder.findUnique({ where: { id } })
    if (!order) throw Errors.NOT_FOUND('Gas fee order')

    // Admins can confirm payment on any non-terminal status — including:
    //   payment_verified: auto-verified by poller, admin clicks "Release Gas"
    //   payment_pending/payment_uploaded: manual confirmation (no auto-detection)
    //   expired: user paid after the timer ran out
    const allowedStatuses = ['payment_pending', 'payment_uploaded', 'payment_verified', 'expired']
    if (!allowedStatuses.includes(order.status)) {
      throw new AppError('CONFLICT', `Order is in '${order.status}' — can only confirm payment for pending, uploaded, verified, or expired orders`, 409)
    }

    const wasAutoVerified = order.status === 'payment_verified'
    const claimed = await db.gasFeeOrder.updateMany({
      where: { id, status: { in: ['payment_pending', 'payment_uploaded', 'payment_verified', 'expired'] } },
      data:  { status: 'payment_detected', ...(txHash ? { paymentTxHash: txHash } : {}) },
    })
    if (claimed.count === 0) {
      throw new AppError('CONFLICT', 'Order was already processed by another admin', 409)
    }
    await queues.gasFee.add('deliver', { orderId: id }, { priority: 1 })
    await createAuditLog(req.user!.id, 'GAS_PAYMENT_MANUALLY_CONFIRMED', 'GasFeeOrder', id, { txHash, wasAutoVerified }, clientIp(req), req.headers['user-agent'] as string | undefined)
    return reply.send({ success: true, data: { status: 'payment_detected' } })
  })

  // ── POST /admin/gas/orders/:id/cancel — cancel a payment_pending order ────────────

  app.post('/admin/gas/orders/:id/cancel', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as { reason?: string }
    const reason = body?.reason?.trim() || 'Cancelled by admin'

    const claimed = await db.gasFeeOrder.updateMany({
      where: { id, status: { in: ['payment_pending', 'payment_uploaded', 'payment_verified'] } },
      data:  { status: 'failed', failureReason: reason },
    })
    if (claimed.count === 0) {
      const order = await db.gasFeeOrder.findUnique({ where: { id } })
      if (!order) throw Errors.NOT_FOUND('Gas fee order')
      throw new AppError('CONFLICT', `Order is in '${order.status}' — can only cancel pending, uploaded, or verified orders`, 409)
    }
    await createAuditLog(req.user!.id, 'GAS_ORDER_CANCELLED', 'GasFeeOrder', id, { reason }, clientIp(req), req.headers['user-agent'] as string | undefined)
    return reply.send({ success: true, data: { status: 'failed' } })
  })

  // ── GET /admin/gas/custom-requests — list custom gas fee requests ─────────────────

  app.get('/admin/gas/custom-requests', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { z } = await import('zod')
    const qSchema = z.object({
      page:   z.coerce.number().int().positive().default(1),
      limit:  z.coerce.number().int().min(1).max(50).default(20),
      status: z.enum(['pending', 'reviewing', 'completed', 'rejected']).optional(),
    })
    const { page, limit, status } = qSchema.parse(req.query)
    const skip = (page - 1) * limit
    const where = status ? { status } : {}
    const [requests, total] = await Promise.all([
      db.gasCustomRequest.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
      db.gasCustomRequest.count({ where }),
    ])
    return reply.send({ success: true, data: { requests, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } } })
  })

  // ── PATCH /admin/gas/custom-requests/:id — update status/notes ───────────────────

  app.patch('/admin/gas/custom-requests/:id', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { z } = await import('zod')
    const schema = z.object({
      status:     z.enum(['pending', 'reviewing', 'completed', 'rejected']).optional(),
      adminNotes: z.string().max(1000).optional(),
    })
    const { id } = req.params as { id: string }
    const body = schema.parse(req.body)
    const existing = await db.gasCustomRequest.findUnique({ where: { id } })
    if (!existing) throw Errors.NOT_FOUND('Gas custom request')
    // Build update payload explicitly — exactOptionalPropertyTypes requires no undefined values on the data object
    const updated = await db.gasCustomRequest.update({
      where: { id },
      data: {
        ...(body.status     !== undefined ? { status:     body.status     } : {}),
        ...(body.adminNotes !== undefined ? { adminNotes: body.adminNotes } : {}),
      },
    })
    await createAuditLog(req.user!.id, 'GAS_CUSTOM_REQUEST_UPDATED', 'GasCustomRequest', id, body)
    return reply.send({ success: true, data: updated })
  })

  // ── POST /admin/gas/wallets/:chain/test-rpc — validate RPC + signer + address ──

  app.post('/admin/gas/wallets/:chain/test-rpc', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { chain } = req.params as { chain: string }
    const { GAS_CHAINS, fromDbChain } = await import('../lib/gas/gas.chains')
    const { getEvmHotWalletAddress, getTronHotWalletAddress } = await import('../lib/gas/gasWalletService')
    const { getSolanaHotWalletAddress } = await import('../lib/gas/solanaWalletService')
    const { getTonHotWalletAddress }    = await import('../lib/gas/tonWalletService')
    const { getSuiHotWalletAddress }    = await import('../lib/gas/suiWalletService')

    const wallet = await db.gasHotWallet.findFirst({
      where: { chain: chain as 'TRON' | 'BSC' | 'ETH' | 'SOL' | 'MATIC' | 'ARB' | 'BASE' | 'TON' | 'AVAX' | 'OP' | 'SUI', hdIndex: 0 },
    })
    if (!wallet) throw Errors.NOT_FOUND('Gas hot wallet')

    const chainId = fromDbChain(chain)
    const chainConfig = GAS_CHAINS[chainId]
    if (!chainConfig) throw new AppError('CHAIN_NOT_SUPPORTED', `RPC test not supported for ${chain}`, 400)

    // 1. RPC reachability + latest block
    const rpcResult = await testRpcHealth(chainId)

    // 2. Signer / address derivation check
    let signerOk = false
    let derivedAddress: string | null = null
    let signerError: string | undefined
    try {
      if (chain === 'TRON') {
        derivedAddress = getTronHotWalletAddress()
      } else if (chain === 'SOL') {
        derivedAddress = getSolanaHotWalletAddress()
      } else if (chain === 'TON') {
        derivedAddress = getTonHotWalletAddress()
      } else if (chain === 'SUI') {
        derivedAddress = getSuiHotWalletAddress()
      } else {
        // All EVM chains share the same hot wallet address
        derivedAddress = getEvmHotWalletAddress()
      }
      signerOk = !!derivedAddress
      if (!signerOk) signerError = 'Mnemonic system not configured (GAS_MASTER_KEY / GAS_SEED_CIPHERTEXT missing)'
    } catch (err) {
      signerError = err instanceof Error ? err.message : String(err)
    }

    // 3. Address match check (derived vs DB)
    const addressMatch = derivedAddress
      ? derivedAddress.toLowerCase() === wallet.address.toLowerCase()
      : null

    await createAuditLog(req.user!.id, 'GAS_RPC_TESTED', 'GasHotWallet', wallet.id, {
      chain, rpcOk: rpcResult.reachable, signerOk, addressMatch,
    }, clientIp(req), req.headers['user-agent'] as string | undefined)

    return reply.send({
      success: true,
      data: {
        chain,
        rpc: {
          reachable:   rpcResult.reachable,
          blockNumber: rpcResult.blockNumber ?? null,
          latencyMs:   rpcResult.latencyMs,
          isStale:     rpcResult.isStale ?? false,
          error:       rpcResult.error ?? null,
        },
        signer: {
          ok:           signerOk,
          derivedAddress,
          walletAddress: wallet.address,
          addressMatch,
          error:        signerError ?? null,
        },
        allClear: rpcResult.reachable && signerOk && addressMatch !== false,
      },
    })
  })

  // ── GET /admin/gas/global-pause — read the global pause switch ────────────────

  app.get('/admin/gas/global-pause', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const row = await db.platformConfig.findUnique({ where: { key: 'gas_global_pause' } })
    const paused = row?.value === '1'
    const reason = paused ? (await db.platformConfig.findUnique({ where: { key: 'gas_global_pause_reason' } }))?.value ?? null : null
    return reply.send({ success: true, data: { paused, reason } })
  })

  // ── POST /admin/gas/global-pause — set or clear the global pause (super_admin) ─

  app.post('/admin/gas/global-pause', { preHandler: [authenticate, superAdminOnly] }, async (req, reply) => {
    const { paused, reason } = req.body as { paused: boolean; reason?: string }
    if (typeof paused !== 'boolean') throw new AppError('VALIDATION_ERROR', 'paused must be a boolean', 400)

    await db.platformConfig.upsert({
      where:  { key: 'gas_global_pause' },
      create: { key: 'gas_global_pause', value: paused ? '1' : '0' },
      update: { value: paused ? '1' : '0' },
    })
    if (paused && reason) {
      await db.platformConfig.upsert({
        where:  { key: 'gas_global_pause_reason' },
        create: { key: 'gas_global_pause_reason', value: reason },
        update: { value: reason },
      })
    } else if (!paused) {
      await db.platformConfig.deleteMany({ where: { key: 'gas_global_pause_reason' } })
    }

    await createAuditLog(req.user!.id, paused ? 'GAS_GLOBAL_PAUSED' : 'GAS_GLOBAL_RESUMED', 'PlatformConfig', 'gas_global_pause', {
      paused, reason: reason ?? null,
    })

    return reply.send({ success: true, data: { paused, reason: reason ?? null } })
  })

  // ── GET /admin/gas/system-health — comprehensive production health check ───────
  //
  // Returns a single payload covering every aspect of the gas fee system:
  //   - RPC connectivity for all configured chains
  //   - Hot wallet balances + status
  //   - Queue health (BullMQ)
  //   - Redis connectivity
  //   - Mnemonic system status
  //   - Global pause state
  //   - Stale rate warnings
  //   - Chain readiness matrix
  //   - Delivery health per chain

  app.get('/admin/gas/system-health', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const { redis: redisClient } = await import('../lib/redis')
    const { GAS_CHAINS, fromDbChain, SUPPORTED_GAS_CHAINS } = await import('../lib/gas/gas.chains')
    const { testRpcHealth, getNativeUsdPrice } = await import('../lib/gas/gas.balance')
    const { gasWalletIsConfigured, getTronHotWalletAddress, getEvmHotWalletAddress, getEffectiveDepositAddress } = await import('../lib/gas/gasWalletService')
    const { getSolanaHotWalletAddress } = await import('../lib/gas/solanaWalletService')
    const { getTonHotWalletAddress }    = await import('../lib/gas/tonWalletService')
    const { getSuiHotWalletAddress }    = await import('../lib/gas/suiWalletService')
    const { CHAIN_READINESS_MATRIX, UNSUPPORTED_FEATURES, getChainCapabilities, buildChainReadinessReport } = await import('../lib/gas/chainMeta')
    const { getUsdtContractAddress }    = await import('../lib/gas/gas.refund')
    const { getAllChainRpcFallbackStatus } = await import('../lib/gas/rpcFallback')
    const { env: envVars }              = await import('../lib/env')

    // ── 1. Redis health ────────────────────────────────────────────────────────
    let redisOk = false
    let redisError: string | undefined
    try {
      await redisClient.ping()
      redisOk = true
    } catch (err) {
      redisError = err instanceof Error ? err.message : String(err)
    }

    // ── 2. Mnemonic system ────────────────────────────────────────────────────
    const mnemonicConfigured = gasWalletIsConfigured()
    const mnemonicAddresses = mnemonicConfigured ? {
      tron: getTronHotWalletAddress(),
      evm:  getEvmHotWalletAddress(),
      sol:  getSolanaHotWalletAddress(),
      ton:  getTonHotWalletAddress(),
      sui:  getSuiHotWalletAddress(),
    } : null

    // ── 3. Global pause ───────────────────────────────────────────────────────
    const globalPauseRow = await db.platformConfig.findUnique({ where: { key: 'gas_global_pause' } })
    const globallyPaused = globalPauseRow?.value === '1'

    // ── 4. Hot wallets from DB ────────────────────────────────────────────────
    const wallets = await db.gasHotWallet.findMany({ where: { isActive: true } })
    const chainConfigs = await db.gasChainConfig.findMany({
      select: { slug: true, backendChainId: true, alertThresholdUsd: true, pauseThresholdUsd: true, readinessState: true, isActive: true },
    })
    const chainConfigMap = Object.fromEntries(chainConfigs.map((c) => [c.slug, c]))

    // ── 5. RPC health for all supported chains (parallel, best-effort) ────────
    const rpcResults = await Promise.allSettled(
      SUPPORTED_GAS_CHAINS.map(async (chainId) => {
        const rpc = await testRpcHealth(chainId)
        const pausedKey = `gas_wallet_paused:${chainId === 'ETHEREUM' ? 'ETH' : chainId}`
        const isPaused = !!(await redisClient.get(pausedKey))
        return { chainId, rpc, isPaused }
      })
    )

    const rpcMap: Record<string, { reachable: boolean; latencyMs: number; isStale?: boolean; blockNumber?: number; error?: string; isPaused: boolean }> = {}
    for (const r of rpcResults) {
      if (r.status === 'fulfilled') {
        const { chainId, rpc, isPaused } = r.value
        rpcMap[chainId] = {
          reachable: rpc.reachable,
          latencyMs: rpc.latencyMs,
          ...(rpc.isStale !== undefined ? { isStale: rpc.isStale } : {}),
          ...(rpc.blockNumber !== undefined ? { blockNumber: rpc.blockNumber } : {}),
          ...(rpc.error !== undefined ? { error: rpc.error } : {}),
          isPaused,
        }
      }
    }

    // ── 6. Wallet health (cached balances) ────────────────────────────────────
    const walletHealth = await Promise.all(
      wallets.map(async (w) => {
        const chainId = fromDbChain(w.chain)
        const dbChain = w.chain as string
        const balanceKey    = `gas_wallet_balance:${dbChain}`
        const balanceUsdKey = `gas_wallet_balance_usd:${dbChain}`
        const pausedKey     = `gas_wallet_paused:${dbChain}`
        const [balStr, balUsdStr, pausedStr] = await Promise.all([
          redisClient.get(balanceKey),
          redisClient.get(balanceUsdKey),
          redisClient.get(pausedKey),
        ])
        const balance    = balStr    ? parseFloat(balStr)    : null
        const balanceUsd = balUsdStr ? parseFloat(balUsdStr) : null
        const isPaused   = !!pausedStr
        const cfg = GAS_CHAINS[chainId]
        const chainCfg = chainConfigMap[dbChain === 'ETH' ? 'ETH' : dbChain]
        const usdPrice = await getNativeUsdPrice(chainId).catch(() => 0)
        const alertThresholdUsd = chainCfg?.alertThresholdUsd ?? null
        const pauseThresholdUsd = chainCfg?.pauseThresholdUsd ?? null
        let status: 'healthy' | 'low' | 'paused' | 'unavailable' = 'unavailable'
        if (balanceUsd !== null) {
          if (isPaused || (pauseThresholdUsd !== null && balanceUsd <= pauseThresholdUsd)) status = 'paused'
          else if (alertThresholdUsd !== null && balanceUsd <= alertThresholdUsd) status = 'low'
          else status = 'healthy'
        }
        return {
          chain: dbChain,
          chainId,
          address: w.address,
          nativeSymbol: cfg?.nativeSymbol ?? dbChain,
          balance,
          balanceUsd,
          usdPrice,
          isPaused,
          status,
          alertThresholdUsd,
          pauseThresholdUsd,
          lastRefreshedAt: w.lastBalanceRefreshAt?.toISOString() ?? null,
        }
      })
    )

    // ── 7. Stale rate detection ───────────────────────────────────────────────
    // POL is the renamed MATIC — check both so the dashboard flags either as stale
    const rateSymbols = ['TRX', 'BNB', 'ETH', 'MATIC', 'POL', 'AVAX', 'SOL', 'TON', 'SUI']
    const rateChecks = await Promise.all(
      rateSymbols.map(async (sym) => {
        const v = await redisClient.get(`rate:${sym}`)
        return { symbol: sym, hasRate: !!v }
      })
    )
    const staleRates = rateChecks.filter((r) => !r.hasRate).map((r) => r.symbol)

    // ── 8. BullMQ queue health ────────────────────────────────────────────────
    // Includes a small sample of recent failed jobs (id, reason, attempts, when)
    // so admins can see WHY a queue is red instead of just a count. Retry / clear
    // actions live at POST /admin/gas/queues/:name/{retry-failed,clean-failed}.
    interface FailedJobInfo { id: string; name: string; failedReason: string; attemptsMade: number; failedAt: string | null }
    let queueHealth: Array<{ name: string; waiting: number; active: number; failed: number; lastError: string | null; lastFailedAt: string | null; failedJobs: FailedJobInfo[] }> = []
    try {
      const { queues } = await import('../queues/definitions')
      const queueEntries = Object.entries(queues)
      queueHealth = await Promise.all(
        queueEntries.map(async ([name, q]) => {
          const [waiting, active, failed] = await Promise.all([
            q.getWaitingCount().catch(() => -1),
            q.getActiveCount().catch(() => -1),
            q.getFailedCount().catch(() => -1),
          ])
          let failedJobs: FailedJobInfo[] = []
          if (failed > 0) {
            const jobs = await q.getFailed(0, 4).catch(() => [])
            failedJobs = jobs.map((j) => ({
              id: String(j.id ?? ''),
              name: j.name,
              failedReason: (j.failedReason ?? 'unknown error').slice(0, 300),
              attemptsMade: j.attemptsMade,
              failedAt: j.finishedOn ? new Date(j.finishedOn).toISOString() : null,
            }))
          }
          return {
            name, waiting, active, failed,
            lastError: failedJobs[0]?.failedReason ?? null,
            lastFailedAt: failedJobs[0]?.failedAt ?? null,
            failedJobs,
          }
        })
      )
    } catch {
      // Queue health is best-effort — don't fail the endpoint
    }

    // ── 9. Delivery health per chain ──────────────────────────────────────────
    const [pendingDeliveries, failedDeliveries] = await Promise.all([
      db.gasFeeOrder.groupBy({
        by: ['chain', 'status'],
        where: { status: { in: ['payment_detected', 'sending'] } },
        _count: { status: true },
      }),
      db.gasFeeOrder.groupBy({
        by: ['chain'],
        where: { status: 'failed', createdAt: { gte: new Date(Date.now() - 24 * 60 * 60_000) } },
        _count: { status: true },
      }),
    ])

    const deliveryHealth: Record<string, { pending: number; failed24h: number }> = {}
    for (const r of pendingDeliveries) deliveryHealth[r.chain as string] = { pending: r._count.status, failed24h: 0 }
    for (const r of failedDeliveries) {
      const key = r.chain as string
      if (!deliveryHealth[key]) deliveryHealth[key] = { pending: 0, failed24h: 0 }
      deliveryHealth[key]!.failed24h = r._count.status
    }

    // ── 10. Chain readiness state ─────────────────────────────────────────────
    const chainReadiness = chainConfigs.map((c) => ({
      slug:          c.slug,
      readinessState: c.readinessState,
      isActive:      c.isActive,
      hasBackend:    !!c.backendChainId,
      capabilities:  getChainCapabilities(c.slug),
      rpc:           rpcMap[c.backendChainId === 'ETH' ? 'ETHEREUM' : (c.backendChainId ?? c.slug)] ?? null,
    }))

    // ── 11. RPC fallback status (parallel probe of all EVM chain fallback lists) ─
    const evmRpcUrls: Partial<Record<string, string>> = {
      ETHEREUM: envVars.ETHEREUM_RPC_URL,
      BSC:      envVars.BSC_RPC_URL,
      BASE:     envVars.BASE_RPC_URL,
      ARB:      envVars.ARBITRUM_RPC_URL,
      OP:       envVars.OPTIMISM_RPC_URL,
      MATIC:    envVars.POLYGON_RPC_URL,
      AVAX:     envVars.AVALANCHE_RPC_URL,
    }
    const rpcFallbackStatus = await getAllChainRpcFallbackStatus(
      evmRpcUrls as Parameters<typeof getAllChainRpcFallbackStatus>[0]
    ).catch(() => [])

    // ── 12. Per-chain deposit + refund + confirmation readiness ────────────────
    // Covers all EVM chains + TRON. SOL/TON/SUI remain inactive.
    const chainDepositRefundReadiness = (() => {
      const evmDepositAddr = getEffectiveDepositAddress('ETHEREUM', envVars.GAS_FEE_DEPOSIT_ADDRESS_ERC20 ?? undefined)
      const tronDepositAddr = getEffectiveDepositAddress('TRON', envVars.GAS_FEE_DEPOSIT_ADDRESS_TRC20 ?? undefined)

      const chainEnvDepositMap: Record<string, string | undefined> = {
        TRON:     envVars.GAS_FEE_DEPOSIT_ADDRESS_TRC20,
        BSC:      envVars.GAS_FEE_DEPOSIT_ADDRESS_BEP20,
        ETHEREUM: envVars.GAS_FEE_DEPOSIT_ADDRESS_ERC20,
        BASE:     envVars.GAS_FEE_DEPOSIT_ADDRESS_BASE,
        ARB:      envVars.GAS_FEE_DEPOSIT_ADDRESS_ARB,
        OP:       envVars.GAS_FEE_DEPOSIT_ADDRESS_OP,
        MATIC:    envVars.GAS_FEE_DEPOSIT_ADDRESS_MATIC,
        AVAX:     envVars.GAS_FEE_DEPOSIT_ADDRESS_AVAX,
      }

      return Object.entries(chainEnvDepositMap).map(([chain, envAddr]) => {
        const backendChainKey = chain === 'ETHEREUM' ? 'ETHEREUM' : chain
        const rpcStatus = rpcMap[backendChainKey]
        const depositAddr = envAddr ?? (chain === 'TRON' ? tronDepositAddr.address : evmDepositAddr.address)
        const depositSource = envAddr
          ? ('env_var' as const)
          : (chain === 'TRON' ? tronDepositAddr.source : evmDepositAddr.source)

        return buildChainReadinessReport(chain, {
          depositAddress:     depositAddr ?? null,
          depositSource,
          usdtContract:       getUsdtContractAddress(chain as import('../lib/gas/gas.chains').GasChainId),
          mnemonicConfigured,
          rpcReachable:       rpcStatus?.reachable ?? false,
        })
      })
    })()

    // ── Final assembly ────────────────────────────────────────────────────────
    const criticalIssues: string[] = []
    if (!redisOk) criticalIssues.push('Redis unreachable')
    if (globallyPaused) criticalIssues.push('Gas system globally paused')
    if (!mnemonicConfigured) criticalIssues.push('Gas mnemonic not configured — delivery requires mnemonic')
    for (const w of walletHealth) {
      if (w.status === 'paused') criticalIssues.push(`${w.chain} wallet auto-paused (below pause threshold)`)
    }
    for (const [chainId, rpc] of Object.entries(rpcMap)) {
      if (!rpc.reachable) criticalIssues.push(`${chainId} RPC unreachable: ${rpc.error}`)
    }
    for (const report of chainDepositRefundReadiness) {
      if (!report.depositReady) {
        criticalIssues.push(`${report.chain} deposit address not configured`)
      }
    }

    return reply.send({
      success: true,
      data: {
        generatedAt:       new Date().toISOString(),
        overallHealthy:    criticalIssues.length === 0,
        criticalIssues,
        redis: { ok: redisOk, error: redisError ?? null },
        mnemonic: {
          configured: mnemonicConfigured,
          addresses:  mnemonicAddresses,
        },
        globallyPaused,
        rpc:                rpcMap,
        rpcFallbackStatus,
        walletHealth,
        staleRates,
        queueHealth,
        deliveryHealth,
        chainReadiness,
        chainDepositRefundReadiness,
        readinessMatrix:    CHAIN_READINESS_MATRIX,
        unsupportedFeatures: UNSUPPORTED_FEATURES,
      },
    })
  })

  // ── GET /admin/gas/queues/:name/failed — list failed jobs for one queue ───────
  app.get('/admin/gas/queues/:name/failed', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { name } = req.params as { name: string }
    const { queues } = await import('../queues/definitions')
    const q = (queues as Record<string, import('bullmq').Queue>)[name]
    if (!q) throw Errors.NOT_FOUND('Queue')
    const jobs = await q.getFailed(0, 49).catch(() => [])
    return reply.send({
      success: true,
      data: jobs.map((j) => ({
        id: String(j.id ?? ''),
        name: j.name,
        failedReason: (j.failedReason ?? 'unknown error').slice(0, 1000),
        attemptsMade: j.attemptsMade,
        failedAt: j.finishedOn ? new Date(j.finishedOn).toISOString() : null,
        data: j.data,
      })),
    })
  })

  // ── POST /admin/gas/queues/:name/retry-failed — re-enqueue failed jobs ─────────
  app.post('/admin/gas/queues/:name/retry-failed', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { name } = req.params as { name: string }
    const { queues } = await import('../queues/definitions')
    const q = (queues as Record<string, import('bullmq').Queue>)[name]
    if (!q) throw Errors.NOT_FOUND('Queue')
    const jobs = await q.getFailed(0, 199).catch(() => [])
    let retried = 0
    for (const j of jobs) {
      try { await j.retry(); retried++ } catch { /* job may have moved; skip */ }
    }
    void createAuditLog(req.user!.id, 'QUEUE_RETRY_FAILED', 'Queue', name, { retried, total: jobs.length })
    return reply.send({ success: true, data: { retried, total: jobs.length } })
  })

  // ── POST /admin/gas/queues/:name/clean-failed — clear resolved failed jobs ─────
  app.post('/admin/gas/queues/:name/clean-failed', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { name } = req.params as { name: string }
    const { queues } = await import('../queues/definitions')
    const q = (queues as Record<string, import('bullmq').Queue>)[name]
    if (!q) throw Errors.NOT_FOUND('Queue')
    // clean(grace=0, limit, 'failed') removes failed jobs; obliterate is too broad.
    const removed = await q.clean(0, 1000, 'failed').catch(() => [] as string[])
    void createAuditLog(req.user!.id, 'QUEUE_CLEAN_FAILED', 'Queue', name, { removed: removed.length })
    return reply.send({ success: true, data: { removed: removed.length } })
  })

  // ── POST /admin/gas/chains/:chain/dry-run — pre-flight delivery check ─────────

  app.post('/admin/gas/chains/:chain/dry-run', { preHandler: [authenticate, superAdminOnly] }, async (req, reply) => {
    const { chain } = req.params as { chain: string }
    const body = req.body as { toAddress?: string; amount?: number }
    const toAddress = body.toAddress ?? ''
    const amount    = typeof body.amount === 'number' ? body.amount : 0.001

    const { dryRunDelivery } = await import('../lib/gas/gas.delivery')
    const result = await dryRunDelivery(chain, toAddress, amount)

    void createAuditLog(req.user!.id, 'GAS_DRY_RUN', 'GasChain', chain, { toAddress, amount, result })

    return reply.send({ success: true, data: result })
  })

  // ── GET /admin/gas/analytics — delivery analytics ─────────────────────────────

  app.get('/admin/gas/analytics', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { period = '7d' } = req.query as { period?: '24h' | '7d' | '30d' | 'all' }

    const since = period === 'all' ? undefined
      : new Date(Date.now() - (
          period === '24h' ? 86_400_000
          : period === '7d' ? 7 * 86_400_000
          : 30 * 86_400_000
        ))

    const where = since ? { createdAt: { gte: since } } : {}

    const [deliveredOrders, failedCount, chainGroups] = await Promise.all([
      db.gasFeeOrder.findMany({
        where:  { ...where, status: 'delivered', deliveredAt: { not: null } },
        select: { chain: true, createdAt: true, deliveredAt: true },
      }),
      db.gasFeeOrder.count({ where: { ...where, status: 'failed' } }),
      db.gasFeeOrder.groupBy({
        by: ['chain', 'status'],
        where,
        _count: { status: true },
      }),
    ])

    const successCount = deliveredOrders.length

    // Average completion time (ms → seconds)
    let avgCompletionSec: number | null = null
    if (successCount > 0) {
      const totalMs = deliveredOrders.reduce((sum, o) => {
        return sum + (o.deliveredAt!.getTime() - o.createdAt.getTime())
      }, 0)
      avgCompletionSec = Math.round(totalMs / successCount / 1000)
    }

    // Per-chain success rates
    const chainMap: Record<string, { delivered: number; failed: number }> = {}
    for (const g of chainGroups) {
      const c = g.chain as string
      if (!chainMap[c]) chainMap[c] = { delivered: 0, failed: 0 }
      if (g.status === 'delivered') chainMap[c]!.delivered += g._count.status
      if (g.status === 'failed')    chainMap[c]!.failed    += g._count.status
    }
    const chainStats = Object.entries(chainMap).map(([chain, s]) => ({
      chain,
      delivered: s.delivered,
      failed:    s.failed,
      total:     s.delivered + s.failed,
      successRate: s.delivered + s.failed > 0
        ? Math.round((s.delivered / (s.delivered + s.failed)) * 100)
        : null,
    }))

    return reply.send({
      success: true,
      data: {
        period,
        successCount,
        failedCount,
        avgCompletionSec,
        chainStats,
      },
    })
  })

  // ── Treasury Wallet ────────────────────────────────────────────────────────

  // GET /admin/gas/treasury — list treasury wallets with live balances
  app.get('/admin/gas/treasury', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const addrs = getAllTreasuryAddresses()

    const [tronRow, evmRow] = await Promise.all([
      db.gasTreasuryWallet.findUnique({ where: { chain: 'TRON' } }),
      db.gasTreasuryWallet.findUnique({ where: { chain: 'ETH'  } }),
    ])

    const results = await Promise.allSettled([
      addrs.tron ? getTreasuryBalance('TRON')     : Promise.resolve(null),
      addrs.evm  ? getTreasuryBalance('ETHEREUM')  : Promise.resolve(null),
    ])

    return reply.send({
      success: true,
      data: {
        tron: {
          address:        addrs.tron,
          derivationIndex: 100,
          dbRow:           tronRow,
          balance:         results[0].status === 'fulfilled' ? results[0].value : null,
          balanceError:    results[0].status === 'rejected'  ? String(results[0].reason) : null,
        },
        evm: {
          address:         addrs.evm,
          derivationIndex: 101,
          dbRow:           evmRow,
          balance:         results[1].status === 'fulfilled' ? results[1].value : null,
          balanceError:    results[1].status === 'rejected'  ? String(results[1].reason) : null,
          note:            'One EVM address serves ETH, BSC, Base, ARB, OP, Polygon, Avalanche',
        },
      },
    })
  })

  // POST /admin/gas/treasury/seed — create GasTreasuryWallet DB rows from derived addresses
  app.post('/admin/gas/treasury/seed', { preHandler: [authenticate, superAdminOnly] }, async (req, reply) => {
    const tronAddr = getTronTreasuryAddress()
    const evmAddr  = getEvmTreasuryAddress()

    if (!tronAddr || !evmAddr) {
      return reply.status(503).send({ success: false, error: 'Gas wallet mnemonic not configured' })
    }

    const [tronRow, evmRow] = await Promise.all([
      db.gasTreasuryWallet.upsert({
        where: { chain: 'TRON' },
        create: { chain: 'TRON', chainFamily: 'TRON', address: tronAddr, derivationIndex: 100 },
        update: { address: tronAddr, isActive: true },
      }),
      db.gasTreasuryWallet.upsert({
        where: { chain: 'ETH' },
        create: { chain: 'ETH', chainFamily: 'EVM', address: evmAddr, derivationIndex: 101 },
        update: { address: evmAddr, isActive: true },
      }),
    ])

    await createAuditLog(
      (req.user as { id: string }).id,
      'gas_treasury_seed',
      'GasTreasuryWallet',
      'all',
      { tronAddress: tronAddr, evmAddress: evmAddr },
    )

    return reply.send({ success: true, data: { tron: tronRow, evm: evmRow } })
  })

  // ── Accounting Ledger ──────────────────────────────────────────────────────

  // GET /admin/gas/ledger — paginated ledger entries
  app.get('/admin/gas/ledger', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const q = req.query as Record<string, string>
    const { page, limit } = paginationParams(q)

    const result = await getLedgerEntries({
      page,
      limit,
      ...(q.chain     ? { chain:          q.chain     as GasChainId }                          : {}),
      ...(q.entryType ? { entryType:      q.entryType as import('@prisma/client').GasLedgerEntryType } : {}),
      ...(q.orderId   ? { relatedOrderId: q.orderId }                                           : {}),
      ...(q.from      ? { fromDate:       new Date(q.from) }                                    : {}),
      ...(q.to        ? { toDate:         new Date(q.to)   }                                    : {}),
    })

    return reply.send({ success: true, data: result })
  })

  // GET /admin/gas/ledger/summary — aggregated P&L per chain
  app.get('/admin/gas/ledger/summary', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { chain } = req.query as { chain?: string }
    const summary = await getLedgerSummary(chain as GasChainId | undefined)
    return reply.send({ success: true, data: summary })
  })

  // ── Refill Thresholds ──────────────────────────────────────────────────────

  // GET /admin/gas/thresholds — list all per-chain refill thresholds
  app.get('/admin/gas/thresholds', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const thresholds = await getAllThresholds()
    return reply.send({ success: true, data: thresholds })
  })

  // GET /admin/gas/thresholds/:chain — single chain threshold
  app.get('/admin/gas/thresholds/:chain', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { chain } = req.params as { chain: string }
    const threshold = await getThreshold(chain as GasChainId)
    if (!threshold) return reply.status(404).send({ success: false, error: 'Threshold not found' })
    return reply.send({ success: true, data: threshold })
  })

  // PUT /admin/gas/thresholds/:chain — create or update threshold
  app.put('/admin/gas/thresholds/:chain', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { chain } = req.params as { chain: string }
    const body = req.body as {
      triggerBelowNative: number
      refillTargetNative: number
      maxRefillNative: number
      isEnabled?: boolean
    }

    const validationError = validateThreshold(body)
    if (validationError) {
      return reply.status(400).send({ success: false, error: validationError })
    }

    const threshold = await upsertThreshold(chain as GasChainId, body)

    await createAuditLog(
      (req.user as { id: string }).id,
      'gas_threshold_update',
      'GasRefillThreshold',
      chain,
      body as unknown as Record<string, unknown>,
    )

    return reply.send({ success: true, data: threshold })
  })

  // PATCH /admin/gas/thresholds/:chain/toggle — enable/disable
  app.patch('/admin/gas/thresholds/:chain/toggle', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { chain } = req.params as { chain: string }
    const { isEnabled } = req.body as { isEnabled: boolean }

    if (typeof isEnabled !== 'boolean') {
      return reply.status(400).send({ success: false, error: 'isEnabled must be a boolean' })
    }

    const threshold = await setThresholdEnabled(chain as GasChainId, isEnabled)
    return reply.send({ success: true, data: threshold })
  })

  // ── Refill Requests ────────────────────────────────────────────────────────

  // GET /admin/gas/refills — list refill requests with filters
  app.get('/admin/gas/refills', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const q = req.query as Record<string, string>
    const { page, limit, skip } = paginationParams(q)

    const where: Prisma.GasRefillRequestWhereInput = {}
    if (q.chain)  where.chain  = q.chain  as import('@prisma/client').GasChain
    if (q.status) where.status = q.status as import('@prisma/client').GasRefillRequestStatus

    const [refills, total] = await Promise.all([
      db.gasRefillRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { fromWallet: true },
      }),
      db.gasRefillRequest.count({ where }),
    ])

    return reply.send({ success: true, data: { refills, total, page, limit } })
  })

  // GET /admin/gas/refills/:id — single refill request
  app.get('/admin/gas/refills/:id', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const refill = await db.gasRefillRequest.findUnique({
      where: { id },
      include: { fromWallet: true, ledgerEntries: true },
    })
    if (!refill) return reply.status(404).send({ success: false, error: 'Refill request not found' })
    return reply.send({ success: true, data: refill })
  })

  // POST /admin/gas/refills/:id/approve — approve a pending refill
  app.post('/admin/gas/refills/:id/approve', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const adminId = (req.user as { id: string }).id

    try {
      await approveRefill(id, adminId)
      await createAuditLog(adminId, 'gas_refill_approved', 'GasRefillRequest', id, {})
      return reply.send({ success: true, message: 'Refill approved — will execute on next refill job run' })
    } catch (err) {
      return reply.status(400).send({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  // POST /admin/gas/refills/:id/cancel — cancel a pending or approved refill
  app.post('/admin/gas/refills/:id/cancel', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const adminId = (req.user as { id: string }).id

    try {
      await cancelRefill(id, adminId)
      await createAuditLog(adminId, 'gas_refill_cancelled', 'GasRefillRequest', id, {})
      return reply.send({ success: true, message: 'Refill cancelled' })
    } catch (err) {
      return reply.status(400).send({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  // POST /admin/gas/refills/trigger-check — manually trigger balance check + queue refills
  app.post('/admin/gas/refills/trigger-check', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const result = await checkAndQueueRefills()
    return reply.send({ success: true, data: result })
  })

  // POST /admin/gas/refills/process-approved — manually execute all approved refills
  app.post('/admin/gas/refills/process-approved', { preHandler: [authenticate, superAdminOnly] }, async (_req, reply) => {
    const result = await processApprovedRefills()
    return reply.send({ success: true, data: result })
  })

  // GET /admin/gas/treasury/balances — hot vs treasury balance comparison per chain
  app.get('/admin/gas/treasury/balances', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const hotTron = getTronHotWalletAddress()
    const hotEvm  = getEvmHotWalletAddress()
    const trsTron = getTronTreasuryAddress()
    const trsEvm  = getEvmTreasuryAddress()

    const chains: Array<{ chain: GasChainId; hotAddress: string | null; treasuryAddress: string | null }> = [
      { chain: 'TRON',     hotAddress: hotTron, treasuryAddress: trsTron },
      { chain: 'BSC',      hotAddress: hotEvm,  treasuryAddress: trsEvm  },
      { chain: 'ETHEREUM', hotAddress: hotEvm,  treasuryAddress: trsEvm  },
      { chain: 'BASE',     hotAddress: hotEvm,  treasuryAddress: trsEvm  },
      { chain: 'ARB',      hotAddress: hotEvm,  treasuryAddress: trsEvm  },
      { chain: 'OP',       hotAddress: hotEvm,  treasuryAddress: trsEvm  },
      { chain: 'MATIC',    hotAddress: hotEvm,  treasuryAddress: trsEvm  },
      { chain: 'AVAX',     hotAddress: hotEvm,  treasuryAddress: trsEvm  },
    ]

    const balances = await Promise.allSettled(
      chains.map(async ({ chain, hotAddress, treasuryAddress }) => {
        const [hotBal, trsBal, usdPrice] = await Promise.allSettled([
          hotAddress      ? getHotWalletBalance(chain, hotAddress)     : Promise.resolve(null),
          treasuryAddress ? getTreasuryBalance(chain)                   : Promise.resolve(null),
          getNativeUsdPrice(chain),
        ])

        const hot   = hotBal.status === 'fulfilled' ? hotBal.value   : null
        const trs   = trsBal.status === 'fulfilled' ? trsBal.value   : null
        const price = usdPrice.status === 'fulfilled' ? usdPrice.value : 0

        return {
          chain,
          hotAddress,
          hotBalanceNative: hot,
          hotBalanceUsd:    hot != null && price > 0 ? hot * price : null,
          treasuryAddress,
          treasuryBalanceNative: trs,
          treasuryBalanceUsd:    trs != null && price > 0 ? trs * price : null,
          usdPrice: price,
        }
      }),
    )

    return reply.send({
      success: true,
      data: balances.map((r, i) =>
        r.status === 'fulfilled'
          ? r.value
          : { chain: chains[i]!.chain, error: String(r.reason) },
      ),
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // PHASE 4 — RECONCILIATION
  // ─────────────────────────────────────────────────────────────────────────

  app.get('/admin/gas/reconciliation', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { page, limit } = paginationParams(req.query as Record<string, string>)
    const result = await listReconciliationRuns(page, limit)
    return reply.send({ success: true, data: result })
  })

  app.get('/admin/gas/reconciliation/:runId', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { runId } = req.params as { runId: string }
    const run = await getReconciliationRun(runId)
    if (!run) throw Errors.NOT_FOUND('Reconciliation run')
    return reply.send({ success: true, data: run })
  })

  app.post('/admin/gas/reconciliation/trigger', { preHandler: [authenticate, superAdminOnly] }, async (req, reply) => {
    const { chain } = (req.body ?? {}) as { chain?: string }
    // Enqueue rather than run inline to avoid HTTP timeout on large datasets
    await queues.gasReconciliation.add('manual-trigger', { chain: chain ?? null }, { priority: 1 })
    await createAuditLog(req.user!.id, 'GAS_RECONCILIATION_TRIGGERED', 'GasReconciliation', 'manual', { chain: chain ?? 'all' }, clientIp(req), req.headers['user-agent'] as string | undefined)
    return reply.code(202).send({ success: true, data: { queued: true, message: `Reconciliation queued for ${chain ?? 'all chains'}` } })
  })

  app.patch('/admin/gas/reconciliation/discrepancies/:id/resolve', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { adminNote } = (req.body ?? {}) as { adminNote?: string }
    const updated = await resolveDiscrepancy(id, req.user!.id, adminNote)
    await createAuditLog(req.user!.id, 'GAS_DISCREPANCY_RESOLVED', 'GasReconciliationDiscrepancy', id, { adminNote }, clientIp(req), req.headers['user-agent'] as string | undefined)
    return reply.send({ success: true, data: updated })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // PHASE 5 — RISK / FRAUD FLAGGED ORDERS
  // ─────────────────────────────────────────────────────────────────────────

  app.get('/admin/gas/flagged', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const q = req.query as Record<string, string>
    const { page, limit } = paginationParams(q)
    const status = q.status
    const result = await listFlaggedOrders(status, page, limit)
    return reply.send({ success: true, data: result })
  })

  app.patch('/admin/gas/flagged/:id/review', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as { status: 'reviewed_ok' | 'reviewed_blocked'; adminNote?: string }
    if (!['reviewed_ok', 'reviewed_blocked'].includes(body.status)) {
      throw new AppError('VALIDATION_ERROR', 'status must be reviewed_ok or reviewed_blocked', 400)
    }
    const updated = await reviewFlaggedOrder(id, body.status, req.user!.id, body.adminNote)
    await createAuditLog(req.user!.id, 'GAS_FLAGGED_ORDER_REVIEWED', 'GasFlaggedOrder', id, { status: body.status, adminNote: body.adminNote }, clientIp(req), req.headers['user-agent'] as string | undefined)
    return reply.send({ success: true, data: updated })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // PHASE 6 — MERCHANT SETTLEMENT
  // ─────────────────────────────────────────────────────────────────────────

  app.get('/admin/gas/merchants', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { page, limit } = paginationParams(req.query as Record<string, string>)
    const result = await listMerchantAccounts(page, limit)
    return reply.send({ success: true, data: result })
  })

  app.post('/admin/gas/merchants', { preHandler: [authenticate, superAdminOnly] }, async (req, reply) => {
    const body = req.body as { name: string; apiKeyId: string; commissionRate?: number; settlementCycle?: string; payoutAddress?: string }
    if (!body.name || !body.apiKeyId) throw new AppError('VALIDATION_ERROR', 'name and apiKeyId are required', 400)
    const apiKey = await db.merchantApiKey.findUnique({ where: { id: body.apiKeyId }, select: { id: true } })
    if (!apiKey) throw Errors.NOT_FOUND('Merchant API key')
    const account = await createMerchantAccount(body)
    await createAuditLog(req.user!.id, 'GAS_MERCHANT_ACCOUNT_CREATED', 'GasMerchantAccount', account.id, { name: body.name }, clientIp(req), req.headers['user-agent'] as string | undefined)
    return reply.code(201).send({ success: true, data: account })
  })

  app.get('/admin/gas/merchants/:id', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const account = await getMerchantAccount(id)
    if (!account) throw Errors.NOT_FOUND('Merchant account')
    return reply.send({ success: true, data: account })
  })

  app.patch('/admin/gas/merchants/:id', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as { name?: string; commissionRate?: number; settlementCycle?: string; payoutAddress?: string | null; isActive?: boolean }
    const account = await updateMerchantAccount(id, body)
    await createAuditLog(req.user!.id, 'GAS_MERCHANT_ACCOUNT_UPDATED', 'GasMerchantAccount', id, body as Record<string, unknown>)
    return reply.send({ success: true, data: account })
  })

  app.get('/admin/gas/merchants/:id/settlements', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { page, limit } = paginationParams(req.query as Record<string, string>)
    const result = await listMerchantSettlements(id, page, limit)
    return reply.send({ success: true, data: result })
  })

  app.post('/admin/gas/settlements/:id/approve', { preHandler: [authenticate, superAdminOnly] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { adminNote } = (req.body ?? {}) as { adminNote?: string }
    const settlement = await approveSettlement(id, req.user!.id, adminNote)
    await createAuditLog(req.user!.id, 'GAS_SETTLEMENT_APPROVED', 'GasMerchantSettlement', id, { adminNote }, clientIp(req), req.headers['user-agent'] as string | undefined)
    return reply.send({ success: true, data: settlement })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // PHASE 7 — TREASURY ANALYTICS
  // ─────────────────────────────────────────────────────────────────────────

  app.get('/admin/gas/analytics/burn-rates', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const q = req.query as { windowDays?: string; window?: string }
    const windowDays = parseInt(q.windowDays ?? q.window ?? '7', 10)
    const burnRates = await getChainBurnRates(windowDays)
    return reply.send({ success: true, data: { burnRates } })
  })

  app.get('/admin/gas/analytics/runways', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const runways = await getChainRunways()
    return reply.send({ success: true, data: { runways } })
  })

  app.get('/admin/gas/analytics/profitability', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { from, to } = req.query as { from?: string; to?: string }
    const fromDate = from ? new Date(from) : undefined
    const toDate   = to   ? new Date(to)   : undefined
    const profitability = await getProfitabilityByChain(fromDate, toDate)
    return reply.send({ success: true, data: { profitability } })
  })

  app.get('/admin/gas/analytics/volume', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const q = req.query as { chain?: string; windowDays?: string; window?: string }
    const windowDays = parseInt(q.windowDays ?? q.window ?? '30', 10)
    const raw = await getVolumeTimeSeries(q.chain as Parameters<typeof getVolumeTimeSeries>[0], windowDays)
    // Normalize field name: backend uses orderCount, expose as orders for the frontend
    const series = raw.map((d) => ({ date: d.date, orders: d.orderCount, revenueUsd: d.revenueUsd }))
    return reply.send({ success: true, data: { series } })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // PHASE 8 — MULTI-HOT-WALLET MANAGEMENT
  // ─────────────────────────────────────────────────────────────────────────

  app.get('/admin/gas/hot-wallets/:chain', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { chain } = req.params as { chain: string }
    const wallets = await db.gasHotWallet.findMany({
      where: { chain: chain as 'TRON' | 'BSC' | 'ETH' | 'SOL' | 'MATIC' | 'ARB' | 'BASE' | 'OP' | 'AVAX' | 'TON' | 'SUI' },
      orderBy: { hdIndex: 'asc' },
    })
    const { redis: redisClient } = await import('../lib/redis')
    const { tonRawToFriendly } = await import('../lib/gas/tonWalletService')
    const withBalances = await Promise.all(
      wallets.map(async (w) => {
        const balStr    = await redisClient.get(`gas_wallet_balance:${chain}`)
        const balUsdStr = await redisClient.get(`gas_wallet_balance_usd:${chain}`)
        return {
          ...w,
          // TON addresses are stored raw (0:hex64); expose the user-friendly UQ… form for display.
          friendlyAddress: w.chain === 'TON' ? tonRawToFriendly(w.address) : null,
          cachedBalanceNative: balStr    ? parseFloat(balStr)    : null,
          cachedBalanceUsd:    balUsdStr ? parseFloat(balUsdStr) : null,
        }
      }),
    )
    return reply.send({ success: true, data: { wallets: withBalances } })
  })

  app.post('/admin/gas/hot-wallets/:chain/add', { preHandler: [authenticate, superAdminOnly] }, async (req, reply) => {
    const { chain } = req.params as { chain: string }
    const { gasWalletIsConfigured, getTronHotWalletAddress, getEvmHotWalletAddress } = await import('../lib/gas/gasWalletService')

    if (!gasWalletIsConfigured()) {
      throw new AppError('CONFIG_ERROR', 'Gas mnemonic not configured', 503)
    }

    type DbChain = 'TRON' | 'BSC' | 'ETH' | 'SOL' | 'MATIC' | 'ARB' | 'BASE' | 'TON' | 'AVAX' | 'OP' | 'SUI'
    const dbChain = chain.toUpperCase() as DbChain

    // Non-EVM chains (SOL/TON/SUI) derive a single address from the shared mnemonic.
    // Additional hot wallet indices are not supported for these chains — prevent duplicates.
    const NON_EVM_SINGLE_ADDRESS = new Set(['SOL', 'TON', 'SUI'])
    if (NON_EVM_SINGLE_ADDRESS.has(dbChain)) {
      const existing = await db.gasHotWallet.findFirst({ where: { chain: dbChain } })
      if (existing) {
        throw new AppError('CONFLICT', `A hot wallet for ${dbChain} already exists (id: ${existing.id}). Only one hot wallet per non-EVM chain is supported.`, 409)
      }

      const { getSolanaHotWalletAddress } = await import('../lib/gas/solanaWalletService')
      const { getTonHotWalletAddress, tonRawToFriendly } = await import('../lib/gas/tonWalletService')
      const { getSuiHotWalletAddress }    = await import('../lib/gas/suiWalletService')

      let address: string | null = null
      if (dbChain === 'SOL') address = getSolanaHotWalletAddress()
      if (dbChain === 'TON') address = getTonHotWalletAddress()
      if (dbChain === 'SUI') address = getSuiHotWalletAddress()
      if (!address) throw new AppError('DERIVATION_ERROR', `Could not derive ${dbChain} address — check mnemonic configuration`, 500)

      const wallet = await db.gasHotWallet.create({
        data: { chain: dbChain, address, hdIndex: 0, weight: 0, isActive: false },
      })
      await createAuditLog(req.user!.id, 'GAS_HOT_WALLET_ADDED', 'GasHotWallet', wallet.id, { chain: dbChain, hdIndex: 0, address }, clientIp(req), req.headers['user-agent'] as string | undefined)
      // TON addresses are stored raw (0:hex64); expose the user-friendly UQ… form for display.
      const friendlyAddress = dbChain === 'TON' ? tonRawToFriendly(wallet.address) : null
      return reply.code(201).send({ success: true, data: { ...wallet, friendlyAddress } })
    }

    // TRON and EVM chains: find next available hdIndex for multi-wallet load balancing
    const existing = await db.gasHotWallet.findMany({
      where: { chain: dbChain },
      orderBy: { hdIndex: 'desc' },
      take: 1,
    })
    const nextIndex = existing.length > 0 ? existing[0]!.hdIndex + 1 : 1

    const address = dbChain === 'TRON' ? getTronHotWalletAddress(nextIndex) : getEvmHotWalletAddress(nextIndex)
    if (!address) throw new AppError('DERIVATION_ERROR', 'Could not derive address for new wallet', 500)

    const wallet = await db.gasHotWallet.create({
      data: { chain: dbChain, address, hdIndex: nextIndex, weight: 0, isActive: false },
    })
    await createAuditLog(req.user!.id, 'GAS_HOT_WALLET_ADDED', 'GasHotWallet', wallet.id, { chain: dbChain, hdIndex: nextIndex, address }, clientIp(req), req.headers['user-agent'] as string | undefined)
    return reply.code(201).send({ success: true, data: wallet })
  })

  app.patch('/admin/gas/hot-wallets/:id/toggle', { preHandler: [authenticate, superAdminOnly] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const wallet = await db.gasHotWallet.findUnique({ where: { id } })
    if (!wallet) throw Errors.NOT_FOUND('Gas hot wallet')

    // Prevent disabling the last active wallet for a chain — would block all deliveries
    if (wallet.isActive) {
      const activeCount = await db.gasHotWallet.count({ where: { chain: wallet.chain, isActive: true } })
      if (activeCount <= 1) {
        throw new AppError('VALIDATION_ERROR', `Cannot disable the last active wallet for ${wallet.chain}. Fund and activate another wallet first.`, 400)
      }
    }

    const updated = await db.gasHotWallet.update({ where: { id }, data: { isActive: !wallet.isActive } })
    await createAuditLog(req.user!.id, 'GAS_HOT_WALLET_TOGGLED', 'GasHotWallet', id, { chain: wallet.chain, hdIndex: wallet.hdIndex, isActive: updated.isActive }, clientIp(req), req.headers['user-agent'] as string | undefined)
    return reply.send({ success: true, data: { id: updated.id, isActive: updated.isActive } })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // PHASE 9 — EMERGENCY / DISASTER RECOVERY ENDPOINTS
  // ─────────────────────────────────────────────────────────────────────────

  app.get('/admin/gas/emergency/verify-derivation', { preHandler: [authenticate, superAdminOnly] }, async (_req, reply) => {
    const { gasWalletIsConfigured, getTronHotWalletAddress, getEvmHotWalletAddress } = await import('../lib/gas/gasWalletService')
    const { getSolanaHotWalletAddress } = await import('../lib/gas/solanaWalletService')
    const { getTonHotWalletAddress }    = await import('../lib/gas/tonWalletService')
    const { getSuiHotWalletAddress }    = await import('../lib/gas/suiWalletService')

    if (!gasWalletIsConfigured()) throw new AppError('CONFIG_ERROR', 'Gas mnemonic not configured', 503)

    const dbWallets = await db.gasHotWallet.findMany({ orderBy: [{ chain: 'asc' }, { hdIndex: 'asc' }] })

    const report = dbWallets.map((w) => {
      let derivedAddress: string | undefined
      try {
        if (w.chain === 'TRON') derivedAddress = getTronHotWalletAddress(w.hdIndex) ?? undefined
        else if (w.chain === 'SOL') derivedAddress = getSolanaHotWalletAddress() ?? undefined
        else if (w.chain === 'TON') derivedAddress = getTonHotWalletAddress() ?? undefined
        else if (w.chain === 'SUI') derivedAddress = getSuiHotWalletAddress() ?? undefined
        else derivedAddress = getEvmHotWalletAddress(w.hdIndex) ?? undefined
      } catch { /* unsupported chain */ }

      const match = derivedAddress
        ? derivedAddress.toLowerCase() === w.address.toLowerCase()
        : null

      return { chain: w.chain, hdIndex: w.hdIndex, dbAddress: w.address, derivedAddress: derivedAddress ?? null, match }
    })

    const allMatch = report.every((r) => r.match !== false)
    return reply.send({ success: true, data: { allMatch, wallets: report } })
  })

  // ─── Deposit Chain Registry ───────────────────────────────────────────────────

  // GET /admin/deposit-chains — list all deposit chains with token counts
  app.get('/admin/deposit-chains', { preHandler: [authenticate, requireRole('admin', 'super_admin')] }, async (_req, reply) => {
    const rows = await db.depositChain.findMany({
      include: { _count: { select: { tokens: { where: { isActive: true } } } } },
      orderBy: { createdAt: 'asc' },
    })
    return reply.send({ success: true, data: rows.map((r) => ({
      id: r.id, slug: r.slug, name: r.name, family: r.family, networkLabel: r.networkLabel,
      nativeSymbol: r.nativeSymbol, minConfirmations: r.minConfirmations, explorerBase: r.explorerBase,
      rpcEnvVar: r.rpcEnvVar, isActive: r.isActive, activeTokens: r._count.tokens,
    })) })
  })

  // POST /admin/deposit-chains — create a new chain
  app.post('/admin/deposit-chains', { preHandler: [authenticate, requireRole('super_admin')] }, async (req, reply) => {
    const schema = z.object({
      slug:             z.string().min(1).max(50).regex(/^[a-z0-9-]+$/),
      chainId:          z.number().int().positive().optional(),
      name:             z.string().min(1).max(100),
      family:           z.enum(['EVM', 'TRON', 'SOL', 'TON', 'SUI', 'BTC', 'APT']),
      nativeSymbol:     z.string().min(1).max(20),
      networkLabel:     z.string().min(1).max(50),
      minConfirmations: z.number().int().positive(),
      explorerBase:     z.string().url(),
      rpcEnvVar:        z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'rpcEnvVar must be an environment variable NAME like APT_RPC_URL — not a URL').optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    const d = parsed.data
    const existing = await db.depositChain.findFirst({ where: { OR: [{ slug: d.slug }, { networkLabel: d.networkLabel }] } })
    if (existing) throw new AppError('DUPLICATE_CHAIN', 'A chain with that slug or networkLabel already exists', 409)
    const row = await db.depositChain.create({ data: { ...d, chainId: d.chainId ?? null, rpcEnvVar: d.rpcEnvVar ?? null } })
    await invalidateCache()
    log.info({ adminId: req.user!.id, chainSlug: row.slug }, 'Admin created deposit chain')
    return reply.code(201).send({ success: true, data: row })
  })

  // PATCH /admin/deposit-chains/:slug — update chain settings
  app.patch('/admin/deposit-chains/:slug', { preHandler: [authenticate, requireRole('admin', 'super_admin')] }, async (req, reply) => {
    const { slug } = req.params as { slug: string }
    const schema = z.object({
      name:             z.string().min(1).max(100).optional(),
      minConfirmations: z.number().int().positive().optional(),
      explorerBase:     z.string().url().optional(),
      rpcEnvVar:        z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'rpcEnvVar must be an environment variable NAME like APT_RPC_URL — not a URL').optional(),
      isActive:         z.boolean().optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    const chain = await db.depositChain.findUnique({ where: { slug } })
    if (!chain) throw new AppError('NOT_FOUND', `Chain ${slug} not found`, 404)
    const d = parsed.data
    const updateData: Parameters<typeof db.depositChain.update>[0]['data'] = {}
    if (d.name             !== undefined) updateData.name             = d.name
    if (d.minConfirmations !== undefined) updateData.minConfirmations = d.minConfirmations
    if (d.explorerBase     !== undefined) updateData.explorerBase     = d.explorerBase
    if (d.rpcEnvVar        !== undefined) updateData.rpcEnvVar        = d.rpcEnvVar
    if (d.isActive         !== undefined) updateData.isActive         = d.isActive
    const updated = await db.depositChain.update({ where: { slug }, data: updateData })
    await invalidateCache()
    log.info({ adminId: req.user!.id, chainSlug: slug, changes: d }, 'Admin updated deposit chain')
    return reply.send({ success: true, data: updated })
  })

  // POST /admin/deposit-chains/:slug/tokens — add a token (requires on-chain verification)
  app.post('/admin/deposit-chains/:slug/tokens', { preHandler: [authenticate, requireRole('admin', 'super_admin')] }, async (req, reply) => {
    const { slug } = req.params as { slug: string }
    const schema = z.object({
      symbol:              z.string().min(1).max(20),
      // Address format is validated per chain family below (EVM vs non-EVM).
      address:             z.string().min(1).max(100).nullable().optional(),
      decimals:            z.number().int().min(0).max(36),
      coingeckoId:         z.string().optional(),
      onChainVerified:     z.boolean().optional(),
      trustWalletVerified: z.boolean().optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    const chain = await db.depositChain.findUnique({ where: { slug } })
    if (!chain) throw new AppError('NOT_FOUND', `Chain ${slug} not found`, 404)
    const d = parsed.data
    // EVM chains must use a 0x+40hex contract address; non-EVM chains (Solana/TON/SUI)
    // use their own address formats, validated only for sane length/charset above.
    if (d.address && chain.family === 'EVM' && !/^0x[0-9a-fA-F]{40}$/.test(d.address)) {
      throw new AppError('VALIDATION_ERROR', 'Must be a valid EVM contract address (0x + 40 hex)', 400)
    }
    const token = await db.depositToken.create({
      data: {
        chainId:             chain.id,
        symbol:              d.symbol.toUpperCase(),
        address:             d.address ?? null,
        decimals:            d.decimals,
        coingeckoId:         d.coingeckoId ?? null,
        onChainVerified:     d.onChainVerified ?? false,
        trustWalletVerified: d.trustWalletVerified ?? false,
        verifiedAt:          (d.onChainVerified || d.trustWalletVerified) ? new Date() : null,
        isActive:            true,
      },
    })
    await invalidateCache()
    log.info({ adminId: req.user!.id, chainSlug: slug, symbol: token.symbol }, 'Admin added deposit token')
    return reply.code(201).send({ success: true, data: token })
  })

  // GET /admin/deposit-chains/:slug/tokens — list tokens for a chain
  app.get('/admin/deposit-chains/:slug/tokens', { preHandler: [authenticate, requireRole('admin', 'super_admin')] }, async (req, reply) => {
    const { slug } = req.params as { slug: string }
    const chain = await db.depositChain.findUnique({ where: { slug } })
    if (!chain) throw new AppError('NOT_FOUND', `Chain ${slug} not found`, 404)
    const tokens = await db.depositToken.findMany({
      where: { chainId: chain.id },
      orderBy: { symbol: 'asc' },
    })
    return reply.send({ success: true, data: { tokens } })
  })

  // PATCH /admin/deposit-chains/:slug/tokens/:id — update token (fix decimals, toggle active)
  app.patch('/admin/deposit-chains/:slug/tokens/:id', { preHandler: [authenticate, requireRole('admin', 'super_admin')] }, async (req, reply) => {
    const { slug, id } = req.params as { slug: string; id: string }
    const schema = z.object({
      address:             z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
      decimals:            z.number().int().min(0).max(36).optional(),
      isActive:            z.boolean().optional(),
      coingeckoId:         z.string().optional(),
      onChainVerified:     z.boolean().optional(),
      trustWalletVerified: z.boolean().optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)
    const chain = await db.depositChain.findUnique({ where: { slug } })
    if (!chain) throw new AppError('NOT_FOUND', `Chain ${slug} not found`, 404)
    const token = await db.depositToken.findFirst({ where: { id, chainId: chain.id } })
    if (!token) throw new AppError('NOT_FOUND', 'Token not found on this chain', 404)
    const now = new Date()
    const verifiedAt = ((parsed.data.onChainVerified ?? false) || (parsed.data.trustWalletVerified ?? false)) ? now : token.verifiedAt
    const d2 = parsed.data
    const tokenUpdateData: Parameters<typeof db.depositToken.update>[0]['data'] = { verifiedAt }
    if (d2.address             !== undefined) tokenUpdateData.address             = d2.address
    if (d2.decimals            !== undefined) tokenUpdateData.decimals            = d2.decimals
    if (d2.isActive            !== undefined) tokenUpdateData.isActive            = d2.isActive
    if (d2.coingeckoId         !== undefined) tokenUpdateData.coingeckoId         = d2.coingeckoId
    if (d2.onChainVerified     !== undefined) tokenUpdateData.onChainVerified     = d2.onChainVerified
    if (d2.trustWalletVerified !== undefined) tokenUpdateData.trustWalletVerified = d2.trustWalletVerified
    const updated = await db.depositToken.update({ where: { id }, data: tokenUpdateData })
    await invalidateCache()
    log.info({ adminId: req.user!.id, tokenId: id, changes: parsed.data }, 'Admin updated deposit token')
    return reply.send({ success: true, data: updated })
  })

  // GET /admin/deposit-chains/chain-search?query=zeta — search chainid.network for EVM chains
  app.get('/admin/deposit-chains/chain-search', { preHandler: [authenticate, requireRole('admin', 'super_admin')] }, async (req, reply) => {
    const { query } = req.query as { query?: string }
    if (!query || query.trim().length < 2) throw new AppError('VALIDATION_ERROR', 'query must be at least 2 characters', 400)

    type ChainEntry = {
      chainId: number
      name: string
      shortName: string
      nativeCurrency: { symbol: string; decimals: number }
      explorers?: Array<{ url: string; standard?: string }>
      rpc: string[]
    }
    const res = await fetch('https://chainid.network/chains.json', { signal: AbortSignal.timeout(8000) })
    if (!res.ok) throw new AppError('UPSTREAM_ERROR', 'Failed to fetch chain list from chainid.network', 502)
    const all = await res.json() as ChainEntry[]

    const q = query.trim().toLowerCase()
    const matches = all
      .filter(c => c.name.toLowerCase().includes(q) || c.shortName.toLowerCase().includes(q))
      .slice(0, 10)
      .map(c => {
        const explorerUrl = c.explorers?.find(e => e.standard === 'EIP3091')?.url ?? c.explorers?.[0]?.url ?? null
        const publicRpc = c.rpc.find(r => !r.includes('${') && r.startsWith('https')) ?? null
        const slugBase = c.shortName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
        return {
          chainId:         c.chainId,
          name:            c.name,
          slug:            slugBase,
          nativeSymbol:    c.nativeCurrency.symbol,
          networkLabel:    c.nativeCurrency.symbol.toUpperCase(),
          explorerBase:    explorerUrl ? explorerUrl.replace(/\/$/, '') : null,
          publicRpc,
        }
      })

    return reply.send({ success: true, data: { chains: matches } })
  })

  // GET /admin/deposit-chains/lookup?symbol=USDT&chainSlug=ethereum
  // 3-layer verification: CoinGecko → on-chain RPC → TrustWallet
  app.get('/admin/deposit-chains/lookup', { preHandler: [authenticate, requireRole('admin', 'super_admin')] }, async (req, reply) => {
    const { symbol, chainSlug } = req.query as { symbol?: string; chainSlug?: string }
    if (!symbol || !chainSlug) throw new AppError('VALIDATION_ERROR', 'symbol and chainSlug query params are required', 400)

    const chain = await getAllChains().then((cs) => cs.find((c) => c.id === chainSlug.toLowerCase()))
    if (!chain) throw new AppError('NOT_FOUND', `Chain ${chainSlug} not found in registry`, 404)

    const result: {
      symbol: string; chainSlug: string; chainName: string
      address: string | null; decimals: number | null
      name: string | null; logoUrl: string | null; checkedAt: string
      coingeckoVerified: boolean; coingeckoError: string | null
      onChainSupported: boolean
      onChainVerified: boolean; onChainSymbol: string | null; onChainDecimals: number | null; onChainError: string | null
      trustWalletVerified: boolean; trustWalletError: string | null
      geckoTerminalVerified: boolean; geckoTerminalError: string | null
    } = {
      symbol: symbol.toUpperCase(), chainSlug, chainName: chain.name,
      address: null, decimals: null,
      name: null, logoUrl: null, checkedAt: new Date().toISOString(),
      coingeckoVerified: false, coingeckoError: null,
      onChainSupported: chain.family === 'EVM',
      onChainVerified: false, onChainSymbol: null, onChainDecimals: null, onChainError: null,
      trustWalletVerified: false, trustWalletError: null,
      geckoTerminalVerified: false, geckoTerminalError: null,
    }

    // Slug aliases: a chain may be registered under either name (e.g. 'avax' or
    // 'avalanche'). Resolve both to the same canonical key so the verification
    // maps below never miss purely due to which slug the admin typed.
    const SLUG_ALIASES: Record<string, string> = { avax: 'avalanche', 'the-open-network': 'ton' }
    const canonicalSlug = SLUG_ALIASES[chainSlug.toLowerCase()] ?? chainSlug.toLowerCase()

    // Layer 1: CoinGecko — supports EVM and non-EVM platforms (Solana/TON/SUI/Aptos/Tron).
    const COINGECKO_PLATFORM: Record<string, string> = {
      ethereum: 'ethereum', bsc: 'binance-smart-chain', polygon: 'polygon-pos',
      arbitrum: 'arbitrum-one', optimism: 'optimistic-ethereum', base: 'base', avalanche: 'avalanche',
      tron: 'tron', solana: 'solana', ton: 'the-open-network', sui: 'sui', aptos: 'aptos',
    }
    const cgPlatform = COINGECKO_PLATFORM[canonicalSlug]
    if (cgPlatform) {
      try {
        const cgBase = 'https://api.coingecko.com/api/v3'
        const headers: Record<string, string> = env.COINGECKO_API_KEY
          ? { 'x-cg-demo-api-key': env.COINGECKO_API_KEY }
          : {}

        // Resolve symbol → CoinGecko ID candidates via search API. We keep ALL
        // exact-symbol matches (best market-cap rank first) instead of only the
        // top one: the highest-ranked "USDT" coin may not list THIS platform in
        // its detail_platforms even though a sibling entry does, which produced
        // the spurious "not found on platform" errors.
        const searchRes = await fetch(`${cgBase}/search?query=${encodeURIComponent(symbol)}`, { headers })
        let candidates: string[] = []
        if (searchRes.ok) {
          const searchData = await searchRes.json() as { coins: Array<{ id: string; symbol: string; market_cap_rank: number | null }> }
          candidates = searchData.coins
            .filter(c => c.symbol.toUpperCase() === symbol.toUpperCase())
            .sort((a, b) => (a.market_cap_rank ?? 1e9) - (b.market_cap_rank ?? 1e9))
            .map(c => c.id)
            .slice(0, 5) // cap requests
        }

        if (candidates.length === 0) {
          result.coingeckoError = `No CoinGecko ID mapping for symbol ${symbol}`
        } else {
          let platformHit = false
          for (const cgId of candidates) {
            const res = await fetch(`${cgBase}/coins/${cgId}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`, { headers })
            if (!res.ok) { result.coingeckoError = `CoinGecko returned HTTP ${res.status}`; continue }
            const data = await res.json() as {
              name?: string
              image?: { large?: string; small?: string; thumb?: string }
              detail_platforms?: Record<string, { contract_address: string; decimal_place: number } | null>
            }
            // Keep the first candidate's name/logo as a sensible default
            if (!result.name)   result.name   = data.name ?? null
            if (!result.logoUrl) result.logoUrl = data.image?.large ?? data.image?.small ?? data.image?.thumb ?? null
            const platformData = data.detail_platforms?.[cgPlatform]
            if (platformData?.contract_address) {
              result.name = data.name ?? result.name
              result.logoUrl = data.image?.large ?? data.image?.small ?? data.image?.thumb ?? result.logoUrl
              result.address = platformData.contract_address
              result.decimals = platformData.decimal_place
              result.coingeckoVerified = true
              platformHit = true
              break
            }
          }
          if (!platformHit && !result.coingeckoError) {
            result.coingeckoError = `Token ${symbol} not listed on ${cgPlatform} by CoinGecko (trying GeckoTerminal)`
          }
        }
      } catch (err) {
        result.coingeckoError = err instanceof Error ? err.message : 'CoinGecko fetch failed'
      }
    } else {
      result.coingeckoError = `No CoinGecko platform mapping for chain ${chainSlug}`
    }

    // Layer 1b: GeckoTerminal fallback — indexes on-chain DEX tokens, so its
    // coverage is far wider than CoinGecko's core listing (newer/long-tail
    // tokens). Used to RESOLVE an address+decimals when CoinGecko had no entry
    // for this platform. Free, no API key. Best-effort: failures are non-fatal.
    const GT_NETWORK: Record<string, string> = {
      ethereum: 'eth', bsc: 'bsc', polygon: 'polygon_pos', arbitrum: 'arbitrum',
      optimism: 'optimism', base: 'base', avalanche: 'avax', tron: 'tron',
      solana: 'solana', ton: 'ton', sui: 'sui', aptos: 'aptos',
    }
    const gtNetwork = GT_NETWORK[canonicalSlug]
    if (!result.address && gtNetwork) {
      try {
        const gtBase = 'https://api.geckoterminal.com/api/v2'
        // include=base_token,quote_token populates `included` with full token
        // objects (symbol/address) for BOTH sides of every pool — without it the
        // searched symbol may only appear as the quote side and we'd resolve the
        // wrong token. We then match the symbol across all included tokens.
        const sRes = await fetch(`${gtBase}/search/pools?query=${encodeURIComponent(symbol)}&network=${gtNetwork}&include=base_token,quote_token`, {
          headers: { accept: 'application/json' }, signal: AbortSignal.timeout(7000),
        })
        if (sRes.ok) {
          const sData = await sRes.json() as {
            data?: Array<{ relationships?: { base_token?: { data?: { id?: string } } } }>
            included?: Array<{ id?: string; type?: string; attributes?: { symbol?: string; name?: string; address?: string } }>
          }
          const included = sData.included ?? []
          let chosenAddr: string | null = null
          // 1) Exact symbol match across all included tokens (base or quote).
          const match = included.find(i => i.attributes?.symbol?.toUpperCase() === symbol.toUpperCase() && i.attributes?.address)
          if (match?.attributes?.address) {
            chosenAddr = match.attributes.address
          } else {
            // 2) Fallback: first pool's base token (id format "network_address").
            const firstBase = (sData.data ?? []).map(p => p.relationships?.base_token?.data?.id).find((id): id is string => !!id)
            if (firstBase) chosenAddr = firstBase.includes('_') ? firstBase.slice(firstBase.indexOf('_') + 1) : null
          }
          if (chosenAddr) {
            // Confirm via the token endpoint to pull decimals/name/logo authoritatively.
            const tRes = await fetch(`${gtBase}/networks/${gtNetwork}/tokens/${chosenAddr}`, {
              headers: { accept: 'application/json' }, signal: AbortSignal.timeout(7000),
            })
            if (tRes.ok) {
              const tData = await tRes.json() as { data?: { attributes?: { name?: string; symbol?: string; decimals?: number; image_url?: string; address?: string } } }
              const attr = tData.data?.attributes
              if (attr?.symbol?.toUpperCase() === symbol.toUpperCase() && attr.address) {
                result.address = attr.address
                if (attr.decimals != null) result.decimals = attr.decimals
                if (!result.name && attr.name) result.name = attr.name
                if (!result.logoUrl && attr.image_url && attr.image_url !== 'missing.png') result.logoUrl = attr.image_url
                result.geckoTerminalVerified = true
              } else {
                result.geckoTerminalError = `GeckoTerminal token symbol mismatch (got ${attr?.symbol ?? 'none'})`
              }
            }
          } else {
            result.geckoTerminalError = `No ${symbol} token found on GeckoTerminal ${gtNetwork}`
          }
        }
      } catch (err) {
        result.geckoTerminalError = err instanceof Error ? err.message : 'GeckoTerminal lookup failed'
      }
    } else if (!gtNetwork) {
      result.geckoTerminalError = `No GeckoTerminal network mapping for chain ${chainSlug}`
    }

    // Layer 2: On-chain RPC (EVM only)
    const address = result.address
    if (address && chain.family === 'EVM') {
      const rpcUrl = getRpcUrl(chain.id)
      if (rpcUrl) {
        try {
          // ERC20 ABI minimal selectors
          const symbolSelector = '0x95d89b41'
          const decimalsSelector = '0x313ce567'
          const call = async (data: string) => {
            const body = { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: address, data }, 'latest'] }
            const r = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
            const json = await r.json() as { result?: string; error?: { message: string } }
            if (json.error) throw new Error(json.error.message)
            return json.result ?? '0x'
          }
          const [symbolHex, decimalsHex] = await Promise.all([call(symbolSelector), call(decimalsSelector)])
          const decNum = Number(BigInt(decimalsHex || '0x0'))
          // Decode ABI-encoded string (offset 64 bytes + length 32 bytes + data)
          const decodeString = (hex: string) => {
            const clean = hex.startsWith('0x') ? hex.slice(2) : hex
            if (clean.length < 128) return null
            const len = parseInt(clean.slice(64, 128), 16)
            const strHex = clean.slice(128, 128 + len * 2)
            return Buffer.from(strHex, 'hex').toString('utf8').replace(/\0/g, '')
          }
          result.onChainSymbol = decodeString(symbolHex)
          result.onChainDecimals = decNum
          // If no upstream gave decimals, trust the on-chain value.
          if (result.decimals == null) result.decimals = decNum
          result.onChainVerified = (
            result.onChainSymbol?.toUpperCase() === symbol.toUpperCase() &&
            (result.decimals == null || result.onChainDecimals === result.decimals)
          )
          if (!result.onChainVerified) {
            result.onChainError = `On-chain: symbol=${result.onChainSymbol}, decimals=${result.onChainDecimals}; expected symbol=${symbol}, decimals=${result.decimals}`
          }
        } catch (err) {
          result.onChainError = err instanceof Error ? err.message : 'RPC call failed'
        }
      } else {
        result.onChainError = `No RPC URL configured for chain ${chain.id}`
      }
    } else if (address && chain.family !== 'EVM') {
      result.onChainError = 'On-chain verification not available for non-EVM chains; using CoinGecko / GeckoTerminal / TrustWallet instead'
    }

    // Layer 3: TrustWallet assets — confirms listing AND fills name/decimals/logo
    // from info.json when upstream sources missed them.
    const TW_CHAIN: Record<string, string> = {
      ethereum: 'ethereum', bsc: 'smartchain', polygon: 'polygon',
      arbitrum: 'arbitrum', optimism: 'optimism', base: 'base', avalanche: 'avalanchec',
      tron: 'tron', solana: 'solana', ton: 'ton', sui: 'sui', aptos: 'aptos',
    }
    const twChain = TW_CHAIN[canonicalSlug]
    if (twChain && address) {
      try {
        const twUrl = `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${twChain}/assets/${address}/info.json`
        const twRes = await fetch(twUrl, { signal: AbortSignal.timeout(7000) })
        if (twRes.ok) {
          result.trustWalletVerified = true
          try {
            const info = await twRes.json() as { name?: string; symbol?: string; decimals?: number }
            if (!result.name && info.name) result.name = info.name
            if (result.decimals == null && info.decimals != null) result.decimals = info.decimals
          } catch { /* info.json unparseable — existence alone still counts */ }
        } else {
          result.trustWalletError = twRes.status === 404 ? 'Not in TrustWallet registry' : `TrustWallet returned HTTP ${twRes.status}`
        }
      } catch (err) {
        result.trustWalletError = err instanceof Error ? err.message : 'TrustWallet fetch failed'
      }
    } else if (!twChain) {
      result.trustWalletError = `No TrustWallet mapping for chain ${chainSlug}`
    }

    return reply.send({ success: true, data: result })
  })

  // GET /admin/deposit-chains/identify?query=<symbol|name|0x-address>
  // Classifies a project as a TOKEN (and on which chains) vs a NATIVE CHAIN coin,
  // so admins know whether to add it under an existing chain or create a new one.
  // Powered by CoinGecko's detail_platforms (all deployments) + asset_platforms
  // (which coins are native chain coins).
  app.get('/admin/deposit-chains/identify', { preHandler: [authenticate, requireRole('admin', 'super_admin')] }, async (req, reply) => {
    const { query } = req.query as { query?: string }
    if (!query || query.trim().length < 2) throw new AppError('VALIDATION_ERROR', 'query must be at least 2 characters', 400)
    const q = query.trim()

    const cgBase = 'https://api.coingecko.com/api/v3'
    const headers: Record<string, string> = env.COINGECKO_API_KEY ? { 'x-cg-demo-api-key': env.COINGECKO_API_KEY } : {}

    // CoinGecko platform id → our deposit-chain slug. Drives the "add under this
    // chain" action and tells us which deployments we can actually support.
    const CG_PLATFORM_TO_SLUG: Record<string, string> = {
      ethereum: 'ethereum', 'binance-smart-chain': 'bsc', 'polygon-pos': 'polygon',
      'arbitrum-one': 'arbitrum', 'optimistic-ethereum': 'optimism', base: 'base',
      avalanche: 'avalanche', tron: 'tron', solana: 'solana',
      'the-open-network': 'ton', sui: 'sui', aptos: 'aptos',
    }

    type CoinDetail = {
      id?: string
      name?: string
      symbol?: string
      image?: { large?: string; small?: string; thumb?: string }
      asset_platform_id?: string | null
      detail_platforms?: Record<string, { contract_address: string; decimal_place: number | null } | null>
    }

    // ── Resolve the query → a CoinGecko coin detail object ─────────────────────
    let coin: CoinDetail | null = null
    let resolveError: string | null = null
    try {
      if (/^0x[0-9a-fA-F]{40}$/.test(q)) {
        // Address input — most are Ethereum; ask CoinGecko by contract there.
        const r = await fetch(`${cgBase}/coins/ethereum/contract/${q.toLowerCase()}`, { headers, signal: AbortSignal.timeout(8000) })
        if (r.ok) coin = await r.json() as CoinDetail
        else resolveError = 'Address not found on Ethereum via CoinGecko. Enter the symbol/name instead, or treat it as a brand-new token and add it with the manual override.'
      } else {
        const sRes = await fetch(`${cgBase}/search?query=${encodeURIComponent(q)}`, { headers, signal: AbortSignal.timeout(8000) })
        if (sRes.ok) {
          const sData = await sRes.json() as { coins: Array<{ id: string; symbol: string; name: string; market_cap_rank: number | null }> }
          const lc = q.toLowerCase()
          // Prefer exact symbol match, else exact name match, else first result; best market cap first.
          const ranked = [...sData.coins].sort((a, b) => (a.market_cap_rank ?? 1e9) - (b.market_cap_rank ?? 1e9))
          const pick = ranked.find(c => c.symbol.toLowerCase() === lc)
            ?? ranked.find(c => c.name.toLowerCase() === lc)
            ?? ranked[0]
          if (pick) {
            const r = await fetch(`${cgBase}/coins/${pick.id}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`, { headers, signal: AbortSignal.timeout(8000) })
            if (r.ok) coin = await r.json() as CoinDetail
          } else {
            resolveError = `No CoinGecko match for "${q}"`
          }
        }
      }
    } catch (err) {
      resolveError = err instanceof Error ? err.message : 'CoinGecko lookup failed'
    }

    if (!coin) {
      return reply.send({ success: true, data: { query: q, resolved: false, error: resolveError ?? 'Could not resolve this token/chain.' } })
    }

    // ── Determine native-chain coins via asset_platforms ───────────────────────
    const nativeCoinIds = new Set<string>()
    const platformName: Record<string, string> = {}
    try {
      const apRes = await fetch(`${cgBase}/asset_platforms`, { headers, signal: AbortSignal.timeout(8000) })
      if (apRes.ok) {
        const aps = await apRes.json() as Array<{ id: string; name: string; native_coin_id?: string | null }>
        for (const ap of aps) {
          platformName[ap.id] = ap.name
          if (ap.native_coin_id) nativeCoinIds.add(ap.native_coin_id)
        }
      }
    } catch { /* non-fatal — verdict still works off detail_platforms */ }

    // Which registry chains exist (so we can offer "add under this chain").
    // Alias-aware: a chain may be registered under a non-canonical slug (e.g.
    // 'avax' instead of 'avalanche'), so resolve to whatever slug actually
    // exists — otherwise the "Add under <chain>" deep-link would be hidden.
    const registrySlugs = new Set((await getAllChains()).map(c => c.id))
    const REGISTRY_SLUG_ALIASES: Record<string, string[]> = {
      avalanche: ['avalanche', 'avax'],
      ton:       ['ton', 'the-open-network'],
    }
    const resolveRegistrySlug = (canonical: string | null): string | null => {
      if (!canonical) return null
      const candidates = REGISTRY_SLUG_ALIASES[canonical] ?? [canonical]
      return candidates.find((s) => registrySlugs.has(s)) ?? null
    }

    // Build deployment list from detail_platforms (skip empty/native placeholder keys)
    const deployments = Object.entries(coin.detail_platforms ?? {})
      .filter(([pid, info]) => pid && info && info.contract_address)
      .map(([pid, info]) => {
        const registrySlug = resolveRegistrySlug(CG_PLATFORM_TO_SLUG[pid] ?? null)
        return {
          platformId:   pid,
          chainName:    platformName[pid] ?? pid,
          mappedSlug:   registrySlug,        // actual registry slug for the add link (null if unsupported)
          supported:    !!registrySlug,
          address:      info!.contract_address,
          decimals:     info!.decimal_place ?? null,
        }
      })

    const isNativeChainCoin = coin.id ? nativeCoinIds.has(coin.id) : false
    const kind = isNativeChainCoin ? 'native_chain' : deployments.length > 0 ? 'token' : 'unknown'

    let verdict: string
    let nativeChain: { platformId: string; name: string } | null = null
    if (kind === 'native_chain') {
      nativeChain = { platformId: coin.id ?? '', name: coin.name ?? coin.id ?? '' }
      verdict = `${coin.name} (${(coin.symbol ?? '').toUpperCase()}) is the NATIVE COIN of its own blockchain. Add it as a Blockchain (chain) — and only if you will operate deposits/delivery for that chain.`
    } else if (kind === 'token') {
      const chainList = deployments.map(d => d.chainName).join(', ')
      verdict = `${coin.name} (${(coin.symbol ?? '').toUpperCase()}) is a TOKEN deployed on: ${chainList}. Add it under one of these chains — do NOT create a separate chain for it.`
    } else {
      verdict = `${coin.name} (${(coin.symbol ?? '').toUpperCase()}) has no on-chain contract listed by CoinGecko. It may be a native chain coin or a brand-new token — verify manually.`
    }

    return reply.send({
      success: true,
      data: {
        query: q,
        resolved: true,
        kind,
        coinId: coin.id ?? null,
        name: coin.name ?? null,
        symbol: (coin.symbol ?? '').toUpperCase() || null,
        logoUrl: coin.image?.large ?? coin.image?.small ?? coin.image?.thumb ?? null,
        nativeChain,
        deployments,
        verdict,
      },
    })
  })

  // GET /admin/deposit-chains/rpc-health?family=SOL|TON|SUI|TRON|APT|EVM
  // Suggests recommended public RPC endpoints for a chain family and reports the
  // live health (reachable + latency) of the currently-configured endpoint, so
  // admins adding non-EVM chains aren't left guessing what to put in *_RPC_URL.
  app.get('/admin/deposit-chains/rpc-health', { preHandler: [authenticate, requireRole('admin', 'super_admin')] }, async (req, reply) => {
    const family = String((req.query as { family?: string }).family ?? '').toUpperCase()

    const RECOMMENDED: Record<string, Array<{ url: string; label: string }>> = {
      SOL:  [{ url: 'https://api.mainnet-beta.solana.com', label: 'Solana Foundation (public, rate-limited)' }],
      TON:  [{ url: 'https://toncenter.com/api/v2/jsonRPC', label: 'TON Center (public — API key raises limits)' }],
      SUI:  [{ url: 'https://fullnode.mainnet.sui.io', label: 'Mysten Labs (public)' }],
      TRON: [{ url: 'https://api.trongrid.io', label: 'TronGrid (public — API key raises limits)' }],
      APT:  [{ url: 'https://fullnode.mainnet.aptoslabs.com/v1', label: 'Aptos Labs (public)' }],
    }

    const ENV_VAR: Record<string, string> = {
      SOL: 'SOL_RPC_URL', TON: 'TON_ENDPOINT_URL', SUI: 'SUI_RPC_URL',
      TRON: 'TRON_FULLNODE_URL', APT: 'APT_RPC_URL',
    }

    // Live health of the configured endpoint (non-EVM families have helpers).
    let health: { reachable: boolean; latencyMs: number; error?: string | undefined } | null = null
    try {
      if (family === 'SOL') {
        const { checkSolanaRpc } = await import('../lib/gas/solanaWalletService')
        const r = await checkSolanaRpc(); health = { reachable: r.reachable, latencyMs: r.latencyMs, error: r.error }
      } else if (family === 'TON') {
        const { checkTonRpc } = await import('../lib/gas/tonWalletService')
        const r = await checkTonRpc(); health = { reachable: r.reachable, latencyMs: r.latencyMs, error: r.error }
      } else if (family === 'SUI') {
        const { checkSuiRpc } = await import('../lib/gas/suiWalletService')
        const r = await checkSuiRpc(); health = { reachable: r.reachable, latencyMs: r.latencyMs, error: r.error }
      }
    } catch (err) {
      health = { reachable: false, latencyMs: 0, error: err instanceof Error ? err.message : 'health check failed' }
    }

    return reply.send({
      success: true,
      data: {
        family,
        envVar: ENV_VAR[family] ?? null,
        recommended: RECOMMENDED[family] ?? [],
        configuredHealth: health, // null for EVM/unknown families
      },
    })
  })

  // ── Admin: Trade Ratings ────────────────────────────────────────────────────

  app.get('/admin/ratings', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const query = req.query as Record<string, string>
    const page = Math.max(1, parseInt(query.page ?? '1'))
    const limit = Math.min(50, parseInt(query.limit ?? '50'))
    const skip = (page - 1) * limit

    const where: Prisma.TradeRatingWhereInput = {}
    if (query.status === 'visible') where.hidden = false
    else if (query.status === 'hidden') where.hidden = true

    const search = query.search?.trim()
    if (search) {
      // Resolve users matching the term so we can match reviewer/reviewed.
      const matchingUsers = await db.user.findMany({
        where: { OR: [{ username: { contains: search, mode: 'insensitive' } }, { email: { contains: search, mode: 'insensitive' } }] },
        select: { id: true }, take: 200,
      })
      const userIds = matchingUsers.map((u) => u.id)
      where.OR = [
        { trade: { orderRef: { contains: search, mode: 'insensitive' } } },
        { tradeId: search },
        { ratedByUserId: { in: userIds } },
        { ratedUserId: { in: userIds } },
      ]
    }

    const [ratings, total] = await Promise.all([
      db.tradeRating.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          trade: { select: { id: true, orderRef: true } },
        },
      }),
      db.tradeRating.count({ where }),
    ])

    // Resolve reviewer and reviewed user names
    const userIds = [...new Set(ratings.flatMap((r) => [r.ratedByUserId, r.ratedUserId]))]
    const users = await db.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, username: true, email: true },
    })
    const userMap = Object.fromEntries(users.map((u) => [u.id, u]))

    const enriched = ratings.map((r) => ({
      ...r,
      reviewer: userMap[r.ratedByUserId] ?? null,
      reviewedUser: userMap[r.ratedUserId] ?? null,
    }))

    return reply.send({
      success: true,
      data: { ratings: enriched, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
    })
  })

  app.post('/admin/ratings/:id/hide', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const rating = await db.tradeRating.findUnique({ where: { id } })
    if (!rating) throw Errors.NOT_FOUND('Rating')
    await db.tradeRating.update({ where: { id }, data: { hidden: true } })
    await createAuditLog(req.user!.id, 'RATING_HIDDEN', 'TradeRating', id, {}, clientIp(req), req.headers['user-agent'] as string | undefined)
    return reply.send({ success: true })
  })

  app.post('/admin/ratings/:id/unhide', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const rating = await db.tradeRating.findUnique({ where: { id } })
    if (!rating) throw Errors.NOT_FOUND('Rating')
    await db.tradeRating.update({ where: { id }, data: { hidden: false } })
    await createAuditLog(req.user!.id, 'RATING_UNHIDDEN', 'TradeRating', id, {}, clientIp(req), req.headers['user-agent'] as string | undefined)
    return reply.send({ success: true })
  })

  // ── Platform Revenue ───────────────────────────────────────────────────────
  // Authoritative source: GasLedgerEntry WHERE entryType IN ('platform_fee', 'platform_fee_sweep')
  //
  //   platform_fee        — fee collected from each withdrawal (stays in hot wallet)
  //   platform_fee_sweep  — batch sweep of accumulated fees to treasury wallet
  //
  // Available-to-sweep formula (per token+chain):
  //   SUM(platform_fee.tokenAmount) − SUM(platform_fee_sweep.tokenAmount)

  // GET /admin/platform-revenue/summary
  app.get('/admin/platform-revenue/summary', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const { getEvmTreasuryAddress, getTronTreasuryAddress } = await import('../lib/gas/gasWalletService')

    const now        = new Date()
    const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0)
    const weekStart  = new Date(now); weekStart.setDate(now.getDate() - now.getDay()); weekStart.setHours(0, 0, 0, 0)
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

    const FEE_WHERE   = { entryType: 'platform_fee'       as const }
    const SWEEP_WHERE = { entryType: 'platform_fee_sweep' as const }

    const thirtyDaysAgo = new Date(now)
    thirtyDaysAgo.setDate(now.getDate() - 29)
    thirtyDaysAgo.setHours(0, 0, 0, 0)

    const [
      allTimeAgg, todayAgg, weekAgg, monthAgg,
      allTimeCount, todayCount,
      // Collected fees grouped by token×chain — for sweepable breakdown
      collectedByTokenChainRaw,
      // Already swept grouped by token×chain — to compute available
      sweptByTokenChainRaw,
      // Simple group-by views
      byTokenRaw, byChainRaw,
      // Daily chart data
      dailyEntries,
      // Total swept (all time)
      sweptAllTime,
    ] = await Promise.all([
      db.gasLedgerEntry.aggregate({ where: FEE_WHERE, _sum: { tokenAmount: true, usdAmount: true }, _count: { id: true } }),
      db.gasLedgerEntry.aggregate({ where: { ...FEE_WHERE, createdAt: { gte: todayStart } }, _sum: { tokenAmount: true, usdAmount: true } }),
      db.gasLedgerEntry.aggregate({ where: { ...FEE_WHERE, createdAt: { gte: weekStart  } }, _sum: { tokenAmount: true, usdAmount: true } }),
      db.gasLedgerEntry.aggregate({ where: { ...FEE_WHERE, createdAt: { gte: monthStart } }, _sum: { tokenAmount: true, usdAmount: true } }),
      db.gasLedgerEntry.count({ where: FEE_WHERE }),
      db.gasLedgerEntry.count({ where: { ...FEE_WHERE, createdAt: { gte: todayStart } } }),
      // Collected per token+chain
      db.gasLedgerEntry.groupBy({
        by: ['tokenSymbol', 'chain'],
        where: FEE_WHERE,
        _sum: { tokenAmount: true, usdAmount: true },
        _count: { id: true },
      }),
      // Swept per token+chain
      db.gasLedgerEntry.groupBy({
        by: ['tokenSymbol', 'chain'],
        where: SWEEP_WHERE,
        _sum: { tokenAmount: true },
      }),
      // For display tables
      db.gasLedgerEntry.groupBy({
        by: ['tokenSymbol'],
        where: FEE_WHERE,
        _sum: { tokenAmount: true, usdAmount: true },
        _count: { id: true },
        orderBy: { _sum: { tokenAmount: 'desc' } },
      }),
      db.gasLedgerEntry.groupBy({
        by: ['chain'],
        where: FEE_WHERE,
        _sum: { tokenAmount: true, usdAmount: true },
        _count: { id: true },
        orderBy: { _sum: { tokenAmount: 'desc' } },
      }),
      db.gasLedgerEntry.findMany({
        where: { ...FEE_WHERE, createdAt: { gte: thirtyDaysAgo } },
        select: { createdAt: true, tokenAmount: true, usdAmount: true },
        orderBy: { createdAt: 'asc' },
      }),
      db.gasLedgerEntry.aggregate({ where: SWEEP_WHERE, _sum: { tokenAmount: true, usdAmount: true } }),
    ])

    // Build swept map: `${tokenSymbol}:${chain}` → swept amount
    const sweptMap = new Map<string, number>()
    for (const r of sweptByTokenChainRaw) {
      if (r.tokenSymbol) {
        sweptMap.set(`${r.tokenSymbol}:${r.chain}`, Number(r._sum?.tokenAmount ?? 0))
      }
    }

    // Build sweepable array: one row per token+chain with collected/swept/available
    const EVM_SWEEP_CHAINS = new Set(['BSC', 'ETH', 'BASE', 'ARB', 'OP', 'MATIC'])
    const sweepable = collectedByTokenChainRaw
      .filter(r => r.tokenSymbol)
      .map(r => {
        const collected = Number(r._sum?.tokenAmount ?? 0)
        const swept     = sweptMap.get(`${r.tokenSymbol}:${r.chain}`) ?? 0
        const available = Math.max(0, collected - swept)
        return {
          token:     r.tokenSymbol!,
          chain:     r.chain as string,
          collected,
          swept,
          available,
          count:     r._count.id,
          canSweep:  EVM_SWEEP_CHAINS.has(r.chain as string) && available > 0,
        }
      })
      .sort((a, b) => b.available - a.available)

    // Daily chart
    const dailyMap = new Map<string, { tokenAmount: number; usdAmount: number; count: number }>()
    for (const e of dailyEntries) {
      const day = e.createdAt.toISOString().slice(0, 10)
      const s   = dailyMap.get(day) ?? { tokenAmount: 0, usdAmount: 0, count: 0 }
      s.tokenAmount += Number(e.tokenAmount ?? 0)
      s.usdAmount   += Number(e.usdAmount   ?? 0)
      s.count       += 1
      dailyMap.set(day, s)
    }

    return reply.send({
      success: true,
      data: {
        allTime: {
          totalTokenFees: Number(allTimeAgg._sum?.tokenAmount ?? 0),
          totalUsdFees:   Number(allTimeAgg._sum?.usdAmount   ?? 0),
          totalSwept:     Number(sweptAllTime._sum?.tokenAmount ?? 0),
          available:      Math.max(0, Number(allTimeAgg._sum?.tokenAmount ?? 0) - Number(sweptAllTime._sum?.tokenAmount ?? 0)),
          count:          allTimeCount,
        },
        today: {
          totalTokenFees: Number(todayAgg._sum.tokenAmount ?? 0),
          totalUsdFees:   Number(todayAgg._sum.usdAmount   ?? 0),
          count:          todayCount,
        },
        thisWeek:  { totalTokenFees: Number(weekAgg._sum.tokenAmount  ?? 0), totalUsdFees: Number(weekAgg._sum.usdAmount  ?? 0) },
        thisMonth: { totalTokenFees: Number(monthAgg._sum.tokenAmount ?? 0), totalUsdFees: Number(monthAgg._sum.usdAmount ?? 0) },
        sweepable,
        byToken: byTokenRaw.map(r => ({
          token: r.tokenSymbol ?? 'UNKNOWN',
          amount: Number(r._sum.tokenAmount ?? 0), usdAmount: Number(r._sum.usdAmount ?? 0), count: r._count.id,
        })),
        byChain: byChainRaw.map(r => ({
          chain: r.chain, amount: Number(r._sum.tokenAmount ?? 0), usdAmount: Number(r._sum.usdAmount ?? 0), count: r._count.id,
        })),
        dailyChart: Array.from(dailyMap.entries()).map(([date, v]) => ({ date, ...v })),
        // Treasury wallet addresses (public — safe to expose to admin)
        treasuryAddresses: {
          evm:  getEvmTreasuryAddress()  ?? null,
          tron: getTronTreasuryAddress() ?? null,
        },
      },
    })
  })

  // GET /admin/platform-revenue/withdraw-config — destinations + safe-withdrawable
  // balances per token×chain (the real platform-owned funds that can be paid out).
  app.get('/admin/platform-revenue/withdraw-config', { preHandler: [authenticate, adminOrSuper] }, async (_req, reply) => {
    const { getAllWithdrawDestinations, getWithdrawable, chainFamily } = await import('../lib/gas/gas.revenue')

    // Candidate (token, chain) pairs: anything that has ever produced revenue.
    const pairs = await db.gasLedgerEntry.groupBy({
      by: ['tokenSymbol', 'chain'],
      where: { entryType: { in: ['order_payment', 'platform_fee'] }, tokenSymbol: { not: null } },
    })

    const [destinations, withdrawable] = await Promise.all([
      getAllWithdrawDestinations(),
      Promise.all(
        pairs
          .filter(p => p.tokenSymbol && chainFamily(p.chain as string))
          .map(p => getWithdrawable(p.chain as string, p.tokenSymbol as string)),
      ),
    ])

    return reply.send({
      success: true,
      data: { destinations, withdrawable: withdrawable.sort((a, b) => b.available - a.available) },
    })
  })

  // PUT /admin/platform-revenue/withdraw-destination — set external payout address
  app.put('/admin/platform-revenue/withdraw-destination', { preHandler: superStepUp }, async (req, reply) => {
    const { setWithdrawDestination, validateDestination } = await import('../lib/gas/gas.revenue')
    const schema = z.object({
      family:  z.enum(['evm', 'tron', 'aptos']),
      address: z.string().trim().min(1),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.errors[0]?.message ?? 'Invalid input', 400)

    const { family, address } = parsed.data
    if (!validateDestination(family, address)) {
      return reply.status(400).send({ success: false, error: `Invalid ${family.toUpperCase()} address format.` })
    }

    const row = await setWithdrawDestination(family, address)
    await createAuditLog(req.user!.id, 'GAS_WITHDRAW_DESTINATION_SET', 'PlatformConfig', row.id, { family, address }, clientIp(req), req.headers['user-agent'] as string | undefined)
    return reply.send({ success: true, data: { family, address } })
  })

  // POST /admin/platform-revenue/withdraw — super_admin only. Sends platform-owned
  // funds from the hot wallet to the operator's EXTERNAL wallet. Hard-capped at the
  // conservative safe-withdrawable headroom (never touches user-custodied funds).
  // Kept under /sweep too for backward-compatible API clients.
  const withdrawHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const { getWithdrawable, getWithdrawDestination, chainFamily } = await import('../lib/gas/gas.revenue')
    const { withdrawHotWalletToken } = await import('../lib/treasury.sweep')

    const body = req.body as { tokenSymbol?: string; chain?: string; amount?: number }
    if (!body.tokenSymbol || !body.chain) {
      return reply.status(400).send({ success: false, error: 'tokenSymbol and chain are required' })
    }
    const tokenSymbol = body.tokenSymbol.toUpperCase()
    const chain       = body.chain.toUpperCase()

    const family = chainFamily(chain)
    if (!family) return reply.status(400).send({ success: false, error: `Withdrawal not supported for chain ${chain}.` })
    if (family === 'tron') return reply.status(400).send({ success: false, error: 'TRON withdrawal is manual — sweep TRC20 from your wallet app.' })

    const destination = await getWithdrawDestination(family)
    if (!destination) {
      return reply.status(400).send({ success: false, error: `No ${family.toUpperCase()} withdrawal destination configured. Set it under Withdrawal Destination first.` })
    }

    // Safety gate: recompute the conservative platform-owned headroom right now.
    const w = await getWithdrawable(chain, tokenSymbol)
    if (!w.supported) return reply.status(400).send({ success: false, error: `Withdrawal not supported for ${tokenSymbol} on ${chain}.` })
    if (w.available <= 0) {
      return reply.status(400).send({
        success: false,
        error: `No platform-owned ${tokenSymbol} available to withdraw on ${chain}. On-chain ${w.onChain.toFixed(4)}, owed to users ${w.userLiability.toFixed(4)}, pending ${w.pendingOut.toFixed(4)}.`,
      })
    }

    const amount = body.amount != null ? Math.min(Number(body.amount), w.available) : w.available
    if (!(amount > 0)) return reply.status(400).send({ success: false, error: 'Withdrawal amount must be greater than zero.' })

    // Execute on-chain transfer — throws on failure / revert; nothing recorded if it throws.
    const result = await withdrawHotWalletToken(tokenSymbol, chain, amount, destination)

    const sourceKey = `platform_revenue_withdrawal:${result.txHash}`
    try {
      await appendLedgerEntry({
        entryType:    'platform_revenue_withdrawal',
        chain:        chain as import('../lib/gas/gas.chains').GasChainId,
        nativeAmount: 0,
        tokenSymbol,
        tokenAmount:  amount,
        usdAmount:    amount,
        txHash:       result.txHash,
        fromAddress:  result.hotWalletAddress,
        toAddress:    result.destination,
        sourceKey,
        notes: `Revenue withdrawal by admin ${req.user!.id} — ${amount} ${tokenSymbol} on ${chain} → ${result.destination}`,
      })
      await createAuditLog(req.user!.id, 'PLATFORM_REVENUE_WITHDRAWAL', 'GasLedgerEntry', result.txHash, { tokenSymbol, chain, amount, destination: result.destination, txHash: result.txHash })
    } catch (dbErr) {
      log.error({ dbErr, txHash: result.txHash, tokenSymbol, chain, amount }, 'platform-revenue/withdraw: DB write failed after successful on-chain withdrawal')
    }

    const { createAdminNotif: notifWithdraw } = await import('../services/adminNotification.service')
    void notifWithdraw({
      category: 'SYSTEM',
      title:    `Revenue Withdrawn: ${amount} ${tokenSymbol}`,
      body:     `Admin withdrew ${amount} ${tokenSymbol} (${chain}) from hot wallet to external wallet ${result.destination.slice(0, 10)}… TX: ${result.txHash.slice(0, 18)}…`,
      href:     '/admin/platform-revenue',
      metadata: { txHash: result.txHash, tokenSymbol, chain, amount: String(amount) },
    })

    return reply.send({
      success: true,
      data: {
        txHash:           result.txHash,
        destination:      result.destination,
        hotWalletAddress: result.hotWalletAddress,
        tokenSymbol, chain, amount,
        hotWalletBalanceBefore: result.hotWalletBalanceBefore,
        remainingAvailable: Math.max(0, w.available - amount),
      },
    })
  }

  app.post('/admin/platform-revenue/withdraw', { preHandler: superStepUp }, withdrawHandler)
  app.post('/admin/platform-revenue/sweep',    { preHandler: superStepUp }, withdrawHandler)

  // GET /admin/platform-revenue/history — paginated fee entries (platform_fee only)
  app.get('/admin/platform-revenue/history', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const query = req.query as Record<string, string>
    const { page, limit, skip } = paginationParams(query)

    const andClauses: Record<string, unknown>[] = [{ entryType: 'platform_fee' }]
    if (query.token)  andClauses.push({ tokenSymbol: { equals: query.token.toUpperCase() } })
    if (query.chain)  andClauses.push({ chain: query.chain.toUpperCase() })
    if (query.from)   andClauses.push({ createdAt: { gte: new Date(query.from) } })
    if (query.to)     andClauses.push({ createdAt: { lte: new Date(query.to) } })
    if (query.search) {
      andClauses.push({
        OR: [
          { txHash:   { contains: query.search, mode: 'insensitive' } },
          { notes:    { contains: query.search, mode: 'insensitive' } },
          { sourceKey:{ contains: query.search, mode: 'insensitive' } },
        ],
      })
    }

    const [entries, total] = await Promise.all([
      db.gasLedgerEntry.findMany({
        where: { AND: andClauses },
        orderBy: { createdAt: 'desc' },
        skip, take: limit,
        select: {
          id: true, chain: true,
          tokenSymbol: true, tokenAmount: true, usdAmount: true,
          txHash: true, sourceKey: true, notes: true, createdAt: true,
        },
      }),
      db.gasLedgerEntry.count({ where: { AND: andClauses } }),
    ])

    return reply.send({
      success: true,
      data: { entries, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
    })
  })

  // GET /admin/platform-revenue/sweep-history — paginated list of past sweeps
  app.get('/admin/platform-revenue/sweep-history', { preHandler: [authenticate, adminOrSuper] }, async (req, reply) => {
    const query = req.query as Record<string, string>
    const { page, limit, skip } = paginationParams(query)

    const HISTORY_WHERE = { entryType: { in: ['platform_fee_sweep', 'platform_revenue_withdrawal'] as import('@prisma/client').GasLedgerEntryType[] } }
    const [entries, total] = await Promise.all([
      db.gasLedgerEntry.findMany({
        where: HISTORY_WHERE,
        orderBy: { createdAt: 'desc' },
        skip, take: limit,
        select: {
          id: true, chain: true,
          tokenSymbol: true, tokenAmount: true, usdAmount: true,
          txHash: true, fromAddress: true, toAddress: true,
          notes: true, createdAt: true,
        },
      }),
      db.gasLedgerEntry.count({ where: HISTORY_WHERE }),
    ])

    return reply.send({
      success: true,
      data: { entries, pagination: { page, limit, total, pages: Math.ceil(total / limit) } },
    })
  })
}
