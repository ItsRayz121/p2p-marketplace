import { db } from '../lib/prisma'
import { logger } from '../lib/logger'
import https from 'node:https'

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
      await db.$transaction(async (tx) => {
        await tx.ctmTrade.update({ where: { id: trade.id }, data: { status: 'completed', completedAt: new Date(), confirmDeadlineAt: null } })
        await tx.ctmToken.update({ where: { id: trade.tokenId }, data: { totalTrades: { increment: 1 }, totalVolumePkr: { increment: trade.fiatAmount }, lastTradedAt: new Date() } })
        if (trade.listingId) {
          await tx.ctmListing.update({
            where: { id: trade.listingId },
            data: { lockedAmount: { decrement: trade.tokenAmount }, totalAmount: { decrement: trade.tokenAmount } },
          })
        }
        await tx.ctmMerchantProfile.updateMany({
          where: { userId: trade.sellerId },
          data: { totalCtmTrades: { increment: 1 }, completedCtmTrades: { increment: 1 } },
        })
      })

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

export async function runCtmMerchantTierUpgrade() {
  // new → basic: 10+ completed trades
  const newMerchants = await db.ctmMerchantProfile.findMany({
    where: { tier: 'new', isActive: true },
    select: { id: true, userId: true, completedCtmTrades: true },
  })

  for (const m of newMerchants) {
    if (m.completedCtmTrades >= 10) {
      await db.ctmMerchantProfile.update({ where: { id: m.id }, data: { tier: 'basic' } })
      await db.auditLog.create({
        data: { actorId: m.userId, action: 'CTM_AUTO_TIER_UPGRADE', metadata: { from: 'new', to: 'basic', completedTrades: m.completedCtmTrades } },
      }).catch(() => {})
      logger.info({ merchantId: m.id, completedTrades: m.completedCtmTrades }, 'CTM merchant auto-upgraded: new → basic')
    }
  }

  // verified → elite: 200+ completed trades AND dispute rate < 2%
  const verifiedMerchants = await db.ctmMerchantProfile.findMany({
    where: { tier: 'verified', isActive: true },
    select: { id: true, userId: true, completedCtmTrades: true, ctmDisputeRate: true },
  })

  for (const m of verifiedMerchants) {
    const disputeRate = parseFloat(m.ctmDisputeRate.toString())
    if (m.completedCtmTrades >= 200 && disputeRate < 0.02) {
      await db.ctmMerchantProfile.update({ where: { id: m.id }, data: { tier: 'elite' } })
      await db.auditLog.create({
        data: { actorId: m.userId, action: 'CTM_AUTO_TIER_UPGRADE', metadata: { from: 'verified', to: 'elite', completedTrades: m.completedCtmTrades, disputeRate } },
      }).catch(() => {})
      logger.info({ merchantId: m.id, completedTrades: m.completedCtmTrades }, 'CTM merchant auto-upgraded: verified → elite')
    }
  }
}

export async function runCtmEscrowMonitor() {
  const tronApiKey = process.env.TRON_API_KEY
  const tronNode = process.env.TRON_NODE_URL ?? 'https://api.trongrid.io'
  if (!tronApiKey) return // requires TRON_API_KEY to be configured

  const usdtContract = process.env.USDT_TRC20_CONTRACT ?? 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

  // Find trades awaiting escrow deposit
  const pendingEscrow = await db.ctmTrade.findMany({
    where: {
      status: 'awaiting_payment',
      escrowAddress: { not: null },
      escrowConfirmedAt: null,
      settlementType: 'ON_CHAIN',
    },
    select: { id: true, tradeRef: true, escrowAddress: true, escrowAmount: true, buyerId: true, sellerId: true },
  })

  if (pendingEscrow.length === 0) return

  for (const trade of pendingEscrow) {
    if (!trade.escrowAddress || !trade.escrowAmount) continue
    try {
      const url = `${tronNode}/v1/accounts/${trade.escrowAddress}/transactions/trc20?only_confirmed=true&limit=20&contract_address=${usdtContract}`
      const data = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const req = https.get(url, { headers: { 'TRON-PRO-API-KEY': tronApiKey } }, (res) => {
          let body = ''
          res.on('data', (chunk: Buffer) => { body += chunk.toString() })
          res.on('end', () => { try { resolve(JSON.parse(body) as Record<string, unknown>) } catch { reject(new Error('JSON parse failed')) } })
        })
        req.on('error', reject)
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')) })
      })

      const txs = (data.data as Array<Record<string, unknown>>) ?? []
      const requiredAmount = Math.round(parseFloat(trade.escrowAmount.toString()) * 1_000_000) // USDT has 6 decimals

      const matchingTx = txs.find((tx) => {
        const value = parseInt(String(tx.value ?? '0'), 10)
        const to = String(tx.to ?? '')
        return value >= requiredAmount && to.toLowerCase() === trade.escrowAddress!.toLowerCase()
      })

      if (matchingTx) {
        await db.$transaction([
          db.ctmTrade.update({
            where: { id: trade.id },
            data: {
              status: 'payment_uploaded',
              escrowTxHash: String(matchingTx.transaction_id ?? ''),
              escrowConfirmedAt: new Date(),
              paymentProofUrl: `https://tronscan.org/#/transaction/${matchingTx.transaction_id}`,
            },
          }),
        ])
        await db.notification.createMany({
          data: [
            { userId: trade.buyerId, type: 'CTM_ESCROW_CONFIRMED', title: 'USDT deposit confirmed', body: `Your USDT deposit for trade ${trade.tradeRef} has been confirmed.`, metadata: { tradeRef: trade.tradeRef } },
            { userId: trade.sellerId, type: 'CTM_ESCROW_CONFIRMED', title: 'USDT escrow received', body: `Buyer deposited USDT for trade ${trade.tradeRef}. Please confirm the PKR payment or send tokens.`, metadata: { tradeRef: trade.tradeRef } },
          ],
        }).catch(() => {})
        logger.info({ tradeRef: trade.tradeRef, txId: matchingTx.transaction_id }, 'CTM escrow deposit auto-confirmed')
      }
    } catch (err) {
      logger.warn({ tradeRef: trade.tradeRef, err }, 'CTM escrow monitor: error checking deposit')
    }
  }
}
