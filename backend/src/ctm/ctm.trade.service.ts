import { db } from '../lib/prisma'
import { AppError } from '../lib/errors'
import { assertTokenAddressFormat } from './ctm.address'
import { computeMerchantTier } from './ctm.tier'
import { Prisma } from '@prisma/client'
import { decrementLockedAmount } from './ctm.listing.service'
import { queues } from '../queues/definitions'
import { verifyTradeTx, HARD_REJECT_STATUSES, ADMIN_REVIEW_STATUSES, RELEASE_ALLOWED_STATUSES } from '../services/blockchainVerification.service'
import { logger } from '../lib/logger'
import { generateCtmDisplayRef } from './ctm.ref'
import { notify as centralNotify } from '../lib/notify'
import { FLAGS, isFlagEnabled, getNumberConfig } from '../services/platformFlags.service'
import { getBondConfig, lockMakerBondTx, releaseMakerBond, resolveBondOnDispute } from '../services/makerBond.service'
import { recordAuditLog } from '../lib/audit'
import { createAdminNotif } from '../services/adminNotification.service'
import { assertCanOpenTrade, isTradeLimitBypassed } from '../services/tradeConcurrency.service'
import { isTakerFirstForMarket } from '../services/settlementMode.service'
import { ctmStepForAction, ctmDisputeLock } from '../services/ctmSettlementFlow'
import {
  ladderStatus, isResumingUnderDispute, advanceTo, claimRung,
  assertPartySettleable, settleDisputeOnCompletion,
} from '../services/disputeResume'
import { openEpisode, closeEpisode, bumpThreadForTradeMessage } from '../services/chatThread.service'
import { incrementTradeStreak, getTradeStreak, ordinal } from '../services/tradeStreak.service'
import { awardTradePointsTx, clawbackTradePoints } from '../services/airdrop.service'

type JsonValue = Prisma.InputJsonValue
type Tx = Prisma.TransactionClient

const ACTIVE_STATUSES = ['awaiting_payment', 'payment_uploaded', 'payment_confirmed', 'seller_transferring', 'proof_submitted', 'buyer_confirming'] as const

// Delegate to the central notifier so CTM events fire SSE + web-push (not just a
// DB row). The push deep-links into the CTM trade room via metadata.tradeRef.
function notify(userId: string, type: string, title: string, body: string, metadata: Record<string, unknown>) {
  const tradeRef = typeof metadata.tradeRef === 'string' ? metadata.tradeRef : undefined
  centralNotify(userId, type, title, body, metadata, undefined, tradeRef ? `/ctm/trade/${tradeRef}` : undefined)
}

/** Human-readable trade label for user-facing text — never exposes the raw cuid. */
function refLabel(displayRef: string | null | undefined): string {
  return displayRef ?? 'your CTM trade'
}

/**
 * Opening system message posted into a freshly-created CTM trade chat — mirrors
 * the USDT marketplace's "Trade created…" message and adds the off-platform
 * safety basics (CTM settles peer-to-peer, so the platform holds no funds). If
 * the listing carries custom terms they are posted as a second line.
 */
export async function postCtmOpeningMessages(tradeId: string, senderId: string, terms?: string | null) {
  await postCtmSystemMessage(
    tradeId,
    senderId,
    'Trade started. Buyer: send the PKR payment to the seller’s account from your OWN account, then upload payment proof within the trade window. Seller: only confirm after the payment has actually arrived, then send the tokens. Keep all communication in this chat.',
  )
  const t = terms?.trim()
  if (t) await postCtmSystemMessage(tradeId, senderId, `Merchant’s terms: ${t}`)
}

function isParticipant(trade: { buyerId: string; sellerId: string }, userId: string, role: string) {
  return trade.buyerId === userId || trade.sellerId === userId || role === 'admin' || role === 'super_admin'
}

export async function getMyTrades(userId: string, filters: { status?: string; role?: string; page?: number; limit?: number } = {}) {
  const { status, role, page = 1, limit = 20 } = filters
  const skip = (page - 1) * limit

  const roleFilter = role === 'buyer' ? { buyerId: userId } : role === 'seller' ? { sellerId: userId } : { OR: [{ buyerId: userId }, { sellerId: userId }] }
  const where: Record<string, unknown> = { ...roleFilter }
  if (status) where.status = status

  const [trades, total] = await Promise.all([
    db.ctmTrade.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        token: { select: { id: true, slug: true, name: true, symbol: true, logoUrl: true } },
        buyer: { select: { id: true, username: true } },
        seller: { select: { id: true, username: true } },
        listing: { select: { id: true } },
      },
    }),
    db.ctmTrade.count({ where }),
  ])

  return { trades, total, page, limit, totalPages: Math.ceil(total / limit) }
}

export async function getTradeByRef(tradeRef: string, userId: string, role: string) {
  const trade = await db.ctmTrade.findUnique({
    where: { tradeRef },
    include: {
      token: true,
      buyer: { select: { id: true, username: true, fullName: true } },
      seller: { select: { id: true, username: true, fullName: true } },
      listing: true,
      request: true,
      proofs: { orderBy: { createdAt: 'asc' } },
      dispute: { include: { messages: { orderBy: { createdAt: 'asc' } } } },
      ratings: true,
    },
  })
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)
  if (!isParticipant(trade, userId, role)) throw new AppError('FORBIDDEN', 'Access denied', 403)
  const ratedByMeRecord = await db.ctmTradeRating.findFirst({ where: { tradeId: trade.id, ratedByUserId: userId } })

  // Admins also get the trade's audit trail (CTM audit logs key on tradeRef in metadata).
  let auditLogs: Array<{ id: string; action: string; actorId: string; createdAt: Date }> = []
  if (role === 'admin' || role === 'super_admin') {
    auditLogs = await db.auditLog.findMany({
      where: { action: { startsWith: 'CTM_' }, metadata: { path: ['tradeRef'], equals: tradeRef } },
      orderBy: { createdAt: 'desc' }, take: 50,
      select: { id: true, action: true, actorId: true, createdAt: true },
    }).catch(() => [])
  }

  // Combined buyer↔seller streak (shared with USDT P2P) for the trust header.
  const streak = await getTradeStreak(trade.buyerId, trade.sellerId)

  return { ...trade, ratedByMe: !!ratedByMeRecord, auditLogs, streakCount: streak.count }
}

export async function uploadPaymentProof(tradeRef: string, buyerId: string, fileUrl: string, fileHash: string) {
  const trade = await db.ctmTrade.findUnique({ where: { tradeRef }, include: { dispute: { select: { status: true } } } })
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)
  if (trade.buyerId !== buyerId) throw new AppError('FORBIDDEN', 'Only buyer can upload payment proof', 403)
  // send_fiat is always the BUYER's action. Its ladder position depends on the flow:
  // classic awaiting_payment→payment_uploaded (first step); taker-first
  // seller_transferring→proof_submitted (the maker pays after the taker's crypto is
  // confirmed). Never terminal. Classic == the original literal, so behavior is
  // byte-identical until a market's taker-first readiness flips.
  const step = ctmStepForAction(trade.takerFirst, 'send_fiat')
  // Dispute-resume: compare against the REAL rung, which for a disputed trade lives
  // in disputeResumeStatus (see disputeResume.ts). Identical to `status` otherwise.
  if (ladderStatus(trade) !== step.from) throw new AppError('CONFLICT', `Cannot upload proof in status: ${ladderStatus(trade)}`, 409)
  assertPartySettleable(trade, trade.dispute)

  const duplicate = await db.ctmTradeProof.findFirst({ where: { tradeId: trade.id, fileHash } })
  if (duplicate) throw new AppError('CONFLICT', 'This file has already been uploaded', 409)

  const proofDeadlineAt = new Date(Date.now() + 60 * 60 * 1000) // seller has 1h to confirm

  await db.$transaction(async (tx: Tx) => {
    const claimed = await tx.ctmTrade.updateMany({
      where: { id: trade.id, ...claimRung(trade, step.from) },
      data: { ...advanceTo(trade, step.to), paymentProofUrl: fileUrl, paymentProofHash: fileHash, proofDeadlineAt },
    })
    if (claimed.count === 0) throw new AppError('CONFLICT', 'Trade status changed — reload and try again.', 409)
    await tx.ctmTradeProof.create({
      data: { tradeId: trade.id, uploadedBy: buyerId, proofType: 'screenshot', fileUrl, fileHash, description: 'Payment proof' },
    })
  })

  await postCtmSystemMessage(trade.id, buyerId, 'Payment proof uploaded. Waiting for the seller to confirm the payment was received.')
  notify(trade.sellerId, 'CTM_PAYMENT_UPLOADED', 'Payment proof uploaded', 'Buyer has uploaded payment proof. Please confirm receipt.', { tradeRef })
}

export async function confirmPayment(tradeRef: string, sellerId: string) {
  const trade = await db.ctmTrade.findUnique({ where: { tradeRef }, include: { dispute: { select: { status: true } } } })
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)
  if (trade.sellerId !== sellerId) throw new AppError('FORBIDDEN', 'Only seller can confirm payment', 403)
  // confirm_fiat is always the SELLER's action (they receive the PKR). Classic:
  // payment_uploaded→payment_confirmed, then the seller sends tokens. Taker-first:
  // proof_submitted→completed — the TERMINAL step (the taker confirms the maker's
  // fiat, after the taker's crypto already settled first). Classic behavior is
  // byte-identical until readiness flips.
  const step = ctmStepForAction(trade.takerFirst, 'confirm_fiat')
  if (ladderStatus(trade) !== step.from) throw new AppError('CONFLICT', `Cannot confirm payment in status: ${ladderStatus(trade)}`, 409)
  assertPartySettleable(trade, trade.dispute)

  // Taker-first: this is terminal — the seller (taker) confirms the maker's fiat
  // arrived and the trade completes (the maker's tokens were already delivered).
  if (step.terminal) return finalizeCtmTrade(tradeRef)

  const advanced = await db.ctmTrade.updateMany({
    where: { id: trade.id, ...claimRung(trade, step.from) },
    data: { ...advanceTo(trade, step.to), proofDeadlineAt: null },
  })
  if (advanced.count === 0) throw new AppError('CONFLICT', 'Trade status changed — reload and try again.', 409)
  await postCtmSystemMessage(trade.id, sellerId, 'Seller confirmed the payment was received. The seller will now send the tokens.')
  notify(trade.buyerId, 'CTM_PAYMENT_CONFIRMED', 'Payment confirmed', 'Seller confirmed your payment. They will now send the tokens.', { tradeRef })
}

export async function markSellerTransferring(tradeRef: string, sellerId: string) {
  const trade = await db.ctmTrade.findUnique({ where: { tradeRef }, include: { dispute: { select: { status: true } } } })
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)
  if (trade.sellerId !== sellerId) throw new AppError('FORBIDDEN', 'Only seller can mark transfer started', 403)
  // start_crypto is always the SELLER's action (first of the two crypto-send steps).
  // Classic: payment_confirmed→seller_transferring (after fiat is confirmed).
  // Taker-first: awaiting_payment→payment_uploaded (the FIRST step — the taker sends
  // crypto before any fiat moves). Never terminal.
  const step = ctmStepForAction(trade.takerFirst, 'start_crypto')
  if (ladderStatus(trade) !== step.from) throw new AppError('CONFLICT', `Cannot mark transferring in status: ${ladderStatus(trade)}`, 409)
  assertPartySettleable(trade, trade.dispute)

  const proofDeadlineAt = new Date(Date.now() + 2 * 60 * 60 * 1000) // 2h to submit token proof

  const advanced = await db.ctmTrade.updateMany({
    where: { id: trade.id, ...claimRung(trade, step.from) },
    data: { ...advanceTo(trade, step.to), proofDeadlineAt },
  })
  if (advanced.count === 0) throw new AppError('CONFLICT', 'Trade status changed — reload and try again.', 409)
  await postCtmSystemMessage(trade.id, sellerId, 'Seller has started sending the tokens.')
  notify(trade.buyerId, 'CTM_SELLER_TRANSFERRING', 'Seller is transferring tokens', 'Seller has started the token transfer. Watch for incoming tokens.', { tradeRef })
}

export async function uploadTokenProof(tradeRef: string, sellerId: string, proofData: {
  fileUrl?: string
  fileHash?: string
  txHash?: string
  description?: string
  proofType: 'screenshot' | 'txhash' | 'uid_receipt' | 'video' | 'other'
}) {
  const trade = await db.ctmTrade.findUnique({
    where: { tradeRef },
    include: {
      token: { select: { symbol: true, network: true, contractAddress: true, settlementType: true } },
      dispute: { select: { status: true } },
    },
  })
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)
  if (trade.sellerId !== sellerId) throw new AppError('FORBIDDEN', 'Only seller can upload token proof', 403)
  // prove_crypto is always the SELLER's action (second crypto-send step, with
  // on-chain verification below). Classic: seller_transferring→proof_submitted.
  // Taker-first: payment_uploaded→payment_confirmed (the second step — verification
  // rides the action, so it moves to the front of the ladder). Never terminal.
  const step = ctmStepForAction(trade.takerFirst, 'prove_crypto')
  if (ladderStatus(trade) !== step.from) throw new AppError('CONFLICT', `Cannot upload token proof in status: ${ladderStatus(trade)}`, 409)
  assertPartySettleable(trade, trade.dispute)

  // ── On-chain verification for txhash proofs on ON_CHAIN settlements ──────────
  let txVerificationStatus: string | undefined
  let txVerificationDetails: Record<string, unknown> | undefined

  // Only on-chain-capable settlements verify the hash against a wallet. MANUAL
  // (exchange-UID / off-chain) settlements have no on-chain wallet to match —
  // verifying a "reference" against a UID would falsely reject the proof.
  const onChainCapable = trade.settlementType === 'ON_CHAIN' || trade.settlementType === 'HYBRID'

  if (proofData.proofType === 'txhash' && proofData.txHash && trade.token.network && onChainCapable) {
    const txHashNorm = proofData.txHash.trim().toLowerCase()

    // Duplicate guard across CTM proofs
    const dupeProof = await db.ctmTradeProof.findFirst({
      where: { txHash: txHashNorm, trade: { id: { not: trade.id } } },
      select: { tradeId: true },
    })
    if (dupeProof) {
      throw new AppError(
        'DUPLICATE_TX_HASH',
        'This transaction hash has already been submitted as proof for another trade',
        400,
      )
    }

    // Buyer's receiving address comes from buyerSettlementId (ON_CHAIN trades)
    const buyerWallet = trade.buyerSettlementId ?? ''

    if (buyerWallet) {
      try {
        const result = await verifyTradeTx(
          txHashNorm,
          trade.token.symbol,
          trade.token.network,
          trade.tokenAmount,
          buyerWallet,
        )
        txVerificationStatus = result.status
        txVerificationDetails = result.details

        logger.info(
          { tradeRef, txHash: txHashNorm, verificationStatus: result.status },
          'CTM uploadTokenProof: blockchain verification result',
        )

        if (HARD_REJECT_STATUSES.includes(result.status)) {
          const msgs: Record<string, string> = {
            reverted: 'Transaction was reverted on-chain — no tokens transferred.',
            mismatch_receiver: `Transaction sends to wrong address. ${result.message}`,
            mismatch_amount: `Amount sent is below the trade amount. ${result.message}`,
            not_found: 'Transaction not found on chain. Ensure it is confirmed and resubmit.',
            pending: 'Transaction is not yet confirmed. Wait for confirmation and resubmit.',
            failed: result.message,
          }
          throw new AppError('TX_VERIFICATION_FAILED', msgs[result.status] ?? result.message, 400)
        }
      } catch (err) {
        if (err instanceof AppError) throw err
        logger.warn({ err, tradeRef, txHash: txHashNorm }, 'CTM uploadTokenProof: verifier threw unexpectedly')
        txVerificationStatus = 'rpc_error'
      }
    } else {
      txVerificationStatus = 'skipped'
      txVerificationDetails = { reason: 'no_buyer_settlement_address' }
    }
  }

  const confirmDeadlineAt = new Date(Date.now() + 30 * 60 * 1000)

  await db.$transaction(async (tx: Tx) => {
    const claimed = await tx.ctmTrade.updateMany({
      where: { id: trade.id, ...claimRung(trade, step.from) },
      data: { ...advanceTo(trade, step.to), confirmDeadlineAt, proofDeadlineAt: null },
    })
    if (claimed.count === 0) throw new AppError('CONFLICT', 'Trade status changed — reload and try again.', 409)
    await tx.ctmTradeProof.create({
      data: {
        tradeId: trade.id,
        uploadedBy: sellerId,
        proofType: proofData.proofType,
        fileUrl: proofData.fileUrl ?? null,
        fileHash: proofData.fileHash ?? null,
        txHash: proofData.txHash ? proofData.txHash.trim().toLowerCase() : null,
        txVerificationStatus: txVerificationStatus ?? null,
        txVerificationDetails: (txVerificationDetails as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        description: proofData.description ?? 'Token transfer proof',
      },
    })
  })

  await postCtmSystemMessage(trade.id, sellerId, `Seller submitted transfer proof for ${trade.tokenAmount} tokens. Buyer, check your wallet and confirm receipt within 30 minutes.`)
  notify(trade.buyerId, 'CTM_TOKEN_PROOF_SUBMITTED', 'Seller submitted transfer proof', 'Check your wallet and confirm receipt within 30 minutes.', { tradeRef })
}

export async function confirmReceipt(tradeRef: string, buyerId: string) {
  const trade = await db.ctmTrade.findUnique({
    where: { tradeRef },
    include: {
      proofs: { orderBy: { createdAt: 'desc' }, take: 1 },
      dispute: { select: { status: true } },
    },
  })
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)
  if (trade.buyerId !== buyerId) throw new AppError('FORBIDDEN', 'Only buyer can confirm receipt', 403)
  // confirm_crypto is always the BUYER's action (they receive the tokens). Classic:
  // proof_submitted→completed — the TERMINAL step (buyer confirms and the trade
  // completes). Taker-first: payment_confirmed→seller_transferring — a NON-terminal
  // acknowledgement (the maker confirms the taker's crypto arrived, then pays fiat).
  // Classic byte-identical until a market's taker-first readiness flips.
  const step = ctmStepForAction(trade.takerFirst, 'confirm_crypto')
  if (ladderStatus(trade) !== step.from) throw new AppError('CONFLICT', `Cannot confirm receipt in status: ${ladderStatus(trade)}`, 409)
  assertPartySettleable(trade, trade.dispute)

  // Verification gate — rides the confirm_crypto action in BOTH flows (the token
  // proof was submitted in the immediately-preceding prove_crypto step). Check the
  // latest txhash proof's verification status.
  const latestProof = trade.proofs[0]
  if (latestProof?.proofType === 'txhash' && latestProof.txVerificationStatus) {
    const vs = latestProof.txVerificationStatus
    if (!RELEASE_ALLOWED_STATUSES.includes(vs as never) && !ADMIN_REVIEW_STATUSES.includes(vs as never)) {
      throw new AppError(
        'TX_NOT_VERIFIED',
        `Cannot confirm receipt — transaction proof verification status is "${vs}". The transaction was rejected. Ask the seller to resubmit a valid transaction.`,
        400,
      )
    }
    if (ADMIN_REVIEW_STATUSES.includes(vs as never)) {
      throw new AppError(
        'TX_PENDING_REVIEW',
        'Cannot confirm receipt — this trade is pending admin verification of the transaction hash.',
        400,
      )
    }
  }

  // Taker-first: non-terminal — the maker/buyer acknowledges the taker's crypto
  // arrived; advance so the maker can now send the PKR payment. (CAS-guarded on the
  // expected `from` status so concurrent transitions can't both apply.) Set a
  // proofDeadlineAt for the maker's fiat payment so runCtmProofDeadline auto-escalates
  // a no-show — parity with the seller's deliver steps in the classic flow.
  if (!step.terminal) {
    const payDeadlineAt = new Date(Date.now() + 60 * 60 * 1000) // maker has 1h to pay + upload proof
    const advanced = await db.ctmTrade.updateMany({
      where: { id: trade.id, ...claimRung(trade, step.from) },
      data: { ...advanceTo(trade, step.to), proofDeadlineAt: payDeadlineAt },
    })
    if (advanced.count === 0) throw new AppError('CONFLICT', `Cannot confirm receipt in status: ${ladderStatus(trade)}`, 409)
    await postCtmSystemMessage(trade.id, buyerId, 'Buyer confirmed the tokens were received. Buyer: now send the PKR payment and upload proof within the trade window.')
    notify(trade.sellerId, 'CTM_CRYPTO_CONFIRMED', 'Tokens confirmed received', 'The buyer confirmed your tokens arrived and will now send the PKR payment.', { tradeRef })
    return
  }

  // Classic: terminal — buyer confirms receipt → complete the trade.
  return finalizeCtmTrade(tradeRef)
}

/**
 * Terminal completion for a CTM trade — the proof_submitted→completed transition
 * plus all its side effects (token / merchant / global stats, tier auto-promotion,
 * mutual streak, airdrop points, bond release, badges, messages, notifications).
 *
 * The terminal step is the SAME ladder rung in both flows (proof_submitted →
 * completed); only the action that triggers it differs — classic = the buyer's
 * confirm_crypto (confirmReceipt); taker-first = the seller/taker's confirm_fiat
 * (confirmPayment). So this is caller-authorized (the calling endpoint already
 * verified the acting party) and re-guards the status under a CAS claim shared with
 * the auto-complete job (ctm.jobs.ts).
 */
async function finalizeCtmTrade(tradeRef: string) {
  const trade = await db.ctmTrade.findUnique({ where: { tradeRef }, include: { dispute: { select: { status: true } } } })
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)
  const buyerId = trade.buyerId
  // Dispute-resume: a trade can reach the terminal rung with a dispute still open —
  // the parties settled it themselves. Completing is the ONE thing that closes such
  // a dispute (see disputeResume.ts: acting is a self-claim, completing is evidence).
  const wasDisputed = isResumingUnderDispute(trade)
  let disputeSettled = false

  // Set inside the tx if the seller's merchant tier is auto-promoted on completion;
  // used after commit to notify them.
  let promotedTo: string | null = null
  let streakResult: { count: number; isMilestone: boolean } = { count: 0, isMilestone: false }

  await db.$transaction(async (tx: Tx) => {
    // CAS guard: only the transition OUT OF proof_submitted may complete the trade.
    // The status was checked before the tx, but the auto-complete job (ctm.jobs.ts)
    // can complete the same proof_submitted trade the instant confirmDeadlineAt passes.
    // Without this guard both paths would run, double-counting the streak + token /
    // merchant stats. If the row already moved on, abort the whole tx.
    const claimed = await tx.ctmTrade.updateMany({
      where: { id: trade.id, ...claimRung(trade, 'proof_submitted') },
      data: { ...advanceTo(trade, 'completed', { terminal: true }), completedAt: new Date(), confirmDeadlineAt: null },
    })
    if (claimed.count === 0) {
      throw new AppError('CONFLICT', 'This trade was already completed.', 409)
    }

    // Close an open dispute as no-fault, inside the SAME tx — the `status: 'open'`
    // filter is the CAS that makes an admin ruling and a party settlement mutually
    // exclusive. No winner, no bond seizure, no points clawback; the row survives.
    if (wasDisputed) disputeSettled = await settleDisputeOnCompletion(tx, 'ctm', trade.id)

    // Update token stats
    await tx.ctmToken.update({
      where: { id: trade.tokenId },
      data: {
        totalTrades: { increment: 1 },
        totalVolumePkr: { increment: trade.fiatAmount },
        lastTradedAt: new Date(),
      },
    })

    // Update listing on completion: permanently reduce locked + total (do NOT restore availableAmount)
    if (trade.listingId) {
      await tx.ctmListing.update({
        where: { id: trade.listingId },
        data: {
          lockedAmount: { decrement: trade.tokenAmount },
          totalAmount: { decrement: trade.tokenAmount },
        },
      })
    }

    // Update merchant stats
    await tx.ctmMerchantProfile.updateMany({
      where: { userId: trade.sellerId },
      data: {
        totalCtmTrades: { increment: 1 },
        completedCtmTrades: { increment: 1 },
      },
    })

    // Auto-promote the seller's merchant tier based on their (now-updated) clean
    // track record — climbing tiers raises their per-trade cap. Promotion only;
    // never demotes (admins can still set tiers manually). Skipped silently if the
    // user isn't a registered CTM merchant.
    const sellerProfile = await tx.ctmMerchantProfile.findUnique({
      where: { userId: trade.sellerId },
      select: { id: true, tier: true, completedCtmTrades: true, disputedCtmTrades: true, totalCtmTrades: true },
    })
    if (sellerProfile) {
      const nextTier = computeMerchantTier({
        completedCtmTrades: sellerProfile.completedCtmTrades,
        disputedCtmTrades: sellerProfile.disputedCtmTrades,
        totalCtmTrades: sellerProfile.totalCtmTrades,
        currentTier: sellerProfile.tier,
      })
      if (nextTier !== sellerProfile.tier) {
        await tx.ctmMerchantProfile.update({ where: { id: sellerProfile.id }, data: { tier: nextTier } })
        promotedTo = nextTier
      }
    }

    // Update global TradeStats for buyer and seller so leaderboard reflects CTM trades
    for (const userId of [buyerId, trade.sellerId]) {
      const existing = await tx.tradeStats.findUnique({ where: { userId } })
      if (!existing) {
        await tx.tradeStats.create({
          data: {
            userId,
            totalTrades: 1,
            completedTrades: 1,
            completionRate: new Prisma.Decimal(1),
            totalVolumePKR: trade.fiatAmount,
          },
        })
      } else {
        const newTotal = existing.totalTrades + 1
        const newCompleted = existing.completedTrades + 1
        await tx.tradeStats.update({
          where: { userId },
          data: {
            totalTrades: newTotal,
            completedTrades: newCompleted,
            completionRate: new Prisma.Decimal(newCompleted).div(new Prisma.Decimal(newTotal)),
            totalVolumePKR: { increment: trade.fiatAmount },
          },
        })
      }
    }

    // Bump the combined buyer↔seller streak (shared with USDT P2P), atomic with completion.
    streakResult = await incrementTradeStreak(tx, buyerId, trade.sellerId)

    // Award airdrop points to both sides (idempotent; no-op when the flag is off).
    await awardTradePointsTx(tx, { tradeType: 'ctm', tradeId: trade.id, buyerId, sellerId: trade.sellerId, fiatAmountPKR: trade.fiatAmount })
  })

  // Trade completed cleanly → release the maker's bond (idempotent; no-op when off).
  await releaseMakerBond({ tradeType: 'ctm', tradeId: trade.id }).catch((err) =>
    logger.error({ err, tradeId: trade.id }, 'Failed to release maker bond after CTM completion'),
  )

  queues.badgeRecalculate.add('recalc', { userId: buyerId }).catch(() => {})
  queues.badgeRecalculate.add('recalc', { userId: trade.sellerId }).catch(() => {})

  await postCtmSystemMessage(trade.id, buyerId, 'Trade complete — the buyer confirmed receipt of the tokens. 🎉')

  // The parties settled the dispute themselves — tell both sides and the admin so
  // nobody keeps working a closed case. The dispute stays on record as escalated.
  if (disputeSettled) {
    await postCtmSystemMessage(trade.id, buyerId, 'Dispute closed automatically — both sides delivered and the trade completed. No admin ruling was needed.')
    const meta = { tradeRef, displayRef: trade.displayRef, dispute: true }
    notify(trade.buyerId, 'CTM_DISPUTE_RESOLVED', 'Dispute closed — trade completed', `You and your counterparty settled trade ${refLabel(trade.displayRef)} directly, so the dispute closed with no ruling against either side.`, meta)
    notify(trade.sellerId, 'CTM_DISPUTE_RESOLVED', 'Dispute closed — trade completed', `You and your counterparty settled trade ${refLabel(trade.displayRef)} directly, so the dispute closed with no ruling against either side.`, meta)
    createAdminNotif({ category: 'DISPUTE', title: 'Dispute settled by the parties', body: `Trade ${refLabel(trade.displayRef)} completed after the dispute was opened — closed with no ruling. No action needed.`, href: '/admin/disputes' })
  }

  // Mutual streak — confirm the running count, celebrate at milestones.
  if (streakResult.count > 0) {
    const streakMsg = streakResult.isMilestone
      ? `🔥 Milestone! This is your ${ordinal(streakResult.count)} completed trade together. Thanks for building trust on the platform.`
      : `🤝 ${ordinal(streakResult.count)} completed trade between you two.`
    await postCtmSystemMessage(trade.id, buyerId, streakMsg)
  }
  notify(trade.sellerId, 'CTM_TRADE_COMPLETED', 'Trade completed', `Buyer confirmed receipt. Trade ${refLabel(trade.displayRef)} is complete.`, { tradeRef, displayRef: trade.displayRef })
  notify(buyerId, 'CTM_TRADE_COMPLETED', 'Trade completed', `You confirmed receipt. Trade ${refLabel(trade.displayRef)} is complete.`, { tradeRef, displayRef: trade.displayRef })

  if (promotedTo) {
    notify(trade.sellerId, 'CTM_TIER_PROMOTED', 'Merchant tier upgraded 🎉', `Your clean track record promoted you to the ${promotedTo} tier — your per-trade limit just went up.`, { tier: promotedTo })
  }

  void closeEpisode({ market: 'ctm', tradeId: trade.id, outcome: 'completed' })
}

export async function openDispute(tradeRef: string, userId: string, reason: string, description: string) {
  const trade = await db.ctmTrade.findUnique({ where: { tradeRef }, include: { dispute: true } })
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)
  if (trade.buyerId !== userId && trade.sellerId !== userId) throw new AppError('FORBIDDEN', 'Access denied', 403)
  if ((ACTIVE_STATUSES as readonly string[]).indexOf(trade.status) === -1 || trade.status === 'awaiting_payment') {
    throw new AppError('CONFLICT', 'Cannot open dispute in current trade status', 409)
  }
  if (trade.dispute) throw new AppError('CONFLICT', 'Dispute already open for this trade', 409)

  // Dispute-lock (mirror of the USDT rule): once a party has CONFIRMED receipt of
  // the counterparty's leg, their only remaining job is to deliver their own —
  // letting them "dispute instead of delivering" is a pure stall/grief lever, so
  // they're barred from self-disputing from that point on (recourse = human support).
  // The locked party is flow-dependent and derived from the flow resolver:
  //   classic     → the SELLER (confirmed the fiat), from payment_confirmed onward
  //   taker-first → the BUYER/maker (confirmed the crypto), from seller_transferring
  // Classic is byte-identical to the old hardcoded rule (minus the dead
  // 'buyer_confirming' status, which is never actually set).
  const lock = ctmDisputeLock(trade.takerFirst)
  const lockedUserId = lock.actor === 'buyer' ? trade.buyerId : trade.sellerId
  if ((lock.lockedStatuses as readonly string[]).includes(trade.status) && userId === lockedUserId) {
    throw new AppError(
      'DISPUTE_SELLER_LOCKED',
      'You already confirmed the counterparty delivered their part, so the only remaining step is to send your own leg — you cannot open a dispute at this stage. If something is genuinely wrong, contact support.',
      403,
    )
  }

  // Dispute-resume: park `status` at `disputed` for all admin tooling, but REMEMBER
  // the ladder rung so both parties can keep settling (disputeResume.ts). The dispute
  // only closes if the trade actually completes.
  await db.$transaction([
    db.ctmTrade.update({ where: { id: trade.id }, data: { status: 'disputed', disputeResumeStatus: trade.status } }),
    db.ctmDispute.create({
      data: {
        tradeId: trade.id,
        openedById: userId,
        reason: reason as never,
        description,
      },
    }),
  ])

  const otherId = trade.buyerId === userId ? trade.sellerId : trade.buyerId
  await postCtmSystemMessage(trade.id, userId, `A dispute was opened. Reason: ${String(reason).replace(/_/g, ' ')}. An admin will review.`)
  notify(otherId, 'CTM_DISPUTE_OPENED', 'Dispute opened on trade', `A dispute has been opened on trade ${refLabel(trade.displayRef)}. An admin will review.`, { tradeRef, displayRef: trade.displayRef, dispute: true })

  void closeEpisode({ market: 'ctm', tradeId: trade.id, outcome: 'disputed' })
}

export async function cancelTrade(tradeRef: string, userId: string, reason: string) {
  const trade = await db.ctmTrade.findUnique({ where: { tradeRef } })
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)
  if (trade.buyerId !== userId && trade.sellerId !== userId) throw new AppError('FORBIDDEN', 'Access denied', 403)
  if (trade.status !== 'awaiting_payment') throw new AppError('CONFLICT', 'Can only cancel trade in awaiting_payment status', 409)

  await db.$transaction(async (tx: Tx) => {
    await tx.ctmTrade.update({
      where: { id: trade.id },
      data: { status: 'cancelled', cancelledBy: userId, cancelReason: reason, cancelledAt: new Date() },
    })

    if (trade.listingId) {
      await decrementLockedAmount(trade.listingId, trade.tokenAmount, tx)
    }
  })

  // Cancellation is not a maker fault → return the bond (idempotent; no-op when off).
  await releaseMakerBond({ tradeType: 'ctm', tradeId: trade.id }).catch((err) =>
    logger.error({ err, tradeId: trade.id }, 'Failed to release maker bond after CTM cancel'),
  )

  const otherId = trade.buyerId === userId ? trade.sellerId : trade.buyerId
  await postCtmSystemMessage(trade.id, userId, `Trade cancelled. Reason: ${reason}`)
  notify(otherId, 'CTM_TRADE_CANCELLED', 'Trade cancelled', `Trade ${refLabel(trade.displayRef)} has been cancelled.`, { tradeRef, displayRef: trade.displayRef, reason })

  void closeEpisode({ market: 'ctm', tradeId: trade.id, outcome: 'cancelled' })
}

export async function adminResolveDispute(adminId: string, tradeRef: string, data: {
  winner: 'buyer' | 'seller' | 'split'
  resolution: string
}) {
  const trade = await db.ctmTrade.findUnique({ where: { tradeRef }, include: { dispute: true } })
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)
  if (!trade.dispute) throw new AppError('NOT_FOUND', 'No dispute found for this trade', 404)
  if (trade.status !== 'disputed') throw new AppError('CONFLICT', 'Trade is not in disputed status', 409)

  await db.$transaction([
    // An admin ruling ends the trade — drop the resume rung so nothing can advance
    // the ladder afterwards.
    db.ctmTrade.update({ where: { id: trade.id }, data: { status: 'dispute_resolved', disputeResumeStatus: null } }),
    db.ctmDispute.update({
      where: { id: trade.dispute.id },
      data: {
        status: 'resolved',
        winner: data.winner as never,
        resolution: data.resolution,
        resolvedBy: adminId,
        resolvedAt: new Date(),
      },
    }),
  ])

  await db.auditLog.create({
    data: {
      actorId: adminId,
      action: 'CTM_DISPUTE_RESOLVED',
      metadata: { tradeRef, winner: data.winner, resolution: data.resolution } as JsonValue,
    },
  }).catch(() => {})

  // Maker collateral bond (Phase 5): seize to the winner if the maker lost, else
  // release. 'split' returns the bond. The helper looks up the maker from the
  // BondHold, so we just pass the winning/losing user ids.
  const winnerUserId = data.winner === 'buyer' ? trade.buyerId : data.winner === 'seller' ? trade.sellerId : null
  const loserUserId  = data.winner === 'buyer' ? trade.sellerId : data.winner === 'seller' ? trade.buyerId : null
  await resolveBondOnDispute({ tradeType: 'ctm', tradeId: trade.id, loserId: loserUserId, winnerId: winnerUserId })
    .catch((err) => logger.error({ err, tradeId: trade.id }, 'Failed to resolve maker bond on CTM dispute'))

  // Airdrop clawback: pull back the loser's points if the trade had completed and
  // awarded any (no-op otherwise). 'split' has no single loser → skip. Best-effort.
  if (loserUserId) {
    await clawbackTradePoints('ctm', trade.id, 'dispute_lost', loserUserId)
      .catch((err) => logger.error({ err, tradeId: trade.id }, 'Failed to claw back airdrop points on CTM dispute'))
  }

  notify(trade.buyerId, 'CTM_DISPUTE_RESOLVED', 'Dispute resolved', `Dispute on trade ${refLabel(trade.displayRef)} has been resolved. Winner: ${data.winner}.`, { tradeRef, displayRef: trade.displayRef, dispute: true })
  notify(trade.sellerId, 'CTM_DISPUTE_RESOLVED', 'Dispute resolved', `Dispute on trade ${refLabel(trade.displayRef)} has been resolved. Winner: ${data.winner}.`, { tradeRef, displayRef: trade.displayRef, dispute: true })
}

/**
 * Admin posts a message into a CTM dispute thread — used to request more
 * evidence from the buyer/seller. Both parties are notified. Does not change
 * trade or dispute status.
 */
export async function adminAddDisputeMessage(adminId: string, tradeRef: string, message: string) {
  const trade = await db.ctmTrade.findUnique({ where: { tradeRef }, include: { dispute: true } })
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)
  if (!trade.dispute) throw new AppError('NOT_FOUND', 'No dispute found for this trade', 404)

  const msg = await db.ctmDisputeMessage.create({
    data: { disputeId: trade.dispute.id, senderId: adminId, message },
  })

  // Admin takeover freezes the step ladder: an admin working the case and the
  // parties settling it themselves must never both land (disputeResume.ts). We clear
  // the resume rung rather than touching dispute.status so the admin "open disputes"
  // queue and its filters are unaffected.
  await db.ctmTrade.update({ where: { id: trade.id }, data: { disputeResumeStatus: null } })

  await db.auditLog.create({
    data: { actorId: adminId, action: 'CTM_DISPUTE_MESSAGE', targetType: 'CtmTrade', targetId: trade.id, metadata: { tradeRef, message } as JsonValue },
  }).catch(() => {})

  const label = trade.displayRef ?? 'your CTM trade'
  const body = `Trade ${label} — an admin asked for more information: ${message}. Tap to respond.`
  const meta = { tradeRef, displayRef: trade.displayRef, dispute: true }
  notify(trade.buyerId, 'CTM_DISPUTE_MESSAGE', 'Admin requested additional evidence', body, meta)
  notify(trade.sellerId, 'CTM_DISPUTE_MESSAGE', 'Admin requested additional evidence', body, meta)

  return msg
}

export async function adminConfirmPayment(adminId: string, tradeRef: string) {
  const trade = await db.ctmTrade.findUnique({ where: { tradeRef } })
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)
  if (trade.status !== 'payment_uploaded') throw new AppError('CONFLICT', `Cannot confirm payment in status: ${trade.status}`, 409)

  await db.ctmTrade.update({ where: { id: trade.id }, data: { status: 'payment_confirmed' } })
  await db.auditLog.create({
    data: { actorId: adminId, action: 'CTM_ADMIN_CONFIRM_PAYMENT', metadata: { tradeRef } as JsonValue },
  }).catch(() => {})

  notify(trade.buyerId, 'CTM_PAYMENT_CONFIRMED', 'Payment confirmed by admin', 'An admin has confirmed your payment.', { tradeRef })
  notify(trade.sellerId, 'CTM_PAYMENT_CONFIRMED', 'Payment confirmed by admin', 'An admin has confirmed the buyer payment. Please send the tokens.', { tradeRef })
}

export async function getAllTradesAdmin(filters: { status?: string; search?: string; token?: string; minAmount?: number; maxAmount?: number; page?: number; limit?: number } = {}) {
  const { status, search, token, minAmount, maxAmount, page = 1, limit = 20 } = filters
  const skip = (page - 1) * limit
  const where: Record<string, unknown> = {}
  if (status) where.status = status

  const and: Record<string, unknown>[] = []
  if (search) {
    const s = search.trim()
    // Resolve users matching the term so ref OR username search both work.
    const users = await db.user.findMany({
      where: { OR: [{ username: { contains: s, mode: 'insensitive' } }, { email: { contains: s, mode: 'insensitive' } }] },
      select: { id: true }, take: 100,
    })
    const userIds = users.map((u) => u.id)
    and.push({
      OR: [
        { tradeRef: { contains: s, mode: 'insensitive' } },
        { displayRef: { contains: s, mode: 'insensitive' } },
        { token: { symbol: { contains: s, mode: 'insensitive' } } },
        { token: { name: { contains: s, mode: 'insensitive' } } },
        { buyerId: { in: userIds } },
        { sellerId: { in: userIds } },
      ],
    })
  }
  if (token) and.push({ token: { OR: [{ symbol: { contains: token, mode: 'insensitive' } }, { id: token }] } })
  if (minAmount != null && !Number.isNaN(minAmount)) and.push({ fiatAmount: { gte: minAmount } })
  if (maxAmount != null && !Number.isNaN(maxAmount)) and.push({ fiatAmount: { lte: maxAmount } })
  if (and.length) where.AND = and

  const [trades, total] = await Promise.all([
    db.ctmTrade.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        token: { select: { id: true, name: true, symbol: true } },
        buyer: { select: { id: true, username: true } },
        seller: { select: { id: true, username: true } },
        dispute: { select: { id: true, status: true, reason: true } },
      },
    }),
    db.ctmTrade.count({ where }),
  ])

  return { trades, total, page, limit, totalPages: Math.ceil(total / limit) }
}

export async function createTradeFromListing(buyerId: string, listingId: string, data: {
  paymentMethod?: string
  paymentMethods?: string[]  // BUY listings: seller selects multiple receiving accounts
  buyerSettlementId?: string
  buyerPaymentMethodId?: string  // SELL listings: buyer's own account they'll pay FROM
  acceptedBuyerPaymentMethodIds?: string[]  // BUY listings: subset of buyer's pay-from accounts the seller accepts
  tokenAmount?: number
  // USDT-as-payment (only used when listing.paymentCurrency === 'USDT'):
  usdtMethod?: string   // chosen delivery method (BEP20/Aptos/Binance/…) — must be offered by the listing
  usdtAddress?: string  // BUY listings only: the taker (seller)'s USDT receiving address
  usdtFromAddress?: string  // SELL listings only: the taker (payer)'s OWN sending account for the chosen method
}) {
  const listing = await db.ctmListing.findUnique({
    where: { id: listingId },
    include: { token: true, merchantProfile: { include: { user: true } } },
  })
  if (!listing) throw new AppError('NOT_FOUND', 'Listing not found', 404)
  if (listing.status !== 'active') throw new AppError('CONFLICT', 'Listing is not active', 409)
  if (!listing.merchantProfile.isActive) throw new AppError('CONFLICT', 'Merchant is not active', 409)
  if (listing.merchantProfile.userId === buyerId) throw new AppError('CONFLICT', 'Cannot trade with yourself', 409)
  if (listing.availableAmount.lte(0)) throw new AppError('CONFLICT', 'Listing has no available tokens', 409)

  // BUY listings: listing creator = buyer (pays PKR), trade taker = seller (sends tokens, receives PKR).
  // SELL listings: listing creator = seller (sends tokens), trade taker = buyer (pays PKR).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isBuyListing = (listing as any).side === 'buy'
  const actualBuyerId = isBuyListing ? listing.merchantProfile.userId : buyerId
  const actualSellerId = isBuyListing ? buyerId : listing.merchantProfile.userId

  // Concurrency cap (anti-scam): both parties must be under their active-trade
  // limit (USDT + CTM combined, lower while a party has an open dispute).
  await assertCanOpenTrade(buyerId, 'self')                          // taker (initiator)
  await assertCanOpenTrade(listing.merchantProfile.userId, 'counterparty') // maker (ad owner)

  // ── Taker KYC: intentionally NOT required on CTM ────────────────────────────
  // The taker (the party responding to an ad) always commits their leg and never
  // needs KYC to trade — verification is enforced only on the MAKER at listing
  // creation. No per-trade / daily / lifetime / send-first caps are applied to the
  // taker here; the global concurrency cap above is the only throttle.
  // Only BUY listings on a taker-first-ready market use the reordered flow.
  const usesTakerFirstFlow = isBuyListing && (await isTakerFirstForMarket('ctm'))

  // Payment rail is chosen by the TAKER at trade time, not fixed on the listing:
  // a listing can offer PKR and/or USDT, and the taker picks one. When the taker
  // selected a USDT method this is a USDT trade; otherwise it settles in PKR.
  const isUsdtTrade = !!(data.usdtMethod && data.usdtMethod.trim())

  // SELL listings: taker (buyer) picks one of the listing's accepted payment methods.
  // BUY listings: taker (seller) provides one or more of their own receiving accounts.
  let primaryPaymentMethodId: string
  let resolvedPaymentMethodIds: string[]
  // Resolved USDT payment (populated only for USDT listings).
  let usdtMethod = ''
  let usdtAddress = ''
  if (isUsdtTrade) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const offered: string[] = (listing as any).usdtPaymentMethods ?? []
    const method = (data.usdtMethod ?? '').trim()
    if (!method || !offered.includes(method)) {
      throw new AppError('CONFLICT', 'USDT payment method not supported by this listing', 409)
    }
    usdtMethod = method
    if (isBuyListing) {
      // Maker PAYS USDT → the taker (seller) supplies their receiving address/UID.
      const addr = (data.usdtAddress ?? '').trim()
      if (!addr) throw new AppError('VALIDATION_ERROR', 'Enter your USDT receiving address / UID', 400)
      usdtAddress = addr
    } else {
      // Maker RECEIVES USDT → use the maker's receive address for the chosen method.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dests: Array<{ method?: string; address?: string }> = (listing as any).usdtSettlementDestinations ?? []
      const d = dests.find((x) => x.method === method)
      if (!d?.address) throw new AppError('CONFLICT', 'Maker has no USDT address for the selected method', 409)
      usdtAddress = d.address
      // The taker PAYS USDT → they must declare their OWN sending account for the
      // SAME method (a Binance internal transfer can only come from a Binance
      // account; a BEP20 payment only from a BEP20 wallet). Snapshotted below so
      // the seller knows exactly where the payment will come from.
      if (!(data.usdtFromAddress ?? '').trim()) {
        throw new AppError('VALIDATION_ERROR', `Enter your ${method} account / address you'll send from`, 400)
      }
    }
    // Placeholder id keeps the required `paymentMethod` column non-empty without a
    // PKR PaymentMethod row (there is none for a USDT trade).
    primaryPaymentMethodId = `usdt:${method}`
    resolvedPaymentMethodIds = []
  } else if (!isBuyListing) {
    if (!data.paymentMethod) throw new AppError('VALIDATION_ERROR', 'paymentMethod is required', 400)
    if (!listing.paymentMethods.includes(data.paymentMethod)) {
      throw new AppError('CONFLICT', 'Payment method not supported by this listing', 409)
    }
    primaryPaymentMethodId = data.paymentMethod
    resolvedPaymentMethodIds = [data.paymentMethod]
  } else {
    const ids = data.paymentMethods?.length ? data.paymentMethods : (data.paymentMethod ? [data.paymentMethod] : [])
    if (ids.length === 0) throw new AppError('VALIDATION_ERROR', 'Select at least one payment receiving account', 400)
    primaryPaymentMethodId = ids[0]!
    resolvedPaymentMethodIds = ids
  }

  // Token amount is required — takers always specify quantity in tokens.
  if (data.tokenAmount === undefined) throw new AppError('VALIDATION_ERROR', 'tokenAmount is required', 400)
  const tradeTokenAmount = new Prisma.Decimal(data.tokenAmount)
  if (tradeTokenAmount.lte(0)) throw new AppError('VALIDATION_ERROR', 'Token amount must be greater than 0', 400)
  if (tradeTokenAmount.gt(listing.availableAmount)) throw new AppError('VALIDATION_ERROR', 'Requested amount exceeds available listing amount', 400)
  if (tradeTokenAmount.lt(listing.minOrderTokens)) throw new AppError('VALIDATION_ERROR', `Minimum order is ${listing.minOrderTokens.toString()} ${listing.token.symbol}`, 400)
  if (tradeTokenAmount.gt(listing.maxOrderTokens)) throw new AppError('VALIDATION_ERROR', `Maximum order is ${listing.maxOrderTokens.toString()} ${listing.token.symbol}`, 400)

  // Non-custodial early-access per-order cap, expressed in USDT-equivalent and
  // tier-aware (taker = buyerId). L1 default 50 USDT-equiv, L2 default unlimited.
  // Converts the PKR order value using the platform USDT→PKR rate; if that rate
  // is unavailable the cap is skipped (fail-open) rather than blocking trades.
  if (await isFlagEnabled(FLAGS.NONCUSTODIAL_P2P) && !(await isTradeLimitBypassed(buyerId))) {
    const taker = await db.user.findUnique({ where: { id: buyerId }, select: { kycLevel: true } })
    const capUsdt = taker?.kycLevel === 'enhanced'
      ? await getNumberConfig('noncustodial_max_order_usdt_l2', 500)
      : await getNumberConfig('noncustodial_max_order_usdt_l1', 50)
    if (capUsdt > 0) {
      const usdtPkr = await getNumberConfig('rate_USDT_PKR', 0)
      if (usdtPkr > 0) {
        const orderUsdtEquiv = listing.pricePerUnit.mul(tradeTokenAmount).toNumber() / usdtPkr
        if (orderUsdtEquiv > capUsdt) {
          throw new AppError('ORDER_TOO_LARGE', `During early access, your maximum order is ${capUsdt} USDT-equivalent.`, 400)
        }
      }
    }
  }

  // Snapshot the payment account(s) that will RECEIVE the PKR payment (always the seller).
  // For SELL listings: single account — seller = listing creator.
  // For BUY listings: one or more accounts — seller = trade taker (buyerId param).
  const PM_LABELS: Record<string, string> = { jazzcash: 'JazzCash', easypaisa: 'Easypaisa', sadapay: 'SadaPay', nayapay: 'NayaPay', bank_transfer: 'Bank Transfer' }
  const paymentMethodOwnerId = isBuyListing ? buyerId : listing.merchantProfile.userId

  function buildAccountSnapshot(pm: { type: string; accountName: string; bankName: string | null; mobileNumber: string | null; ibanNumber: string | null; accountNumber: string | null }) {
    return {
      type: pm.type as string,
      label: pm.type === 'bank_transfer' ? (pm.bankName ?? 'Bank Transfer') : (PM_LABELS[pm.type] ?? pm.type),
      accountName: pm.accountName,
      ...(pm.mobileNumber ? { mobileNumber: pm.mobileNumber } : {}),
      ...(pm.bankName ? { bankName: pm.bankName } : {}),
      ...(pm.ibanNumber ? { ibanNumber: pm.ibanNumber } : {}),
      ...(pm.accountNumber ? { accountNumber: pm.accountNumber } : {}),
    }
  }

  let sellerPaymentSnapshot: Record<string, unknown>
  if (isUsdtTrade) {
    // USDT payment "receive point" — rendered in the trade room as where the payer
    // sends USDT (maker's address on a SELL listing, taker's address on a BUY one).
    sellerPaymentSnapshot = { type: 'usdt', method: usdtMethod, address: usdtAddress, label: `USDT ${usdtMethod}` }
  } else if (isBuyListing && resolvedPaymentMethodIds.length > 1) {
    // Multi-account: seller chose multiple receiving accounts
    const methods = await db.paymentMethod.findMany({
      where: { id: { in: resolvedPaymentMethodIds }, userId: paymentMethodOwnerId },
    })
    if (methods.length !== resolvedPaymentMethodIds.length) {
      throw new AppError('CONFLICT', 'One or more payment methods not found or do not belong to you', 409)
    }
    // Store as { accounts: [...] } — trade room renders all, buyer picks one to pay to
    sellerPaymentSnapshot = { accounts: methods.map(buildAccountSnapshot) }
  } else {
    const sellerPaymentMethod = await db.paymentMethod.findFirst({
      where: { id: primaryPaymentMethodId, userId: paymentMethodOwnerId },
    })
    if (!sellerPaymentMethod) throw new AppError('CONFLICT', 'Payment method not found or does not belong to you', 409)
    sellerPaymentSnapshot = buildAccountSnapshot(sellerPaymentMethod)
  }

  // Snapshot the buyer's "pay from" account(s) so the seller can see where PKR
  // will come from in the trade room.
  //   SELL listings: the taker (buyer) picks one account at trade start (buyerPaymentMethodId).
  //   BUY listings: the lister (buyer) declared their pay-from account(s) at listing
  //     creation, stored on listing.paymentMethods — snapshot them here so the trade
  //     no longer shows "account details not provided".
  let buyerPaymentSnapshot: Record<string, unknown> | null = null
  if (isUsdtTrade) {
    // SELL listings: the taker (payer) declared their OWN sending account for the
    // chosen method — snapshot it so the seller knows exactly where the USDT
    // payment will come from. BUY listings (maker pays) have no pay-from snapshot.
    const from = (data.usdtFromAddress ?? '').trim()
    buyerPaymentSnapshot = !isBuyListing && from
      ? { type: 'usdt', method: usdtMethod, address: from, label: `USDT ${usdtMethod}` }
      : null
  } else if (!isBuyListing && data.buyerPaymentMethodId) {
    const buyerPm = await db.paymentMethod.findFirst({
      where: { id: data.buyerPaymentMethodId, userId: buyerId },
    })
    if (buyerPm) buyerPaymentSnapshot = buildAccountSnapshot(buyerPm)
  } else if (isBuyListing && listing.paymentMethods.length > 0) {
    // Seller (taker) may restrict which of the buyer's declared pay-from accounts
    // they accept — fall back to all if none/invalid selection was sent.
    const accepted = data.acceptedBuyerPaymentMethodIds?.length
      ? listing.paymentMethods.filter((mid) => data.acceptedBuyerPaymentMethodIds!.includes(mid))
      : listing.paymentMethods
    const idsToUse = accepted.length > 0 ? accepted : listing.paymentMethods
    const buyerPms = await db.paymentMethod.findMany({
      where: { id: { in: idsToUse }, userId: actualBuyerId },
    })
    if (buyerPms.length === 1) buyerPaymentSnapshot = buildAccountSnapshot(buyerPms[0]!)
    else if (buyerPms.length > 1) buyerPaymentSnapshot = { accounts: buyerPms.map(buildAccountSnapshot) }
  }

  // Buyer's token receiving address:
  // For SELL listings: provided by trade taker (buyer) at trade start.
  // For BUY listings: already stored on the listing (listing creator's address).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actualBuyerSettlementId = isBuyListing ? ((listing as any).settlementMethod ?? null) : (data.buyerSettlementId ?? null)

  // Guardrail: if the admin configured an address pattern for this token, the
  // buyer's receiving address must match it — so a wrong-chain address (e.g. an
  // EVM 0x… where a Sidra address is expected) can't be used. Shared with
  // createListing so an ad that passes creation also passes trade start. Only
  // applied to blockchain deliveries (email/username carry a different value).
  assertTokenAddressFormat(
    listing.token,
    actualBuyerSettlementId ? String(actualBuyerSettlementId) : null,
    (listing as { tokenDeliveryType?: string | null }).tokenDeliveryType,
  )

  const expiresAt = new Date(Date.now() + (listing.tradeWindowMins ?? 45) * 60 * 1000)

  // Maker collateral bond (non-custodial Phase 5): the LISTING CREATOR (maker)
  // posts the bond, regardless of buy/sell side. CTM is priced in PKR, so the
  // bond is computed on the USDT-equivalent via the platform USDT→PKR rate. If
  // that rate is unavailable we skip the bond (fail-open, consistent with the
  // order-cap) rather than block trading.
  const makerId = listing.merchantProfile.userId
  const bondCfg = await getBondConfig()
  let bondUsdtEquiv = 0
  if (bondCfg.enabled) {
    const usdtPkr = await getNumberConfig('rate_USDT_PKR', 0)
    if (usdtPkr > 0) {
      bondUsdtEquiv = listing.pricePerUnit.mul(tradeTokenAmount).toNumber() / usdtPkr
    } else {
      logger.warn({ listingId }, 'maker bond skipped for CTM trade — USDT/PKR rate unavailable')
    }
  }
  const willBond = bondCfg.enabled && bondUsdtEquiv > 0

  // USDT-as-payment amount owed (only for USDT listings). The order is PKR-priced,
  // so convert to USDT via the platform rate; without it we can't state the amount,
  // so we block — only ever reachable for a USDT listing.
  let usdtTradeFields: Record<string, unknown> = {}
  if (isUsdtTrade) {
    const usdtPkr = await getNumberConfig('rate_USDT_PKR', 0)
    if (usdtPkr <= 0) {
      throw new AppError('SERVICE_UNAVAILABLE', 'USDT/PKR rate unavailable — cannot open a USDT trade right now', 503)
    }
    usdtTradeFields = {
      paymentCurrency: 'USDT',
      usdtDeliveryMethod: usdtMethod,
      usdtDeliveryAddress: usdtAddress,
      usdtAmount: listing.pricePerUnit.mul(tradeTokenAmount).div(usdtPkr),
    }
  }

  const created = await db.$transaction(async (tx: Tx) => {
    // Atomic availability check: only lock if availableAmount >= requested amount (prevents race condition)
    const updated = await tx.ctmListing.updateMany({
      where: { id: listing.id, availableAmount: { gte: tradeTokenAmount } },
      data: {
        availableAmount: { decrement: tradeTokenAmount },
        lockedAmount: { increment: tradeTokenAmount },
      },
    })
    if (updated.count === 0) throw new AppError('CONFLICT', 'Listing is no longer available for trading', 409)

    const isOnChain = listing.settlementType === 'ON_CHAIN'
    const escrowAddress = isOnChain ? (process.env.PLATFORM_USDT_WALLET ?? null) : null
    const escrowCurrency = isOnChain ? (process.env.PLATFORM_ESCROW_CURRENCY ?? 'USDT_TRC20') : null
    const escrowAmount = isOnChain ? listing.pricePerUnit.mul(tradeTokenAmount) : null

    const fiatAmount = listing.pricePerUnit.mul(tradeTokenAmount)
    // Platform fee: configurable via env (default 0.5% of PKR amount)
    const feePct = parseFloat(process.env.CTM_PLATFORM_FEE_PCT ?? '0.5') / 100
    const platformFeePkr = fiatAmount.mul(feePct)

    const trade = await tx.ctmTrade.create({
      data: {
        displayRef: await generateCtmDisplayRef(tx),
        listingId: listing.id,
        buyerId: actualBuyerId,
        sellerId: actualSellerId,
        tokenId: listing.tokenId,
        settlementType: listing.settlementType,
        tokenAmount: tradeTokenAmount,
        pricePerUnit: listing.pricePerUnit,
        fiatAmount,
        paymentMethod: primaryPaymentMethodId,
        settlementMethod: listing.settlementMethod,
        buyerSettlementId: actualBuyerSettlementId,
        sellerPaymentSnapshot: sellerPaymentSnapshot as never,
        ...(buyerPaymentSnapshot ? { buyerPaymentSnapshot: buyerPaymentSnapshot as never } : {}),
        status: 'awaiting_payment',
        takerFirst: usesTakerFirstFlow,
        expiresAt,
        platformFeePkr,
        ...(escrowAddress ? { escrowAddress, escrowCurrency, escrowAmount } : {}),
        // USDT-as-payment: currency + method/address/amount owed. Empty (PKR) for
        // every existing/current trade, so this is a no-op until the feature is on.
        ...usdtTradeFields,
      },
    })

    // Maker collateral bond — lock the maker's USDT bond in the SAME transaction
    // (placed last so nothing can fail after it). Throws INSUFFICIENT_BOND →
    // the whole trade creation, incl. the listing availability decrement, rolls
    // back atomically.
    if (willBond) {
      await lockMakerBondTx(
        tx,
        { tradeType: 'ctm', tradeId: trade.id, makerId, tradeUsdt: bondUsdtEquiv },
        bondCfg,
      )
    }

    // Notify the listing creator the moment a trade opens against their listing —
    // not only later when proof is uploaded. The merchant is the buyer on a BUY
    // listing (they pay) or the seller on a SELL listing (they receive payment),
    // so word it from their side. 'ctm_trade_created' is Telegram-allowlisted so
    // this also reaches the merchant as a DM (parity with USDT 'trade').
    const sym = listing.token.symbol
    const lbl = refLabel(trade.displayRef)
    notify(
      listing.merchantProfile.userId,
      'ctm_trade_created',
      'New CTM trade opened',
      isBuyListing
        ? `A seller filled your ${sym} buy listing. Trade ${lbl} is open — send the PKR payment and upload proof within the trade window.`
        : `A buyer started a trade on your ${sym} listing. Trade ${lbl} is open — the buyer will send the PKR payment and upload proof. Confirm once it arrives, then send the tokens.`,
      { tradeRef: trade.tradeRef, displayRef: trade.displayRef },
    )

    return trade
  })

  if (willBond) {
    void recordAuditLog(makerId, 'BOND_LOCKED', 'BondHold', `ctm:${created.id}`, {
      tradeType: 'ctm', tradeId: created.id, amountUsdt: bondUsdtEquiv.toString(),
    })
    logger.info({ tradeId: created.id, makerId, amountUsdt: bondUsdtEquiv }, 'Maker bond locked (CTM)')
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await postCtmOpeningMessages(created.id, created.buyerId, (listing as any).terms)

  // Persistent messaging (Phase 4): open the pair's episode. Best-effort, flag-gated.
  void openEpisode({ market: 'ctm', tradeId: created.id, tradeRef: created.displayRef ?? created.tradeRef, buyerId: created.buyerId, sellerId: created.sellerId, fiatAmount: created.fiatAmount })

  return created
}

/**
 * Post a system (auto) message into a CTM trade's chat thread on a step
 * transition. Best-effort — never breaks the trade action. Takes the internal
 * trade id (not tradeRef). isSystem renders it as a centered status line.
 */
export async function postCtmSystemMessage(tradeId: string, senderId: string, message: string) {
  try {
    await db.ctmTradeMessage.create({ data: { tradeId, senderId, message, isSystem: true } })
  } catch (err) {
    logger.error({ err, tradeId }, 'Failed to post CTM system message')
  }
}

export async function sendMessage(tradeRef: string, senderId: string, message: string, attachmentUrl?: string) {
  const trade = await db.ctmTrade.findUnique({ where: { tradeRef } })
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)
  if (trade.buyerId !== senderId && trade.sellerId !== senderId) throw new AppError('FORBIDDEN', 'Access denied', 403)

  const msg = await db.ctmTradeMessage.create({
    data: { tradeId: trade.id, senderId, message, attachmentUrl: attachmentUrl ?? null },
  })

  // Keep the unified inbox thread fresh (ordering + unread). Best-effort, flag-gated.
  void bumpThreadForTradeMessage({ buyerId: trade.buyerId, sellerId: trade.sellerId, senderId })

  return msg
}

export async function getMessages(tradeRef: string, userId: string, role: string) {
  const trade = await db.ctmTrade.findUnique({ where: { tradeRef } })
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)
  if (!isParticipant(trade, userId, role)) throw new AppError('FORBIDDEN', 'Access denied', 403)

  return db.ctmTradeMessage.findMany({
    where: { tradeId: trade.id },
    orderBy: { createdAt: 'asc' },
  })
}

export async function rateTrade(tradeRef: string, raterId: string, data: {
  rating: number
  comment?: string
  tags?: string[]
}) {
  const trade = await db.ctmTrade.findUnique({ where: { tradeRef } })
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)
  if (trade.buyerId !== raterId && trade.sellerId !== raterId) throw new AppError('FORBIDDEN', 'Access denied', 403)
  if (trade.status !== 'completed') throw new AppError('CONFLICT', 'Can only rate completed trades', 409)

  const ratedUserId = trade.buyerId === raterId ? trade.sellerId : trade.buyerId

  const existing = await db.ctmTradeRating.findUnique({ where: { tradeId_ratedByUserId: { tradeId: trade.id, ratedByUserId: raterId } } })
  if (existing) throw new AppError('CONFLICT', 'You have already rated this trade', 409)

  const rating = await db.ctmTradeRating.create({
    data: {
      tradeId: trade.id,
      ratedByUserId: raterId,
      ratedUserId,
      rating: data.rating,
      comment: data.comment ?? null,
      tags: data.tags ?? [],
    },
  })

  // Update merchant avg rating
  const allRatings = await db.ctmTradeRating.aggregate({
    where: { ratedUserId },
    _avg: { rating: true },
  })
  if (allRatings._avg.rating !== null) {
    await db.ctmMerchantProfile.updateMany({
      where: { userId: ratedUserId },
      data: { ctmAvgRating: new Prisma.Decimal(allRatings._avg.rating) },
    })
  }

  return rating
}

export async function selectTradePaymentAccount(tradeRef: string, buyerId: string, accountIndex: number) {
  const trade = await db.ctmTrade.findUnique({ where: { tradeRef } })
  if (!trade) throw new AppError('NOT_FOUND', 'Trade not found', 404)
  if (trade.buyerId !== buyerId) throw new AppError('FORBIDDEN', 'Only the buyer can select the payment account', 403)
  if (trade.status !== 'awaiting_payment') throw new AppError('CONFLICT', 'Payment account can only be selected while awaiting payment', 409)

  const snapshot = trade.sellerPaymentSnapshot as Record<string, unknown> | null
  if (!snapshot || !Array.isArray(snapshot.accounts)) {
    throw new AppError('CONFLICT', 'This trade does not require a payment account selection', 409)
  }
  if (snapshot.selectedIdx !== undefined) {
    throw new AppError('CONFLICT', 'Payment account is already selected for this trade', 409)
  }
  if (accountIndex < 0 || accountIndex >= (snapshot.accounts as unknown[]).length) {
    throw new AppError('VALIDATION_ERROR', 'Invalid account index', 400)
  }

  const selectedAccount = (snapshot.accounts as Record<string, string>[])[accountIndex]!
  const updatedSnapshot = { ...snapshot, selectedIdx: accountIndex }

  await db.ctmTrade.update({
    where: { tradeRef },
    data: { sellerPaymentSnapshot: updatedSnapshot as never },
  })

  notify(
    trade.sellerId,
    'CTM_PAYMENT_METHOD_SELECTED',
    'Buyer selected payment method',
    `Buyer selected ${selectedAccount.label} for trade ${tradeRef}. You will receive payment in your ${selectedAccount.label} account.`,
    { tradeRef },
  )

  return { selectedIdx: accountIndex, selectedAccount }
}
