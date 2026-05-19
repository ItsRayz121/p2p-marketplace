import { db } from '../lib/prisma'
import { logger } from '../lib/logger'

export async function runCtmTradeExpiry() {
  const now = new Date()

  // Expire trades stuck in awaiting_payment past expiresAt
  const expired = await db.ctmTrade.findMany({
    where: { status: 'awaiting_payment', expiresAt: { lte: now } },
    select: { id: true, tradeRef: true, listingId: true, tokenAmount: true, buyerId: true, sellerId: true },
  })

  for (const trade of expired) {
    await db.$transaction(async (tx) => {
      await tx.ctmTrade.update({ where: { id: trade.id }, data: { status: 'expired' } })

      if (trade.listingId) {
        await tx.ctmListing.update({
          where: { id: trade.listingId },
          data: {
            availableAmount: { increment: trade.tokenAmount },
            lockedAmount: { decrement: trade.tokenAmount },
          },
        })
      }
    })

    await db.notification.createMany({
      data: [
        { userId: trade.buyerId, type: 'CTM_TRADE_EXPIRED', title: 'Trade expired', body: `Trade ${trade.tradeRef} expired — payment was not uploaded in time.`, metadata: { tradeRef: trade.tradeRef } },
        { userId: trade.sellerId, type: 'CTM_TRADE_EXPIRED', title: 'Trade expired', body: `Trade ${trade.tradeRef} expired — buyer did not upload payment proof in time.`, metadata: { tradeRef: trade.tradeRef } },
      ],
    }).catch(() => {})

    logger.info({ tradeRef: trade.tradeRef }, 'CTM trade expired')
  }

  if (expired.length > 0) {
    logger.info({ count: expired.length }, 'CTM trade expiry: expired trades')
  }
}

export async function runCtmProofDeadline() {
  const now = new Date()

  // Escalate trades where seller missed proofDeadlineAt (payment_uploaded: seller must confirm)
  const sellerMissedConfirm = await db.ctmTrade.findMany({
    where: { status: 'payment_uploaded', proofDeadlineAt: { lte: now } },
    select: { id: true, tradeRef: true, buyerId: true, sellerId: true },
  })

  for (const trade of sellerMissedConfirm) {
    await db.$transaction([
      db.ctmTrade.update({ where: { id: trade.id }, data: { status: 'disputed' } }),
      db.ctmDispute.create({
        data: {
          tradeId: trade.id,
          openedById: trade.buyerId,
          reason: 'seller_unresponsive',
          description: 'Auto-escalated: seller did not confirm payment within deadline.',
        },
      }),
    ])

    await db.notification.createMany({
      data: [
        { userId: trade.buyerId, type: 'CTM_AUTO_DISPUTE', title: 'Dispute auto-opened', body: `Trade ${trade.tradeRef}: seller missed the confirmation deadline. Admin will review.`, metadata: { tradeRef: trade.tradeRef } },
        { userId: trade.sellerId, type: 'CTM_AUTO_DISPUTE', title: 'Dispute auto-opened', body: `Trade ${trade.tradeRef}: you missed the payment confirmation deadline. Admin will review.`, metadata: { tradeRef: trade.tradeRef } },
      ],
    }).catch(() => {})

    logger.warn({ tradeRef: trade.tradeRef }, 'CTM auto-dispute: seller missed payment confirmation deadline')
  }

  // Escalate trades where seller missed proofDeadlineAt (seller_transferring: must submit token proof)
  const sellerMissedTokenProof = await db.ctmTrade.findMany({
    where: { status: 'seller_transferring', proofDeadlineAt: { lte: now } },
    select: { id: true, tradeRef: true, buyerId: true, sellerId: true },
  })

  for (const trade of sellerMissedTokenProof) {
    await db.$transaction([
      db.ctmTrade.update({ where: { id: trade.id }, data: { status: 'disputed' } }),
      db.ctmDispute.create({
        data: {
          tradeId: trade.id,
          openedById: trade.buyerId,
          reason: 'seller_unresponsive',
          description: 'Auto-escalated: seller did not submit token transfer proof within deadline.',
        },
      }),
    ])

    await db.notification.createMany({
      data: [
        { userId: trade.buyerId, type: 'CTM_AUTO_DISPUTE', title: 'Dispute auto-opened', body: `Trade ${trade.tradeRef}: seller missed the token proof deadline. Admin will review.`, metadata: { tradeRef: trade.tradeRef } },
        { userId: trade.sellerId, type: 'CTM_AUTO_DISPUTE', title: 'Dispute auto-opened', body: `Trade ${trade.tradeRef}: you missed the token proof deadline. Admin will review.`, metadata: { tradeRef: trade.tradeRef } },
      ],
    }).catch(() => {})

    logger.warn({ tradeRef: trade.tradeRef }, 'CTM auto-dispute: seller missed token proof deadline')
  }

  // Auto-complete trades where buyer missed confirmDeadlineAt (only for verified/elite merchant sellers)
  const buyerMissedConfirm = await db.ctmTrade.findMany({
    where: { status: 'proof_submitted', confirmDeadlineAt: { lte: now } },
    include: {
      seller: { include: { ctmMerchantProfile: { select: { tier: true } } } },
    },
  })

  for (const trade of buyerMissedConfirm) {
    const sellerTier = trade.seller.ctmMerchantProfile?.tier
    const autoComplete = sellerTier === 'verified' || sellerTier === 'elite'

    if (autoComplete) {
      await db.ctmTrade.update({ where: { id: trade.id }, data: { status: 'completed', completedAt: new Date(), confirmDeadlineAt: null } })
      await db.ctmToken.update({ where: { id: trade.tokenId }, data: { totalTrades: { increment: 1 }, totalVolumePkr: { increment: trade.fiatAmount }, lastTradedAt: new Date() } })

      await db.notification.createMany({
        data: [
          { userId: trade.buyerId, type: 'CTM_AUTO_COMPLETED', title: 'Trade auto-completed', body: `Trade ${trade.tradeRef} was auto-completed because you missed the confirmation deadline.`, metadata: { tradeRef: trade.tradeRef } },
          { userId: trade.sellerId, type: 'CTM_AUTO_COMPLETED', title: 'Trade auto-completed', body: `Trade ${trade.tradeRef} was auto-completed after buyer's confirmation deadline passed.`, metadata: { tradeRef: trade.tradeRef } },
        ],
      }).catch(() => {})

      logger.info({ tradeRef: trade.tradeRef, sellerTier }, 'CTM auto-completed: buyer missed confirmation deadline')
    } else {
      // Send to admin queue for manual review
      await db.ctmTrade.update({ where: { id: trade.id }, data: { confirmDeadlineAt: null } })
      logger.warn({ tradeRef: trade.tradeRef, sellerTier }, 'CTM buyer missed confirmation deadline — admin review needed')
    }
  }
}

export async function runCtmDisputeEscalation() {
  const escalateAfter = new Date(Date.now() - 48 * 60 * 60 * 1000)

  const staleDisputes = await db.ctmDispute.findMany({
    where: { status: 'open', createdAt: { lte: escalateAfter }, escalatedAt: null },
    select: { id: true, tradeId: true, trade: { select: { tradeRef: true, buyerId: true, sellerId: true } } },
  })

  for (const dispute of staleDisputes) {
    await db.ctmDispute.update({
      where: { id: dispute.id },
      data: { escalatedAt: new Date() },
    })
    logger.warn({ disputeId: dispute.id }, 'CTM dispute escalated: open >48h without admin resolution')
  }

  if (staleDisputes.length > 0) {
    logger.info({ count: staleDisputes.length }, 'CTM dispute escalation: flagged stale disputes')
  }
}
