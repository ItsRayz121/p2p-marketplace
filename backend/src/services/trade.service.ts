import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { AppError } from '../lib/errors'
import { Prisma } from '@prisma/client'
import { assertCloudinaryUrl } from '../lib/upload'
type Tx = Prisma.TransactionClient
import { sendTradeEmail } from './email.service'
import { queues } from '../queues/definitions'
import { generateOrderRef } from '../lib/hash'
import { notify } from '../lib/notify'
import { createAdminNotif } from './adminNotification.service'
import { FLAGS, isFlagEnabled, getNumberConfig } from './platformFlags.service'
import { assertCanOpenTrade, isTradeLimitBypassed } from './tradeConcurrency.service'
import { assertNoKycTakerAllowed } from './nokycTaker.service'
import { isTakerFirstForMarket } from './settlementMode.service'
import { openEpisode, closeEpisode } from './chatThread.service'
import { stepForAction, flowSteps } from './settlementFlow'
import { getBondConfig, lockMakerBondTx, releaseMakerBond } from './makerBond.service'
import { recordAuditLog } from '../lib/audit'
import {
  verifyTradeTx,
  assertNoDuplicateTradeTxHash,
  HARD_REJECT_STATUSES,
  type TxVerificationResult,
} from './blockchainVerification.service'
import { logger } from '../lib/logger'
import { validateAddressForNetwork } from '../lib/addressValidation'
import { incrementTradeStreak, getTradeStreak, ordinal } from './tradeStreak.service'
import { awardTradePointsTx } from './airdrop.service'

// ─── Payment-method resolution ──────────────────────────────────────────────
// A trade stores `paymentMethod` as the buyer's selection. For current trades
// that is a PaymentMethod *id* (the buyer picks one of the seller's receiving
// accounts attached to the ad); legacy trades may hold a plain label. We resolve
// it to (a) a clean display label and (b) the seller's account details, so the
// buyer can see exactly where to send PKR instead of asking in chat.

// Cooldown before either party can open a dispute, measured from when the buyer
// uploads payment proof. Keep this in sync with the frontend trade page.
export const DISPUTE_DELAY_MINUTES = 10

// Window during which a participant may rate a completed trade. After this many
// minutes from completion (releasedAt), ratings are rejected. Keep in sync with
// RATING_WINDOW_MINUTES on the trade detail page.
export const RATING_WINDOW_MINUTES = 15

const PM_LABELS: Record<string, string> = {
  jazzcash: 'JazzCash', easypaisa: 'Easypaisa', sadapay: 'SadaPay',
  nayapay: 'NayaPay', bank_transfer: 'Bank Transfer',
}

// Detects opaque CUIDs (PaymentMethod ids) so a raw id is never shown as a label.
function isOpaquePaymentId(value: string): boolean {
  const v = value.trim()
  if (v.includes(' ')) return false
  return /^[a-z][a-z0-9]{19,}$/.test(v)
}

interface PmFields {
  type: string
  accountName: string
  mobileNumber: string | null
  bankName: string | null
  ibanNumber: string | null
  accountNumber: string | null
}

// Builds the immutable account object stored on the trade / returned to the room.
export function buildPaymentAccountSnapshot(pm: PmFields) {
  const label = pm.type === 'bank_transfer'
    ? (pm.bankName ?? 'Bank Transfer')
    : (PM_LABELS[pm.type] ?? pm.type)
  return {
    type: pm.type,
    label,
    accountName: pm.accountName,
    ...(pm.mobileNumber ? { mobileNumber: pm.mobileNumber } : {}),
    ...(pm.bankName ? { bankName: pm.bankName } : {}),
    ...(pm.ibanNumber ? { ibanNumber: pm.ibanNumber } : {}),
    ...(pm.accountNumber ? { accountNumber: pm.accountNumber } : {}),
  }
}

// Read-time fallback for legacy trades created before sellerPaymentSnapshot
// existed (or where the value is a plain label, not a PaymentMethod id).
async function resolveSellerPaymentAccount(paymentMethod: string, sellerId: string) {
  const looksLikeId = isOpaquePaymentId(paymentMethod)
  // Only query when the value looks like an id; a plain label can't be an id.
  // Scope to the seller so a buyer can never resolve an unrelated account.
  const pm = looksLikeId
    ? await db.paymentMethod.findFirst({ where: { id: paymentMethod, userId: sellerId } })
    : null

  if (pm) {
    const account = buildPaymentAccountSnapshot(pm)
    return { label: account.label, account }
  }

  // Unresolvable (legacy label, or the account was deleted): show the label as-is,
  // but never leak a raw CUID. No account block renders in that case.
  return { label: looksLikeId ? 'Seller payment account' : paymentMethod, account: null }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CreateTradeInput {
  amount: number
  paymentMethod: string
  buyerWalletAddress: string
  buyerDeliveryMethod?: string
  buyerDeliveryAddress?: string
  /** Buyer's chosen on-chain network when the ad offers more than one (wallet delivery). */
  network?: string
  /** BUY ads: the taker (seller) may pick ONE of the buyer's pay-FROM accounts. */
  buyerPayFromMethodId?: string
}

export interface GetTradesParams {
  status?: string
  page?: number
  limit?: number
  role?: 'buyer' | 'seller'
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function recalcSellerResponseTime(tx: Prisma.TransactionClient, sellerId: string) {
  const recentTrades = await tx.trade.findMany({
    where: {
      sellerId,
      status: 'crypto_released',
      paymentUploadedAt: { not: null },
      paymentConfirmedAt: { not: null },
    },
    orderBy: { updatedAt: 'desc' },
    take: 20,
    select: { paymentUploadedAt: true, paymentConfirmedAt: true },
  })

  const times = recentTrades
    .map((t) => {
      if (!t.paymentUploadedAt || !t.paymentConfirmedAt) return null
      const mins = Math.round((t.paymentConfirmedAt.getTime() - t.paymentUploadedAt.getTime()) / 60_000)
      return mins > 0 ? mins : null
    })
    .filter((v): v is number => v !== null)

  if (times.length === 0) return

  times.sort((a, b) => a - b)
  const mid = Math.floor(times.length / 2)
  const median = times.length % 2 !== 0
    ? times[mid]!
    : Math.round((times[mid - 1]! + times[mid]!) / 2)

  await tx.tradeStats.upsert({
    where: { userId: sellerId },
    create: { userId: sellerId, avgResponseMinutes: median },
    update: { avgResponseMinutes: median },
  })
}

async function recalcSellerReleaseTime(tx: Prisma.TransactionClient, sellerId: string) {
  const recentTrades = await tx.trade.findMany({
    where: {
      sellerId,
      status: 'crypto_released',
      paymentConfirmedAt: { not: null },
    },
    orderBy: { updatedAt: 'desc' },
    take: 20,
    select: { paymentConfirmedAt: true, updatedAt: true },
  })

  const times = recentTrades
    .map((t) => {
      if (!t.paymentConfirmedAt) return null
      const mins = Math.round((t.updatedAt.getTime() - t.paymentConfirmedAt.getTime()) / 60_000)
      return mins > 0 ? mins : null
    })
    .filter((v): v is number => v !== null)

  if (times.length === 0) return

  times.sort((a, b) => a - b)
  const mid = Math.floor(times.length / 2)
  const median = times.length % 2 !== 0
    ? times[mid]!
    : Math.round((times[mid - 1]! + times[mid]!) / 2)

  await tx.tradeStats.upsert({
    where: { userId: sellerId },
    create: { userId: sellerId, avgReleaseMinutes: median },
    update: { avgReleaseMinutes: median },
  })
}

async function upsertTradeStats(
  tx: Prisma.TransactionClient,
  userId: string,
  isCompleted: boolean,
  fiatAmount: Prisma.Decimal,
) {
  const stats = await tx.tradeStats.findUnique({ where: { userId } })
  if (!stats) {
    const completedTrades = isCompleted ? 1 : 0
    await tx.tradeStats.create({
      data: {
        userId,
        totalTrades: 1,
        completedTrades,
        cancelledTrades: 0,
        completionRate: new Prisma.Decimal(isCompleted ? 1 : 0),
        totalVolumePKR: isCompleted ? fiatAmount : new Prisma.Decimal(0),
      },
    })
  } else {
    const newTotal = stats.totalTrades + 1
    const newCompleted = stats.completedTrades + (isCompleted ? 1 : 0)
    const completionRate = new Prisma.Decimal(newCompleted).div(new Prisma.Decimal(newTotal))
    await tx.tradeStats.update({
      where: { userId },
      data: {
        totalTrades: newTotal,
        completedTrades: newCompleted,
        completionRate,
        ...(isCompleted ? { totalVolumePKR: { increment: fiatAmount } } : {}),
      },
    })
  }
}

// ─── Service Functions ────────────────────────────────────────────────────────

export async function createTrade(initiatorId: string, adId: string, data: CreateTradeInput) {
  // Resolve trade roles from the ad side. On a SELL ad the initiator is buying
  // USDT (initiator = buyer). On a BUY ad the initiator is selling USDT to the ad
  // owner, so the ad owner is the buyer and the initiator is the seller. We read
  // side + owner up front (cheap) so role-dependent guards below are correct.
  const adSide = await db.ad.findUnique({ where: { id: adId }, select: { side: true, userId: true, network: true, networks: true, price: true } })
  if (!adSide) throw new AppError('NOT_FOUND', 'Ad not found', 404)
  if (adSide.userId === initiatorId) throw new AppError('SELF_TRADE', 'Cannot trade on your own ad', 400)
  const isBuyAd = adSide.side === 'buy'
  const buyerId = isBuyAd ? adSide.userId : initiatorId
  const sellerId = isBuyAd ? initiatorId : adSide.userId

  // Resolve the trade's on-chain network. A wallet-delivery ad may offer several
  // networks; the taker picks ONE at trade start. Fall back to the ad's primary
  // network for legacy ads / when the chosen network isn't one the ad offers.
  const offeredNetworks = adSide.networks?.length ? adSide.networks : [adSide.network]
  const chosenNetwork = data.network && offeredNetworks.includes(data.network)
    ? data.network
    : adSide.network

  // Validate the buyer's USDT receiving destination at trade start (sell ads only;
  // on buy ads the destination is the maker's pre-validated settlementMethod).
  // Wallet delivery → check against the chosen on-chain network; exchange delivery →
  // check the venue's UID format. Blocks malformed addresses before a trade opens.
  if (!isBuyAd) {
    const deliveryMethod = data.buyerDeliveryMethod ?? 'wallet_blockchain'
    const destination = (data.buyerDeliveryAddress ?? data.buyerWalletAddress ?? '').trim()
    const validationLabel = deliveryMethod === 'wallet_blockchain' ? chosenNetwork : deliveryMethod
    if (destination) {
      const res = validateAddressForNetwork(destination, validationLabel)
      if (!res.valid) {
        throw new AppError('VALIDATION_ERROR', res.reason ?? 'Invalid receiving address', 400)
      }
    }
  }

  // Idempotency: claim the key with SET NX BEFORE the transaction so two
  // concurrent submissions (double-click / retry) can't both create a trade.
  // Keyed to the actor (initiator) so a buy-ad seller's retry maps to the same key.
  const idempKey = `idempotency:trade:${initiatorId}:${adId}:${data.amount}:${data.paymentMethod}`
  const existing = await redis.get(idempKey)
  if (existing && existing !== 'pending') {
    const prior = await db.trade.findUnique({ where: { id: existing } })
    if (prior) return prior
  }
  const claimed = await redis.set(idempKey, 'pending', 'EX', 300, 'NX')
  if (claimed !== 'OK') {
    // Another request is creating this exact trade right now (or just did).
    throw new AppError('DUPLICATE_REQUEST', 'A matching trade is already being created. Please wait a moment.', 409)
  }

  // Taker-first flow marker (Phase 1) — hoisted so it can be stamped on the trade
  // inside the transaction below. Only BUY ads on a taker-first-ready market use
  // the reordered flow; false everywhere else (classic fiat-first).
  let usesTakerFirstFlow = false

  try {
    // ── Concurrency cap (anti-scam, always on) ──────────────────────────────────
    // Both parties must be under their active-trade limit (USDT + CTM combined,
    // lower while a party has an open dispute). This stops one user from holding
    // many in-progress trades at once and collecting from several victims without
    // delivering. Checks the taker (initiator) AND the maker (ad owner).
    await assertCanOpenTrade(initiatorId, 'self')
    await assertCanOpenTrade(adSide.userId, 'counterparty')

    // ── No-KYC taker access & limits (Phase 2) ──────────────────────────────────
    // The taker is the initiator; the maker (ad owner) is always KYC-approved
    // (ad creation is gated). When nokyc_taker_enabled is OFF (default) this call
    // simply enforces the pre-existing "KYC required to trade" gate for the taker,
    // so behavior is unchanged. When ON, an unverified taker may proceed within the
    // per-trade / daily / lifetime PKR caps and single-open-trade cap — but ONLY
    // when the taker sends their own leg first (sell ads always; buy ads once
    // taker-first settlement is enabled). The maker's KYC is still enforced in-tx.
    usesTakerFirstFlow = isBuyAd && (await isTakerFirstForMarket('usdt'))
    const takerSendsFirst = !isBuyAd || usesTakerFirstFlow
    const fiatForNoKyc = new Prisma.Decimal(data.amount).mul(adSide.price)
    await assertNoKycTakerAllowed({ takerId: initiatorId, fiatAmount: fiatForNoKyc, takerSendsFirst })

    // ── Non-custodial anti-griefing (taker = the initiator) ───────────────────
    // Flag OFF (default) skips this, so production is unchanged. Caps only the
    // TAKER. (General concurrency is handled above, regardless of this flag.)
    // Test/staff accounts on the cap-bypass list also skip the abandoned-trade
    // cooldown and the per-order size cap, so they can test the full flow freely.
    if (await isFlagEnabled(FLAGS.NONCUSTODIAL_P2P) && !(await isTradeLimitBypassed(initiatorId))) {
      const u = await db.user.findUnique({
        where: { id: initiatorId },
        select: { kycLevel: true, tradeCooldownUntil: true },
      })
      // Anti-griefing cooldown: blocks users who recently abandoned a trade.
      if (u?.tradeCooldownUntil && u.tradeCooldownUntil > new Date()) {
        throw new AppError(
          'TRADE_COOLDOWN',
          'You recently left a trade unpaid. Please wait a little before starting a new one.',
          429,
        )
      }
      // Early-access per-order cap, tier-aware: Level 1 default 50 USDT, Level 2
      // default unlimited (0). Caps at-risk exposure while trust is established.
      const isL2 = u?.kycLevel === 'enhanced'
      const maxOrderUsdt = isL2
        ? await getNumberConfig('noncustodial_max_order_usdt_l2', 500)
        : await getNumberConfig('noncustodial_max_order_usdt_l1', 50)
      if (maxOrderUsdt > 0 && new Prisma.Decimal(data.amount).gt(maxOrderUsdt)) {
        throw new AppError('ORDER_TOO_LARGE', `During early access, your maximum order is ${maxOrderUsdt} USDT.`, 400)
      }
    }
  } catch (err) {
    // Release the idempotency claim so the user can retry once unblocked.
    if (err instanceof AppError) await redis.del(idempKey).catch(() => {})
    throw err
  }

  // Maker bond config read once, outside the transaction (cheap, cached).
  const bondCfg = await getBondConfig()
  let bondHeldAmount: string | null = null

  let trade: Awaited<ReturnType<typeof db.trade.create>>
  try {
    trade = await db.$transaction(async (tx: Tx) => {
    // SELECT FOR UPDATE on buyer user
    const [buyerRows] = await tx.$queryRaw<Array<{
      id: string; dailyBuyUsed: Prisma.Decimal; dailyBuyLimit: Prisma.Decimal;
      dailyBuyReset: Date | null; isBanned: boolean; isSuspended: boolean; kycStatus: string
    }>>`
      SELECT id, "dailyBuyUsed", "dailyBuyLimit", "dailyBuyReset", "isBanned", "isSuspended", "kycStatus"
      FROM "User"
      WHERE id = ${buyerId}
      FOR UPDATE
    `
    if (!buyerRows) throw new AppError('NOT_FOUND', 'Buyer not found', 404)
    if (buyerRows.isBanned) throw new AppError('ACCOUNT_BANNED', 'Account is banned', 403)
    if (buyerRows.isSuspended) throw new AppError('ACCOUNT_SUSPENDED', 'Account is suspended', 403)
    // On a BUY ad the buyer is the ad owner (the maker) and must be KYC-approved.
    // On a SELL ad the buyer is the taker (initiator), whose KYC gate is handled by
    // assertNoKycTakerAllowed() above — either verified, or allowed within no-KYC
    // limits — so we do NOT hard-block here.
    if (isBuyAd && buyerRows.kycStatus !== 'approved') throw new AppError('KYC_REQUIRED', 'KYC verification required to trade', 403)

    // On a BUY ad the seller is the initiator (the taker), so verify their standing.
    // Their KYC gate is handled by assertNoKycTakerAllowed() above (verified, or
    // allowed within no-KYC limits); here we only enforce ban/suspension.
    if (isBuyAd) {
      const [sellerRows] = await tx.$queryRaw<Array<{ isBanned: boolean; isSuspended: boolean; kycStatus: string }>>`
        SELECT "isBanned", "isSuspended", "kycStatus" FROM "User" WHERE id = ${sellerId} FOR UPDATE
      `
      if (!sellerRows) throw new AppError('NOT_FOUND', 'Seller not found', 404)
      if (sellerRows.isBanned) throw new AppError('ACCOUNT_BANNED', 'Account is banned', 403)
      if (sellerRows.isSuspended) throw new AppError('ACCOUNT_SUSPENDED', 'Account is suspended', 403)
    }

    // SELECT FOR UPDATE on ad
    const [adRows] = await tx.$queryRaw<Array<{
      id: string
      userId: string
      side: string
      coin: string
      network: string
      price: Prisma.Decimal
      availableAmount: Prisma.Decimal
      minOrder: Prisma.Decimal
      maxOrder: Prisma.Decimal
      status: string
      tradeWindow: number
      paymentMethods: string[]
      settlementMethod: string | null
      settlementDestinations: Array<{ method: string; network: string | null; address: string }> | null
      tokenDeliveryTypes: string[]
    }>>`
      SELECT id, "userId", side, coin, network, price, "availableAmount", "minOrder", "maxOrder", status, "tradeWindow", "paymentMethods", "settlementMethod", "settlementDestinations", "tokenDeliveryTypes"
      FROM "Ad"
      WHERE id = ${adId}
      FOR UPDATE
    `
    if (!adRows) throw new AppError('NOT_FOUND', 'Ad not found', 404)

    if (adRows.status !== 'active') throw new AppError('AD_INACTIVE', 'This ad is not active', 400)
    if (adRows.coin !== 'USDT') throw new AppError('UNSUPPORTED_ASSET', 'Only USDT ads are supported on this marketplace', 400)
    if (!['BEP20', 'Aptos'].includes(adRows.network)) throw new AppError('UNSUPPORTED_NETWORK', 'Only BEP20 and Aptos networks are supported', 400)
    if (!['sell', 'buy'].includes(adRows.side)) throw new AppError('INVALID_AD', 'Unsupported ad type', 400)
    // A buy ad must carry the owner's receiving address (captured at ad creation)
    // so the seller knows where to deliver the USDT.
    if (adRows.side === 'buy' && !(adRows.settlementMethod ?? '').trim()) {
      throw new AppError('INVALID_AD', 'This buy listing has no receiving address on file', 400)
    }
    if (adRows.userId === initiatorId) throw new AppError('SELF_TRADE', 'Cannot trade on your own ad', 400)

    const amount = new Prisma.Decimal(data.amount)
    if (amount.lt(adRows.minOrder)) {
      throw new AppError('AMOUNT_TOO_LOW', `Minimum order is ${adRows.minOrder}`, 400)
    }
    if (amount.gt(adRows.maxOrder)) {
      throw new AppError('AMOUNT_TOO_HIGH', `Maximum order is ${adRows.maxOrder}`, 400)
    }
    if (amount.gt(adRows.availableAmount)) {
      throw new AppError('INSUFFICIENT_AMOUNT', 'Requested amount exceeds available amount', 400)
    }

    // Check daily buy limit — reset used amount if the daily window has rolled over
    const now = new Date()
    const needsReset = buyerRows.dailyBuyReset && now > buyerRows.dailyBuyReset
    const effectiveDailyUsed = needsReset ? new Prisma.Decimal(0) : new Prisma.Decimal(buyerRows.dailyBuyUsed)
    const dailyBuyLimit = new Prisma.Decimal(buyerRows.dailyBuyLimit)
    const fiatAmount = amount.mul(adRows.price)
    if (effectiveDailyUsed.add(fiatAmount).gt(dailyBuyLimit)) {
      throw new AppError('DAILY_LIMIT_EXCEEDED', 'Daily buy limit would be exceeded', 400)
    }

    // Decrement availableAmount
    const newAvailable = adRows.availableAmount.sub(amount)
    const newAdStatus = newAvailable.lte(0) ? 'completed' : 'active'

    await tx.ad.update({
      where: { id: adId },
      data: { availableAmount: newAvailable, status: newAdStatus },
    })

    // Increment buyer dailyBuyUsed (reset counter first if window rolled over)
    const resetAt = new Date(now.getTime() + 24 * 60 * 60 * 1000)
    await tx.user.update({
      where: { id: buyerId },
      data: {
        dailyBuyUsed: needsReset ? fiatAmount : { increment: fiatAmount },
        ...(needsReset ? { dailyBuyReset: resetAt } : {}),
      },
    })

    // Snapshot the seller's receiving account now, so the buyer's pay-to details
    // are locked for the life of the trade (immutable dispute evidence) even if
    // the seller later edits or deletes that payment method. data.paymentMethod is
    // a PaymentMethod id for current trades; scope the lookup to the ad owner.
    let sellerPaymentSnapshot: Prisma.InputJsonValue | undefined
    if (isOpaquePaymentId(data.paymentMethod)) {
      // The PKR is always received by the SELLER, so the account belongs to the
      // seller (the ad owner on a sell ad, the initiator on a buy ad).
      const pm = await tx.paymentMethod.findFirst({
        where: { id: data.paymentMethod, userId: sellerId },
        select: { type: true, accountName: true, mobileNumber: true, bankName: true, ibanNumber: true, accountNumber: true },
      })
      if (pm) sellerPaymentSnapshot = buildPaymentAccountSnapshot(pm)
    }

    // Buy ads: snapshot the buyer/lister's pay-FROM account(s) (declared at ad
    // creation in paymentMethods) so the seller sees where PKR will arrive from.
    // On a buy ad the buyer is the ad owner (buyerId). The taker (seller) may pick
    // ONE of those accounts (data.buyerPayFromMethodId) — then we snapshot only that
    // one so the agreed rail is unambiguous; otherwise we snapshot all of them.
    let buyerPaymentSnapshot: Prisma.InputJsonValue | undefined
    if (isBuyAd && adRows.paymentMethods.length > 0) {
      const wantId = data.buyerPayFromMethodId && adRows.paymentMethods.includes(data.buyerPayFromMethodId)
        ? data.buyerPayFromMethodId
        : null
      const ids = wantId ? [wantId] : adRows.paymentMethods
      const pms = await tx.paymentMethod.findMany({
        where: { id: { in: ids }, userId: buyerId },
        select: { type: true, accountName: true, mobileNumber: true, bankName: true, ibanNumber: true, accountNumber: true },
      })
      if (pms.length === 1) buyerPaymentSnapshot = buildPaymentAccountSnapshot(pms[0]!)
      else if (pms.length > 1) buyerPaymentSnapshot = { accounts: pms.map(buildPaymentAccountSnapshot) }
    }

    // Resolve the buyer's USDT receiving destination. On a SELL ad the initiator
    // (buyer) supplied it at trade start; on a BUY ad it comes from the ad owner's
    // declared destination(s). When the ad has multiple destinations, the taker
    // (seller) picks one by (method, network); we then use the ad's STORED address
    // for that destination — never an address from the taker — so funds can't be
    // redirected. Falls back to the legacy single settlementMethod.
    let chosenDestination: { method: string; network: string | null; address: string } | null = null
    if (isBuyAd) {
      const dests = adRows.settlementDestinations ?? []
      if (dests.length > 0) {
        const wantMethod = data.buyerDeliveryMethod ?? dests[0]!.method
        const wantNetwork = data.network ?? dests[0]!.network
        chosenDestination =
          dests.find((d) => d.method === wantMethod && (d.method !== 'wallet_blockchain' || d.network === wantNetwork))
          ?? dests[0]!
      }
    }
    const buyerWalletAddress = isBuyAd
      ? (chosenDestination?.address ?? adRows.settlementMethod ?? '')
      : data.buyerWalletAddress
    const buyerDeliveryMethod = isBuyAd
      ? (chosenDestination?.method ?? adRows.tokenDeliveryTypes?.[0] ?? 'wallet_blockchain')
      : data.buyerDeliveryMethod
    const buyerDeliveryAddress = isBuyAd
      ? (chosenDestination?.address ?? adRows.settlementMethod ?? '')
      : data.buyerDeliveryAddress
    // For a chosen on-chain destination, the trade's network must match it.
    const tradeNetwork = (isBuyAd && chosenDestination?.method === 'wallet_blockchain' && chosenDestination.network)
      ? chosenDestination.network
      : chosenNetwork

    // Create the trade. Honor the ad's advertised trade window (shown to users
    // on the listing as "30 min window" etc.) instead of a fixed long window.
    const windowMins = adRows.tradeWindow && adRows.tradeWindow > 0 ? adRows.tradeWindow : 30
    const expiresAt = new Date(Date.now() + windowMins * 60 * 1000)
    const orderRef = generateOrderRef('TRD')

    const newTrade = await tx.trade.create({
      data: {
        orderRef,
        adId,
        buyerId,
        sellerId,
        coin: adRows.coin,
        network: tradeNetwork,
        amount,
        price: adRows.price,
        fiatAmount,
        paymentMethod: data.paymentMethod,
        ...(sellerPaymentSnapshot ? { sellerPaymentSnapshot } : {}),
        ...(buyerPaymentSnapshot ? { buyerPaymentSnapshot } : {}),
        buyerWalletAddress,
        ...(buyerDeliveryMethod ? { buyerDeliveryMethod } : {}),
        ...(buyerDeliveryAddress ? { buyerDeliveryAddress } : {}),
        status: 'payment_pending',
        takerFirst: usesTakerFirstFlow,
        expiresAt,
      },
    })

    // System message. Attribute to the SELLER so it sides + labels on the
    // counterparty's side: this is an instruction directed AT the buyer ("please
    // upload payment proof"), so it should read as coming from the seller, never
    // from the buyer's own "You" side.
    await tx.tradeMessage.create({
      data: {
        tradeId: newTrade.id,
        senderId: sellerId,
        message: 'Trade created. Please upload payment proof within the trade window.',
        isSystem: true,
      },
    })

      // Maker collateral bond (non-custodial Phase 5). Locks the maker's USDT
      // bond in the SAME transaction so the trade and the lock commit together;
      // if the maker can't cover it, lockMakerBondTx throws and the whole trade
      // creation rolls back (no orphaned lock, no half-created trade).
      // Only on SELL ads: there the maker is the seller who must deliver USDT, so a
      // USDT bond is meaningful. On a BUY ad the maker is the buyer (may hold no
      // USDT), so we skip it — consistent with the bid path, which posts no bond.
      // This holds under taker-first too: the BUY-ad maker is still the fiat-paying
      // buyer with no USDT to bond, and bonding the taker (who sends crypto first)
      // would only lock the honest first-mover's own funds without protecting them —
      // so the skip is correct in both orders. (CTM differs: its maker bond is drawn
      // from the platform USDT balance regardless of side, so CTM taker-first buy
      // listings DO bond the maker — see ctm.trade.service createTradeFromListing.)
      if (bondCfg.enabled && !isBuyAd) {
        const lock = await lockMakerBondTx(
          tx,
          { tradeType: 'usdt', tradeId: newTrade.id, makerId: adRows.userId, tradeUsdt: amount.toString() },
          bondCfg,
        )
        if (lock.status === 'held' && !lock.alreadyHeld) bondHeldAmount = lock.amount
      }

      return newTrade
    })
  } catch (err) {
    // Release the claim so a legitimate retry isn't blocked for 5 minutes.
    await redis.del(idempKey).catch(() => {})
    throw err
  }

  // Replace the 'pending' marker with the real trade id (5 min TTL) so a
  // sequential retry returns the same trade instead of creating a new one.
  await redis.set(idempKey, trade.id, 'EX', 300)

  // Notify the party who did NOT initiate this trade — the ad owner — so they
  // know a trade just opened against their listing, instead of only hearing about
  // it later when payment proof is uploaded.
  if (isBuyAd) {
    // BUY ad: the buyer is the ad owner. The seller filled their listing, so ping
    // the buyer to pay within the trade window.
    notify(
      buyerId,
      'trade',
      'A seller filled your buy listing',
      `Trade ${trade.orderRef} is open — send the PKR payment and upload proof within the trade window.`,
      { tradeId: trade.id },
      trade.id,
    )
  } else {
    // SELL ad: the seller is the ad owner. A buyer just opened a trade against
    // their listing, so ping the seller that a trade has started and payment is
    // incoming — they'll need to confirm receipt and release the crypto.
    notify(
      sellerId,
      'trade',
      'A buyer started a trade on your listing',
      `Trade ${trade.orderRef} is open — the buyer will send the PKR payment and upload proof within the trade window. Confirm once it arrives, then release the crypto.`,
      { tradeId: trade.id },
      trade.id,
    )
  }

  // Audit the bond lock after the transaction has committed. The maker is the ad
  // owner (the seller on a sell ad, the buyer on a buy ad).
  if (bondHeldAmount) {
    const makerId = adSide.userId
    void recordAuditLog(makerId, 'BOND_LOCKED', 'BondHold', `usdt:${trade.id}`, {
      tradeType: 'usdt', tradeId: trade.id, amountUsdt: bondHeldAmount,
    })
    logger.info({ tradeId: trade.id, makerId, amount: bondHeldAmount }, 'Maker bond locked')
  }

  // Persistent messaging (Phase 4): open the pair's trade episode. Best-effort,
  // flag-gated, never throws — a messaging failure must not affect the trade.
  void openEpisode({ market: 'usdt', tradeId: trade.id, tradeRef: trade.orderRef, buyerId, sellerId, fiatAmount: trade.fiatAmount })

  return trade
}

export async function uploadPaymentProof(tradeId: string, buyerId: string, proofUrl: string) {
  assertCloudinaryUrl(proofUrl, 'proofUrl')

  // Load seller info for email — safe outside tx (read-only, non-critical timing)
  const tradeForEmail = await db.trade.findUnique({
    where: { id: tradeId },
    select: { seller: { select: { email: true, username: true } }, sellerId: true, orderRef: true, coin: true, amount: true, fiatAmount: true, takerFirst: true },
  })
  if (!tradeForEmail) throw new AppError('NOT_FOUND', 'Trade not found', 404)

  // send_fiat is always the BUYER's action. Its position in the ladder depends on
  // the flow: classic pending→uploaded (first step); taker-first confirmed→crypto_sent
  // (the maker pays after acknowledging the taker's crypto). Never terminal.
  const step = stepForAction(tradeForEmail.takerFirst, 'send_fiat')

  // Use optimistic updateMany with status guard — prevents two concurrent uploads both succeeding
  const result = await db.trade.updateMany({
    where: { id: tradeId, buyerId, status: step.from },
    data: { status: step.to, paymentProofUrl: proofUrl, paymentUploadedAt: new Date() },
  })

  if (result.count === 0) {
    // Distinguish "not your trade" from "wrong status" with a secondary read
    const check = await db.trade.findUnique({ where: { id: tradeId }, select: { buyerId: true, status: true } })
    if (!check) throw new AppError('NOT_FOUND', 'Trade not found', 404)
    if (check.buyerId !== buyerId) throw new AppError('FORBIDDEN', 'Not your trade', 403)
    throw new AppError('INVALID_STATUS', `Cannot upload proof for trade in status: ${check.status}`, 400)
  }

  const updated = await db.trade.findUniqueOrThrow({ where: { id: tradeId } })

  await postTradeSystemMessage(tradeId, buyerId, 'Payment proof uploaded. Waiting for the seller to confirm the payment was received.')

  notify(tradeForEmail.sellerId, 'trade', 'Payment Proof Uploaded', 'The buyer has uploaded payment proof. Please review and confirm.', { tradeId }, tradeId)
  createAdminNotif({ category: 'TRADE', title: 'Payment Proof Uploaded', body: `Trade #${tradeForEmail.orderRef} — buyer uploaded payment proof.`, href: `/admin/trades/${tradeId}` })

  // Notify seller via email
  await sendTradeEmail(
    'payment_uploaded',
    {
      orderRef: tradeForEmail.orderRef,
      coin: tradeForEmail.coin,
      amount: tradeForEmail.amount.toString(),
      pkrValue: tradeForEmail.fiatAmount.toString(),
      counterpartyUsername: 'Buyer',
    },
    tradeForEmail.seller.email,
  )

  return updated
}

export async function confirmPayment(
  tradeId: string,
  actorId: string,
  role: string,
  opts?: { confirmedReceipt?: boolean },
) {
  // Verified-receipt rule (non-custodial): the seller must confirm the money has
  // actually landed in their account — never release on a screenshot alone. The
  // client must send an explicit acknowledgment. Admins are exempt. Flag OFF
  // preserves the original one-click confirm behavior.
  const nonCustodial = await isFlagEnabled(FLAGS.NONCUSTODIAL_P2P)
  if (role !== 'admin' && opts?.confirmedReceipt !== true && nonCustodial) {
    throw new AppError(
      'RECEIPT_NOT_CONFIRMED',
      'Confirm that the payment has actually arrived in your account (a screenshot is not enough).',
      400,
    )
  }

  // confirm_fiat is always the SELLER's action (they receive the PKR). Position in
  // the ladder depends on the flow: classic uploaded→confirmed (then the seller
  // sends crypto); taker-first crypto_sent→released — the TERMINAL step (the taker
  // confirms the maker's fiat and the trade completes).
  const pre = await db.trade.findUnique({ where: { id: tradeId }, select: { takerFirst: true, status: true, sellerId: true } })
  if (!pre) throw new AppError('NOT_FOUND', 'Trade not found', 404)
  if (role !== 'admin' && pre.sellerId !== actorId) {
    throw new AppError('FORBIDDEN', 'Only the seller or admin can confirm payment', 403)
  }
  const step = stepForAction(pre.takerFirst, 'confirm_fiat')
  if (pre.status !== step.from) {
    throw new AppError('INVALID_STATUS', `Cannot confirm payment for trade in status: ${pre.status}`, 400)
  }

  // Taker-first: this is terminal — the seller (taker) confirms the maker's fiat
  // arrived, completing the trade. The maker's crypto was already delivered first.
  if (step.terminal) return finalizeUsdtTrade(tradeId)

  // Classic: non-terminal. Release window — once payment is confirmed, the seller
  // must release the crypto within RELEASE_WINDOW_MIN or the trade auto-escalates
  // to a dispute (tradeEscalation.job). Only enforced in non-custodial mode.
  const RELEASE_WINDOW_MIN = 15
  const releaseDeadlineAt = nonCustodial
    ? new Date(Date.now() + RELEASE_WINDOW_MIN * 60 * 1000)
    : null

  const updated = await db.$transaction(async (tx: Tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string; status: string; sellerId: string; buyerId: string }>>`
      SELECT id, status, "sellerId", "buyerId" FROM "Trade" WHERE id = ${tradeId} FOR UPDATE
    `
    const trade = rows[0]
    if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)

    if (role !== 'admin' && trade.sellerId !== actorId) {
      throw new AppError('FORBIDDEN', 'Only the seller or admin can confirm payment', 403)
    }
    if (trade.status !== step.from) {
      throw new AppError('INVALID_STATUS', `Cannot confirm payment for trade in status: ${trade.status}`, 400)
    }

    return tx.trade.update({
      where: { id: tradeId },
      data: {
        status: step.to,
        paymentConfirmedAt: new Date(),
        ...(releaseDeadlineAt ? { releaseDeadlineAt } : {}),
      },
    })
  })

  await postTradeSystemMessage(tradeId, actorId, 'Seller confirmed the PKR payment was received. The seller will now send the crypto.')

  notify(updated.buyerId, 'trade', 'Payment Confirmed', 'The seller has confirmed your payment. Crypto will be sent soon.', { tradeId }, tradeId)
  return updated
}

export async function markCryptoSent(
  tradeId: string,
  sellerId: string,
  txHash: string,
  screenshotUrl?: string,
) {
  const txHashNorm = txHash.trim().toLowerCase()
  const hasHash = txHashNorm.length > 0
  const screenshot = screenshotUrl?.trim() || null
  if (!hasHash && !screenshot) {
    throw new AppError('VALIDATION_ERROR', 'Provide a transaction hash or a transfer screenshot as proof.', 400)
  }

  // Load trade outside the transaction so we can run async blockchain RPC calls
  // before acquiring the DB lock — RPC calls can take several seconds.
  const tradeForVerify = await db.trade.findUnique({
    where: { id: tradeId },
    select: { id: true, status: true, sellerId: true, coin: true, network: true, amount: true, buyerWalletAddress: true, buyerDeliveryAddress: true, buyerDeliveryMethod: true, takerFirst: true },
  })
  if (!tradeForVerify) throw new AppError('NOT_FOUND', 'Trade not found', 404)
  if (tradeForVerify.sellerId !== sellerId) throw new AppError('FORBIDDEN', 'Only the seller can mark crypto as sent', 403)
  // send_crypto is always the SELLER's action (they deliver the crypto, with on-chain
  // verification). Position depends on the flow: classic confirmed→crypto_sent (after
  // fiat is confirmed); taker-first pending→uploaded (the FIRST step — the taker sends
  // crypto before any fiat moves). Never terminal.
  const cryptoStep = stepForAction(tradeForVerify.takerFirst, 'send_crypto')
  if (tradeForVerify.status !== cryptoStep.from) {
    throw new AppError('INVALID_STATUS', `Cannot mark crypto sent for trade in status: ${tradeForVerify.status}`, 400)
  }

  // ── Duplicate hash guard ──────────────────────────────────────────────────────
  // The same on-chain tx can only prove one trade. Block replay before RPC calls.
  // Only when a hash was actually provided (screenshot-only delivery has none).
  if (hasHash) await assertNoDuplicateTradeTxHash(txHashNorm, tradeId)

  // ── On-chain verification ─────────────────────────────────────────────────────
  // We can only auto-verify the on-chain receiver when the buyer asked to receive
  // tokens at a real blockchain wallet. Exchange-UID deliveries (Binance / Bitget /
  // Gate) and email / username transfers have NO on-chain wallet address: the
  // seller sends to an exchange deposit address we cannot know in advance, so there
  // is nothing to match the transaction receiver against. Running EVM/TRON receiver
  // verification on those produced a false "transaction does not send tokens to the
  // buyer's wallet" rejection (the "Transfers found to: 0x…" address in that error
  // is simply the real on-chain receiver of the seller's tx — it is NOT hard-coded).
  //
  // NOTE: the wallet delivery method is stored as either 'blockchain' (legacy
  // trade/new flow) or 'wallet_blockchain' (marketplace flow) — accept both.
  const deliveryMethod = tradeForVerify.buyerDeliveryMethod ?? ''
  const WALLET_DELIVERY_METHODS = ['blockchain', 'wallet_blockchain']
  const isWalletDelivery = WALLET_DELIVERY_METHODS.includes(deliveryMethod)

  // Resolve the buyer's destination wallet: blockchain delivery address takes
  // priority over the generic buyerWalletAddress field (which may hold a legacy
  // value or, for bid-path trades, the same wallet).
  const buyerWallet =
    (isWalletDelivery && tradeForVerify.buyerDeliveryAddress)
      ? tradeForVerify.buyerDeliveryAddress
      : tradeForVerify.buyerWalletAddress

  let verificationResult: TxVerificationResult
  if (!hasHash) {
    // Screenshot-only delivery (manual / exchange-UID). There is no on-chain
    // hash to verify — the screenshot is the proof. Non-blocking: the buyer
    // confirms receipt from their own wallet/account.
    verificationResult = {
      status: 'skipped',
      message: 'Delivery proof is a transfer screenshot; no on-chain hash to verify.',
      details: { rpcChecked: false },
    }
  } else if (!isWalletDelivery || !buyerWallet || !buyerWallet.trim()) {
    // Hash given but no verifiable on-chain wallet (exchange-UID / email /
    // username delivery, or non-EVM chain). Record it as informational only —
    // it does NOT block release (the buyer is the authority on receipt).
    const reason = !isWalletDelivery
      ? `Delivery is via "${deliveryMethod || 'a non-wallet method'}", which has no on-chain wallet address to verify against`
      : 'No buyer wallet address on record to verify against'
    verificationResult = {
      status: 'skipped',
      message: `${reason}.`,
      details: { rpcChecked: false },
    }
    logger.info(
      { tradeId, deliveryMethod },
      'markCryptoSent: non-wallet delivery — skipping on-chain receiver verification',
    )
  } else {
    verificationResult = await verifyTradeTx(
      txHashNorm,
      tradeForVerify.coin,
      tradeForVerify.network,
      tradeForVerify.amount,
      buyerWallet,
    )
  }

  logger.info(
    { tradeId, txHash: txHashNorm, verificationStatus: verificationResult.status, chain: tradeForVerify.network },
    'markCryptoSent: blockchain verification result',
  )

  // ── Rejection gate ────────────────────────────────────────────────────────────
  // Hard-reject any status that is definitively wrong or unconfirmed.
  // A fake/wrong/unconfirmed hash must NEVER move the trade forward. This bounces
  // straight back to the seller to resubmit — it is NOT admin involvement, and it
  // protects the buyer from a non-existent transaction. Only applies when a hash
  // was actually provided; screenshot-only delivery skips this entirely.
  if (hasHash && HARD_REJECT_STATUSES.includes(verificationResult.status)) {
    const userMessages: Record<string, string> = {
      reverted: 'The transaction was reverted on-chain — no tokens were transferred. Check the explorer and resubmit a successful transaction.',
      mismatch_receiver: `The transaction does not send tokens to the buyer's wallet. ${verificationResult.message}`,
      mismatch_amount: `The transferred amount is less than the trade amount. ${verificationResult.message}`,
      failed: `Transaction verification failed. ${verificationResult.message}`,
      not_found: 'Transaction not found on this blockchain. Please ensure you submitted the correct hash and the transaction is confirmed, then resubmit.',
      pending: 'Transaction is not yet confirmed on-chain. Please wait for at least one block confirmation and resubmit.',
    }
    throw new AppError(
      'TX_VERIFICATION_FAILED',
      userMessages[verificationResult.status] ?? verificationResult.message,
      400,
    )
  }

  // NOTE: statuses 'skipped' / 'rpc_error' no longer block the buyer's release.
  // Release is gate-free (the buyer confirms from their own wallet); admin only
  // gets involved via a dispute. The status is still recorded below as an
  // informational signal (e.g. to show an "on-chain verified ✓" badge).

  // ── Commit to DB ──────────────────────────────────────────────────────────────
  const updated = await db.$transaction(async (tx: Tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string; status: string; sellerId: string; buyerId: string }>>`
      SELECT id, status, "sellerId", "buyerId" FROM "Trade" WHERE id = ${tradeId} FOR UPDATE
    `
    const trade = rows[0]
    if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)
    if (trade.sellerId !== sellerId) throw new AppError('FORBIDDEN', 'Only the seller can mark crypto as sent', 403)
    if (trade.status !== cryptoStep.from) {
      throw new AppError('INVALID_STATUS', `Trade status changed concurrently: ${trade.status}`, 400)
    }

    return tx.trade.update({
      where: { id: tradeId },
      data: {
        status: cryptoStep.to,
        ...(hasHash ? { sellerTxHash: txHashNorm } : {}),
        ...(screenshot ? { sellerDeliveryProofUrl: screenshot } : {}),
        txVerificationStatus: verificationResult.status,
        txVerificationDetails: verificationResult.details as Prisma.InputJsonValue,
      },
    })
  })

  const verifiedLabel = verificationResult.status === 'verified' ? ' (on-chain verified ✓)' : ''
  await postTradeSystemMessage(tradeId, sellerId, `Seller marked ${Number(updated.amount)} ${updated.coin} as sent. Buyer, confirm receipt once it arrives in your wallet/account.`)
  notify(updated.buyerId, 'trade', 'Crypto Is on the Way', `The seller has sent the crypto${verifiedLabel}. Check your wallet and release once you have received it.`, { tradeId, txVerificationStatus: verificationResult.status }, tradeId)
  createAdminNotif({
    category: 'TRADE',
    title: `Tx Proof Submitted — ${verificationResult.status.toUpperCase()}`,
    body: `Trade #${updated.orderRef} — seller submitted transfer proof. Verification: ${verificationResult.status}. ${verificationResult.message}`,
    href: `/admin/trades/${tradeId}`,
  })
  return updated
}

/**
 * Trade completion — the terminal `crypto_sent → crypto_released` transition.
 * This is IDENTICAL in both flows (classic: triggered by the buyer's release;
 * taker-first: triggered by the seller confirming fiat receipt), because the
 * terminal rung is always crypto_sent→crypto_released. The CALLER authorizes the
 * acting party; this function only re-guards the status under a row lock (so it
 * can be invoked from whichever endpoint is terminal for the trade's flow).
 */
async function finalizeUsdtTrade(tradeId: string) {
  // Load buyer/seller details needed for emails/queues — safe to read outside tx
  const tradeDetails = await db.trade.findUnique({
    where: { id: tradeId },
    include: {
      buyer: { select: { email: true, username: true, firstTradeBonusPaid: true } },
      seller: { select: { email: true, username: true } },
    },
  })
  if (!tradeDetails) throw new AppError('NOT_FOUND', 'Trade not found', 404)

  // ── Sanity check (no verification gate) ───────────────────────────────────────
  // The buyer is the authority on whether they received their crypto — they can
  // see it in their own wallet. We deliberately do NOT gate release on automatic
  // on-chain verification: the status is frequently "skipped"/"rpc_error" for
  // Aptos, exchange-UID delivery, or when our RPC is down, and locking those
  // forced an admin into every such trade. Admin now only steps in via a dispute.
  // The only thing we still guard is the inconsistent state of a crypto_sent
  // trade that somehow carries no transfer proof at all (tx hash or screenshot).
  // (Verification may be re-introduced later as an optional, non-blocking signal.)
  if (!tradeDetails.sellerTxHash && !tradeDetails.sellerDeliveryProofUrl) {
    throw new AppError(
      'NO_DELIVERY_PROOF',
      'Cannot complete — the seller has not submitted any transfer proof yet.',
      400,
    )
  }

  // The acting party was already authorized by the calling endpoint.
  const buyerId = tradeDetails.buyerId
  let streakResult: { count: number; isMilestone: boolean } = { count: 0, isMilestone: false }

  await db.$transaction(async (tx: Tx) => {
    // SELECT FOR UPDATE prevents concurrent release from double-completing
    const [rows] = await tx.$queryRaw<Array<{
      id: string; status: string; buyerId: string; sellerId: string; fiatAmount: Prisma.Decimal
    }>>`
      SELECT id, status, "buyerId", "sellerId", "fiatAmount"
      FROM "Trade"
      WHERE id = ${tradeId}
      FOR UPDATE
    `
    if (!rows) throw new AppError('NOT_FOUND', 'Trade not found', 404)
    if (rows.status !== 'crypto_sent') {
      throw new AppError('INVALID_STATUS', `Cannot complete trade in status: ${rows.status}`, 400)
    }

    await tx.trade.update({
      where: { id: tradeId },
      data: { status: 'crypto_released', escrowReleased: true, releasedAt: new Date() },
    })

    // Increment completedSellTrades for seller
    await tx.user.update({
      where: { id: rows.sellerId },
      data: { completedSellTrades: { increment: 1 } },
    })

    // Update TradeStats for buyer and seller
    await upsertTradeStats(tx, buyerId, true, rows.fiatAmount)
    await upsertTradeStats(tx, rows.sellerId, true, rows.fiatAmount)

    // Recalculate seller's median response + release times from last 20 trades
    await recalcSellerResponseTime(tx, rows.sellerId)
    await recalcSellerReleaseTime(tx, rows.sellerId)

    // Bump the buyer↔seller combined trade streak (USDT + CTM). Atomic with the
    // release so the count can never drift from the trades that produced it.
    streakResult = await incrementTradeStreak(tx, rows.buyerId, rows.sellerId)

    // Award airdrop points to both sides (atomic + idempotent; no-op when the flag
    // is off). Runs inside this CAS-guarded release tx so it can never double-count.
    await awardTradePointsTx(tx, { tradeType: 'usdt', tradeId, buyerId: rows.buyerId, sellerId: rows.sellerId, fiatAmountPKR: rows.fiatAmount })
  })

  // Trade completed cleanly → release the maker's collateral bond (idempotent;
  // no-op when bonds are off or none was held).
  await releaseMakerBond({ tradeType: 'usdt', tradeId }).catch((err) =>
    logger.error({ err, tradeId }, 'Failed to release maker bond after release'),
  )

  // Queue badge recalculation for both
  await queues.badgeRecalculate.add('recalculate', { userId: buyerId })
  await queues.badgeRecalculate.add('recalculate', { userId: tradeDetails.sellerId })

  // Queue referral payout if first trade bonus not yet paid
  if (!tradeDetails.buyer.firstTradeBonusPaid) {
    await queues.referralPayout.add('first-trade', { userId: buyerId, tradeId })
  }

  await postTradeSystemMessage(tradeId, buyerId, 'Trade complete — both legs have settled. 🎉')

  // Mutual streak — always confirm the running count; celebrate at milestones.
  if (streakResult.count > 0) {
    const streakMsg = streakResult.isMilestone
      ? `🔥 Milestone! This is your ${ordinal(streakResult.count)} completed trade together. Thanks for building trust on the platform.`
      : `🤝 ${ordinal(streakResult.count)} completed trade between you two.`
    await postTradeSystemMessage(tradeId, buyerId, streakMsg)
  }

  // Notify both parties (flow-neutral — either side may be the one that completed it).
  notify(tradeDetails.sellerId, 'trade', 'Trade Completed', 'The trade is complete. 🎉', { tradeId }, tradeId)
  notify(tradeDetails.buyerId, 'trade', 'Trade Completed', 'The trade is complete. 🎉', { tradeId }, tradeId)
  createAdminNotif({ category: 'TRADE', title: 'Trade Completed', body: `Trade #${tradeDetails.orderRef} has been completed.`, href: `/admin/trades/${tradeId}` })

  // Send completion emails
  await sendTradeEmail(
    'completed',
    {
      orderRef: tradeDetails.orderRef,
      coin: tradeDetails.coin,
      amount: tradeDetails.amount.toString(),
      pkrValue: tradeDetails.fiatAmount.toString(),
      counterpartyUsername: tradeDetails.seller.username,
    },
    tradeDetails.buyer.email,
  )

  void closeEpisode({ market: 'usdt', tradeId, outcome: 'completed' })

  return db.trade.findUnique({ where: { id: tradeId } })
}

/**
 * Buyer's `confirm_crypto` action. The BUYER (USDT buyer) is the actor in both
 * flows. In the classic flow this is the TERMINAL step (crypto_sent → released) —
 * the buyer confirms receipt and the trade completes. In the taker-first flow it
 * is a NON-terminal acknowledgement (uploaded → confirmed): the maker/buyer
 * confirms the taker's crypto arrived, after which the maker sends the fiat.
 */
export async function releaseTrade(tradeId: string, buyerId: string) {
  const trade = await db.trade.findUnique({
    where: { id: tradeId },
    select: { takerFirst: true, status: true, buyerId: true, sellerId: true },
  })
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)
  if (trade.buyerId !== buyerId) throw new AppError('FORBIDDEN', 'Only the buyer can confirm the crypto', 403)

  const step = stepForAction(trade.takerFirst, 'confirm_crypto')
  if (trade.status !== step.from) {
    throw new AppError('INVALID_STATUS', `Cannot confirm crypto for trade in status: ${trade.status}`, 400)
  }

  // Classic: terminal — buyer confirms receipt → complete the trade.
  if (step.terminal) return finalizeUsdtTrade(tradeId)

  // Taker-first: non-terminal — buyer (maker) acknowledges the taker's crypto
  // arrived; advance to `confirmed` so the maker can now send the PKR payment.
  const result = await db.trade.updateMany({
    where: { id: tradeId, buyerId, status: step.from },
    data: { status: step.to },
  })
  if (result.count === 0) {
    const check = await db.trade.findUnique({ where: { id: tradeId }, select: { status: true } })
    throw new AppError('INVALID_STATUS', `Cannot confirm crypto for trade in status: ${check?.status}`, 400)
  }
  await postTradeSystemMessage(tradeId, buyerId, 'Buyer confirmed the crypto was received. Buyer: now send the PKR payment and upload proof within the trade window.')
  notify(trade.sellerId, 'trade', 'Crypto Confirmed', 'The buyer confirmed your crypto arrived and will now send the PKR payment.', { tradeId }, tradeId)
  return db.trade.findUnique({ where: { id: tradeId } })
}

export async function cancelTrade(tradeId: string, actorId: string, role: string, reason: string) {
  let buyerId: string
  let sellerId: string

  await db.$transaction(async (tx: Tx) => {
    // SELECT FOR UPDATE prevents concurrent cancel+release from both succeeding
    const [trade] = await tx.$queryRaw<Array<{
      id: string; status: string; buyerId: string; sellerId: string;
      adId: string; amount: Prisma.Decimal; fiatAmount: Prisma.Decimal
    }>>`
      SELECT id, status, "buyerId", "sellerId", "adId", amount, "fiatAmount"
      FROM "Trade"
      WHERE id = ${tradeId}
      FOR UPDATE
    `
    if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)

    if (role !== 'admin' && trade.buyerId !== actorId && trade.sellerId !== actorId) {
      throw new AppError('FORBIDDEN', 'Not authorized to cancel this trade', 403)
    }

    const cancellableStatuses = ['payment_pending', 'payment_uploaded']
    if (!cancellableStatuses.includes(trade.status)) {
      throw new AppError('INVALID_STATUS', `Cannot cancel trade in status: ${trade.status}`, 400)
    }

    // Once the buyer has uploaded payment proof they may have already sent fiat.
    // A seller cancelling here could keep the buyer's money — only the buyer
    // (who knows whether they actually paid) or an admin may cancel now.
    if (trade.status === 'payment_uploaded' && role !== 'admin' && trade.buyerId !== actorId) {
      throw new AppError(
        'FORBIDDEN',
        'Payment proof has been uploaded — only the buyer or an admin can cancel this trade. If the payment is invalid, open a dispute instead.',
        403,
      )
    }

    buyerId = trade.buyerId
    sellerId = trade.sellerId

    await tx.trade.update({
      where: { id: tradeId },
      data: {
        status: 'cancelled',
        cancelReason: reason,
        cancelledAt: new Date(),
        cancelledBy: actorId,
      },
    })

    // Restore ad availableAmount. Use an ATOMIC increment (not read-then-write) so
    // a concurrent createTrade decrementing the same ad can't be lost — matching how
    // CTM and the expiry job restore liquidity. Reactivate an ad that had
    // auto-completed at zero, but never resurrect one the owner deliberately paused.
    const ad = await tx.ad.findUnique({ where: { id: trade.adId }, select: { status: true } })
    if (ad) {
      await tx.ad.update({
        where: { id: trade.adId },
        data: {
          availableAmount: { increment: trade.amount },
          ...(ad.status === 'completed' ? { status: 'active' } : {}),
        },
      })
    }

    // Restore buyer dailyBuyUsed — clamped at 0 because the daily window may
    // have rolled over (and been reset) since this trade incremented it.
    await tx.$executeRaw`
      UPDATE "User"
      SET "dailyBuyUsed" = GREATEST("dailyBuyUsed" - ${trade.fiatAmount}, 0)
      WHERE id = ${trade.buyerId}
    `
  })

  // Cancellation is not a maker fault → return the bond to the maker (idempotent).
  await releaseMakerBond({ tradeType: 'usdt', tradeId }).catch((err) =>
    logger.error({ err, tradeId }, 'Failed to release maker bond after cancel'),
  )

  const otherPartyId = actorId === buyerId! ? sellerId! : buyerId!
  await postTradeSystemMessage(tradeId, actorId, `Trade cancelled. Reason: ${reason}`)
  notify(otherPartyId, 'trade', 'Trade Cancelled', `A trade you were part of has been cancelled. Reason: ${reason}`, { tradeId }, tradeId)

  void closeEpisode({ market: 'usdt', tradeId, outcome: 'cancelled' })

  return db.trade.findUnique({ where: { id: tradeId } })
}

export async function openDispute(
  tradeId: string,
  openedById: string,
  reason: string,
  description: string,
) {
  const trade = await db.trade.findUnique({ where: { id: tradeId } })
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)

  if (trade.buyerId !== openedById && trade.sellerId !== openedById) {
    throw new AppError('FORBIDDEN', 'Only buyer or seller can open a dispute', 403)
  }

  // crypto_sent is disputable: the seller's tx may be pending admin review
  // (non-EVM chains / RPC outage) or the buyer may claim non-receipt — without
  // this the buyer would be stuck unable to release, cancel, OR dispute.
  const disputeStatuses = ['payment_uploaded', 'payment_confirmed', 'crypto_sent']
  if (!disputeStatuses.includes(trade.status)) {
    throw new AppError('INVALID_STATUS', `Cannot open dispute for trade in status: ${trade.status}`, 400)
  }

  // Dispute-lock: once a party has CONFIRMED the counterparty delivered their leg
  // (the confirm step that lands on `payment_confirmed`), that party may no longer
  // self-dispute — their only remaining job is to send their own leg, and letting
  // them "dispute instead of delivering" is a pure stall/grief lever. Their
  // recourse for a genuine edge case (e.g. a reversed payment) is human support.
  // The locked party is flow-dependent: classic = the SELLER (confirmed the fiat);
  // taker-first = the BUYER/maker (confirmed the crypto). It's exactly the actor of
  // the step that produces `payment_confirmed`. Before that (payment_uploaded) both
  // sides may still dispute — the window to contest a fake/incorrect proof.
  const lockedStatuses = ['payment_confirmed', 'crypto_sent']
  const confirmActor = flowSteps(trade.takerFirst)[1]!.actor // actor landing on payment_confirmed
  const lockedUserId = confirmActor === 'buyer' ? trade.buyerId : trade.sellerId
  if (lockedStatuses.includes(trade.status) && openedById === lockedUserId) {
    throw new AppError(
      'DISPUTE_SELLER_LOCKED',
      'You already confirmed the counterparty delivered their part, so you cannot open a dispute at this stage — your only remaining step is to send your own leg. If something is genuinely wrong, contact support.',
      403,
    )
  }

  // Cooldown: a dispute can only be opened DISPUTE_DELAY_MINUTES after the buyer
  // uploads payment proof. This stops instant rage-disputes and gives both sides
  // a window to confirm/communicate first. Legacy trades without an upload
  // timestamp are exempt so they never get stuck.
  if (trade.paymentUploadedAt) {
    const unlockAt = trade.paymentUploadedAt.getTime() + DISPUTE_DELAY_MINUTES * 60_000
    if (Date.now() < unlockAt) {
      const waitMin = Math.ceil((unlockAt - Date.now()) / 60_000)
      throw new AppError(
        'DISPUTE_TOO_EARLY',
        `You can open a dispute ${DISPUTE_DELAY_MINUTES} minutes after payment proof is uploaded. Please try again in about ${waitMin} minute${waitMin === 1 ? '' : 's'}.`,
        400,
      )
    }
  }

  let dispute: Awaited<ReturnType<typeof db.dispute.create>>
  try {
    dispute = await db.$transaction(async (tx: Tx) => {
      const newDispute = await tx.dispute.create({
        data: { tradeId, openedById, reason, description },
      })

      await tx.trade.update({
        where: { id: tradeId },
        data: { status: 'disputed' },
      })

      return newDispute
    })
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AppError('CONFLICT', 'A dispute already exists for this trade', 409)
    }
    throw err
  }

  const otherPartyId = openedById === trade.buyerId ? trade.sellerId : trade.buyerId
  await postTradeSystemMessage(tradeId, openedById, `A dispute was opened. Reason: ${reason}. An admin will review.`)
  notify(otherPartyId, 'dispute', 'Dispute Opened', `A dispute has been opened on your trade. Reason: ${reason}`, { tradeId, disputeId: dispute.id }, tradeId)
  notify(openedById, 'dispute', 'Dispute Submitted', 'Your dispute has been submitted and will be reviewed by an admin.', { tradeId, disputeId: dispute.id }, tradeId)
  createAdminNotif({ category: 'DISPUTE', title: 'New Dispute Opened', body: `Dispute on Trade #${trade.orderRef}: ${reason}`, href: `/admin/disputes` })

  void closeEpisode({ market: 'usdt', tradeId, outcome: 'disputed' })

  return dispute
}

/**
 * Post a system (auto) message into a trade's chat thread on a step transition.
 * Best-effort: a failure here must never break the trade action, so we swallow
 * errors. senderId is the actor who triggered the step (the isSystem flag is what
 * makes it render as a centered status line, not a party's bubble). No push/bell
 * notification is fired — step notifications are already sent separately.
 */
export async function postTradeSystemMessage(tradeId: string, senderId: string, message: string) {
  try {
    await db.tradeMessage.create({ data: { tradeId, senderId, message, isSystem: true } })
  } catch (err) {
    logger.error({ err, tradeId }, 'Failed to post trade system message')
  }
}

export async function sendMessage(
  tradeId: string,
  senderId: string,
  content: string,
  attachmentUrl?: string,
) {
  const [trade, sender] = await Promise.all([
    db.trade.findUnique({ where: { id: tradeId } }),
    db.user.findUnique({ where: { id: senderId }, select: { username: true } }),
  ])
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)

  // Sender must be buyer, seller — admin check done via role in route
  const isParticipant = trade.buyerId === senderId || trade.sellerId === senderId
  if (!isParticipant) throw new AppError('FORBIDDEN', 'Not a participant in this trade', 403)

  const msg = await db.tradeMessage.create({
    data: {
      tradeId,
      senderId,
      message: content,
      attachmentUrl: attachmentUrl ?? null,
    },
  })

  // Notify the other party. The in-app bell always updates live (SSE), but we
  // COALESCE the device buzz: the first message in a trade buzzes their phone,
  // then we go quiet for 5 minutes so a rapid back-and-forth negotiation can't
  // fire 20+ push/Telegram alerts. A fresh buzz resumes once the window lapses.
  const recipientId = trade.buyerId === senderId ? trade.sellerId : trade.buyerId
  const senderLabel = sender?.username ?? 'Someone'
  const preview = content.length > 60 ? content.slice(0, 57) + '…' : content

  // SET NX EX = atomically "claim" the buzz slot; succeeds only if no key exists.
  // null reply ⇒ a buzz already fired within the window ⇒ deliver silently.
  const buzzKey = `notif:chatbuzz:${recipientId}:${tradeId}`
  const claimed = await redis.set(buzzKey, '1', 'EX', 300, 'NX').catch(() => 'OK')
  const silent = claimed === null

  // Chat messages are NOT important enough for a Telegram DM (too frequent →
  // raises block/report rates). Web push + in-app bell only; telegram: false
  // force-excludes them even though they share type 'trade'.
  notify(recipientId, 'trade', 'New Message', `${senderLabel}: ${preview}`, { tradeId }, tradeId, undefined, { silent, telegram: false })

  return msg
}

export async function sendMessageAsAdmin(
  tradeId: string,
  senderId: string,
  content: string,
  attachmentUrl?: string,
) {
  const trade = await db.trade.findUnique({ where: { id: tradeId } })
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)

  return db.tradeMessage.create({
    data: {
      tradeId,
      senderId,
      message: content,
      attachmentUrl: attachmentUrl ?? null,
    },
  })
}

export async function getMessages(tradeId: string, userId: string, role: string) {
  const trade = await db.trade.findUnique({ where: { id: tradeId } })
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)

  const isAdmin = ['admin', 'super_admin', 'dispute_agent'].includes(role)
  const isParticipant = trade.buyerId === userId || trade.sellerId === userId

  if (!isAdmin && !isParticipant) {
    throw new AppError('FORBIDDEN', 'Not authorized to view messages', 403)
  }

  return db.tradeMessage.findMany({
    where: { tradeId },
    orderBy: { createdAt: 'asc' },
    include: {
      // We store senderId but can join for display info
    },
  })
}

export async function rateTrade(
  tradeId: string,
  raterId: string,
  rating: number,
  comment: string,
  tags: string[],
) {
  if (rating < 1 || rating > 5) throw new AppError('VALIDATION_ERROR', 'Rating must be between 1 and 5', 400)

  const trade = await db.trade.findUnique({ where: { id: tradeId } })
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)
  if (trade.status !== 'crypto_released') {
    throw new AppError('INVALID_STATUS', 'Trade must be completed before rating', 400)
  }

  // Ratings are only accepted within RATING_WINDOW_MINUTES of completion.
  const ratingAnchor = trade.releasedAt ?? trade.updatedAt
  if (Date.now() - ratingAnchor.getTime() > RATING_WINDOW_MINUTES * 60_000) {
    throw new AppError(
      'RATING_WINDOW_CLOSED',
      `The ${RATING_WINDOW_MINUTES}-minute rating window for this trade has closed.`,
      400,
    )
  }

  const isBuyer = trade.buyerId === raterId
  const isSeller = trade.sellerId === raterId
  if (!isBuyer && !isSeller) throw new AppError('FORBIDDEN', 'Only trade participants can rate', 403)

  // Check for duplicate rating
  const existing = await db.tradeRating.findUnique({
    where: { tradeId_ratedByUserId: { tradeId, ratedByUserId: raterId } },
  })
  if (existing) throw new AppError('CONFLICT', 'You have already rated this trade', 409)

  const rateeId = isBuyer ? trade.sellerId : trade.buyerId

  const tradeRating = await db.tradeRating.create({
    data: {
      tradeId,
      ratedByUserId: raterId,
      ratedUserId: rateeId,
      rating,
      comment,
      tags,
    },
  })

  // Update ratee's avgRating in TradeStats — aggregate in the DB rather than
  // pulling every rating row into memory (unbounded as a user accrues reviews).
  const agg = await db.tradeRating.aggregate({
    where: { ratedUserId: rateeId },
    _avg: { rating: true },
    _count: { _all: true },
  })
  const totalRatings = agg._count._all
  const avgRating = agg._avg.rating ?? 0

  await db.tradeStats.upsert({
    where: { userId: rateeId },
    create: {
      userId: rateeId,
      avgRating: new Prisma.Decimal(avgRating.toFixed(2)),
      totalReviews: totalRatings,
    },
    update: {
      avgRating: new Prisma.Decimal(avgRating.toFixed(2)),
      totalReviews: totalRatings,
    },
  })

  // Resolve usernames for admin notification
  const [rater, ratee] = await Promise.all([
    db.user.findUnique({ where: { id: raterId }, select: { username: true } }),
    db.user.findUnique({ where: { id: rateeId }, select: { username: true } }),
  ])
  createAdminNotif({
    category: 'TRADE',
    title: 'Rating Submitted',
    body: `${rater?.username ?? raterId} rated ${ratee?.username ?? rateeId} ${rating}★ on Trade #${trade.orderRef}${comment ? `: "${comment}"` : ''}`,
    href: `/admin/ratings`,
  })

  // Tell the rated trader they received a review (bell + push; not a Telegram DM
  // per the minimal-DM policy — reviews aren't a money/security event).
  notify(
    rateeId,
    'rating',
    'New review received ⭐',
    `${rater?.username ?? 'A trader'} rated you ${rating}★ on trade #${trade.orderRef}${comment ? `: "${comment}"` : ''}`,
    { tradeId, rating },
    undefined,
    `/profile/${ratee?.username ?? ''}#reviews`,
  )

  return tradeRating
}

export async function getTrades(userId: string, params: GetTradesParams) {
  const page = params.page ?? 1
  const limit = Math.min(params.limit ?? 20, 50)
  const skip = (page - 1) * limit

  const statusFilter = params.status
    ? { status: params.status as 'payment_pending' | 'payment_uploaded' | 'payment_confirmed' | 'crypto_sent' | 'crypto_released' | 'cancelled' | 'disputed' }
    : {}

  let where: Prisma.TradeWhereInput

  if (params.role === 'buyer') {
    where = { buyerId: userId, ...statusFilter }
  } else if (params.role === 'seller') {
    where = { sellerId: userId, ...statusFilter }
  } else {
    where = { OR: [{ buyerId: userId }, { sellerId: userId }], ...statusFilter }
  }

  const [items, total] = await Promise.all([
    db.trade.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        ad: { select: { id: true, side: true, coin: true, network: true } },
        buyer: { select: { id: true, username: true, fullName: true, avatarUrl: true } },
        seller: { select: { id: true, username: true, fullName: true, avatarUrl: true } },
      },
    }),
    db.trade.count({ where }),
  ])

  return { items, total, page, limit, totalPages: Math.ceil(total / limit) }
}

export async function getTradeById(tradeId: string, userId: string, role: string) {
  const trade = await db.trade.findUnique({
    where: { id: tradeId },
    include: {
      ad: true,
      buyer: {
        select: {
          id: true, username: true, fullName: true, kycStatus: true, kycLevel: true, avatarUrl: true,
          tradeStats: { select: { badge: true, badgeLabel: true, trustScore: true, completedTrades: true, completionRate: true } },
        },
      },
      seller: {
        select: {
          id: true, username: true, fullName: true, kycStatus: true, kycLevel: true, avatarUrl: true,
          tradeStats: { select: { badge: true, badgeLabel: true, trustScore: true, completedTrades: true, completionRate: true } },
        },
      },
      messages: { orderBy: { createdAt: 'asc' } },
      dispute: true,
      ratings: true,
    },
  })

  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)

  const isAdmin = ['admin', 'super_admin', 'dispute_agent'].includes(role)
  const isParticipant = trade.buyerId === userId || trade.sellerId === userId

  if (!isAdmin && !isParticipant) {
    throw new AppError('FORBIDDEN', 'Not authorized to view this trade', 403)
  }

  // Check if the requesting user has already rated this trade
  const ratedByMeRecord = await db.tradeRating.findUnique({
    where: { tradeId_ratedByUserId: { tradeId, ratedByUserId: userId } },
    select: { id: true },
  })

  // Seller's receiving account so the buyer sees where to pay. Prefer the
  // immutable snapshot captured at creation; fall back to read-time resolution
  // for legacy trades created before the snapshot column existed. Only trade
  // participants reach this point (auth check above).
  const snap = trade.sellerPaymentSnapshot as { label?: string; accountName?: string } | null
  let paymentMethodLabel: string
  let sellerPaymentAccount: unknown
  if (snap && typeof snap === 'object' && typeof snap.accountName === 'string') {
    sellerPaymentAccount = snap
    paymentMethodLabel = snap.label ?? trade.paymentMethod
  } else {
    const resolvedPm = await resolveSellerPaymentAccount(trade.paymentMethod, trade.sellerId)
    paymentMethodLabel = resolvedPm.label
    sellerPaymentAccount = resolvedPm.account
  }

  // Combined buyer↔seller streak (USDT + CTM) for the trust header.
  const streak = await getTradeStreak(trade.buyerId, trade.sellerId)

  return {
    ...trade,
    ratedByMe: !!ratedByMeRecord,
    paymentMethodLabel,
    sellerPaymentAccount,
    streakCount: streak.count,
  }
}
