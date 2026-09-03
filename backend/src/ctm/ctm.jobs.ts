import { db } from '../lib/prisma'
import { logger } from '../lib/logger'
import https from 'node:https'
import { notify as centralNotify } from '../lib/notify'
import { releaseMakerBond } from '../services/makerBond.service'
import { incrementTradeStreak, ordinal } from '../services/tradeStreak.service'
import { awardTradePointsTx } from '../services/airdrop.service'
import { postCtmSystemMessage } from './ctm.trade.service'
import { closeEpisode } from '../services/chatThread.service'
import { ctmStepFromStatus, ctmFlowSteps, type CtmFlowAction } from '../services/ctmSettlementFlow'

/** What each pending action means in a missed-deadline message. */
const MISSED_ACTION_TEXT: Record<CtmFlowAction, string> = {
  send_fiat: 'send the PKR payment and upload proof',
  confirm_fiat: 'confirm the PKR payment was received',
  start_crypto: 'start sending the tokens',
  prove_crypto: 'submit the token transfer proof',
  confirm_crypto: 'confirm the tokens were received',
}

/** Human-readable trade label for user-facing notifications — never exposes the raw cuid. */
const lbl = (t: { displayRef?: string | null }): string => t.displayRef ?? 'your CTM trade'

// CTM job notifications deep-link the web-push into the CTM trade room.
function notify(userId: string, type: string, title: string, body: string, metadata: Record<string, unknown>) {
  const tradeRef = typeof metadata.tradeRef === 'string' ? metadata.tradeRef : undefined
  centralNotify(userId, type, title, body, metadata, undefined, tradeRef ? `/ctm/trade/${tradeRef}` : undefined)
}

export async function runCtmTradeExpiry() {
  const now = new Date()

  // Expire trades stuck in awaiting_payment past expiresAt
  const expired = await db.ctmTrade.findMany({
    where: { status: 'awaiting_payment', expiresAt: { lte: now } },
    select: { id: true, tradeRef: true, displayRef: true, listingId: true, tokenAmount: true, buyerId: true, sellerId: true, takerFirst: true },
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

    // Buyer never paid → not a maker fault → return the maker's bond.
    await releaseMakerBond({ tradeType: 'ctm', tradeId: trade.id }).catch((err) =>
      logger.error({ err, tradeId: trade.id }, 'Failed to release maker bond on CTM expiry'),
    )

    void closeEpisode({ market: 'ctm', tradeId: trade.id, outcome: 'expired' })
    // awaiting_payment's no-show party is flow-dependent: classic = the buyer never
    // paid; taker-first = the seller (taker) never started the token transfer.
    if (trade.takerFirst) {
      notify(trade.sellerId, 'CTM_TRADE_EXPIRED', 'Trade expired', `Trade ${lbl(trade)} expired — you did not start the token transfer in time.`, { tradeRef: trade.tradeRef, displayRef: trade.displayRef })
      notify(trade.buyerId, 'CTM_TRADE_EXPIRED', 'Trade expired', `Trade ${lbl(trade)} expired — the seller did not start the token transfer in time.`, { tradeRef: trade.tradeRef, displayRef: trade.displayRef })
    } else {
      notify(trade.buyerId, 'CTM_TRADE_EXPIRED', 'Trade expired', `Trade ${lbl(trade)} expired — payment was not uploaded in time.`, { tradeRef: trade.tradeRef, displayRef: trade.displayRef })
      notify(trade.sellerId, 'CTM_TRADE_EXPIRED', 'Trade expired', `Trade ${lbl(trade)} expired — buyer did not upload payment proof in time.`, { tradeRef: trade.tradeRef, displayRef: trade.displayRef })
    }

    logger.info({ tradeRef: trade.tradeRef }, 'CTM trade expired')
  }

  if (expired.length > 0) {
    logger.info({ count: expired.length }, 'CTM trade expiry: expired trades')
  }
}

export async function runCtmProofDeadline() {
  const now = new Date()

  // ── Missed step deadlines (flow-aware) ────────────────────────────────────
  // A trade past a step deadline is handled by what its PENDING step is in that
  // trade's flow (resolver-derived), not by the raw status name — which means the
  // classic and taker-first orders are both handled from one pass:
  //   • non-terminal step → the pending actor is unresponsive → AUTO-DISPUTE,
  //     opened by the counterparty (reason keyed to the missed actor).
  //   • terminal step      → the counterparty has already delivered BOTH legs and
  //     only the final acknowledgement is late → AUTO-COMPLETE if the delivering
  //     merchant is trusted (verified/elite), else leave for admin review.
  // proofDeadlineAt and confirmDeadlineAt are never both set on an active trade, so
  // one pass over "either deadline passed" covers every enforced step in both flows.
  // Classic behavior is unchanged: payment_uploaded / seller_transferring are
  // non-terminal SELLER steps (→ dispute, opened by the buyer); proof_submitted is
  // the terminal BUYER confirm (→ auto-complete trusting the seller who delivered).
  const due = await db.ctmTrade.findMany({
    where: {
      status: { in: ['payment_uploaded', 'payment_confirmed', 'seller_transferring', 'proof_submitted'] },
      OR: [{ proofDeadlineAt: { lte: now } }, { confirmDeadlineAt: { lte: now } }],
    },
    include: {
      buyer: { include: { ctmMerchantProfile: { select: { tier: true } } } },
      seller: { include: { ctmMerchantProfile: { select: { tier: true } } } },
    },
  })

  for (const trade of due) {
    const step = ctmStepFromStatus(trade.takerFirst, trade.status)
    if (!step) continue

    // ── Non-terminal: the pending party is unresponsive → auto-dispute ────────
    if (!step.terminal) {
      const missedActorId = step.actor === 'seller' ? trade.sellerId : trade.buyerId
      const openerId = step.actor === 'seller' ? trade.buyerId : trade.sellerId
      const reason = step.actor === 'seller' ? 'seller_unresponsive' : 'buyer_unresponsive'
      const actionText = MISSED_ACTION_TEXT[step.action]

      // Every step completed so far (index < step.index) was reached in order, so if
      // all of them belong to the SAME actor now missing this deadline, the
      // counterparty has not taken a single action yet — nothing of theirs is at
      // stake, and there is no one to open a dispute against. Close the trade as
      // expired instead (no-fault, same as an untouched awaiting_payment trade).
      const counterpartyActed = ctmFlowSteps(trade.takerFirst)
        .slice(0, step.index)
        .some((s) => s.actor !== step.actor)

      if (!counterpartyActed) {
        const expiredNow = await db.$transaction(async (tx) => {
          const claimed = await tx.ctmTrade.updateMany({ where: { id: trade.id, status: trade.status }, data: { status: 'expired' } })
          if (claimed.count === 0) return false
          if (trade.listingId) {
            await tx.ctmListing.update({
              where: { id: trade.listingId },
              data: { availableAmount: { increment: trade.tokenAmount }, lockedAmount: { decrement: trade.tokenAmount } },
            })
          }
          return true
        })
        if (!expiredNow) continue

        // No dispute ruling is possible here, so treat it as no-fault, like a plain expiry.
        await releaseMakerBond({ tradeType: 'ctm', tradeId: trade.id }).catch((err) =>
          logger.error({ err, tradeId: trade.id }, 'Failed to release maker bond on CTM abandoned-step expiry'),
        )
        void closeEpisode({ market: 'ctm', tradeId: trade.id, outcome: 'expired' })

        notify(missedActorId, 'CTM_TRADE_EXPIRED', 'Trade expired', `Trade ${lbl(trade)} expired — you missed the deadline to ${actionText}.`, { tradeRef: trade.tradeRef, displayRef: trade.displayRef })
        notify(openerId, 'CTM_TRADE_EXPIRED', 'Trade expired', `Trade ${lbl(trade)} expired — the ${step.actor} missed the deadline to ${actionText} before you took any action, so it closed automatically.`, { tradeRef: trade.tradeRef, displayRef: trade.displayRef })
        logger.info({ tradeRef: trade.tradeRef, missedActor: step.actor, action: step.action, takerFirst: trade.takerFirst }, 'CTM trade auto-expired: abandoned before counterparty acted')
        continue
      }

      // CAS: only escalate a trade still in this status (a same-instant transition
      // wins and this no-ops), and only if no dispute exists yet.
      const escalated = await db.$transaction(async (tx) => {
        const existing = await tx.ctmDispute.findFirst({ where: { tradeId: trade.id }, select: { id: true } })
        if (existing) return false
        // Dispute-resume: remember the rung so the parties can still settle while the
        // auto-dispute is open — a missed deadline is often just a timezone gap, not
        // a scam. `status` still parks at `disputed` for admin tooling.
        const claimed = await tx.ctmTrade.updateMany({ where: { id: trade.id, status: trade.status }, data: { status: 'disputed', disputeResumeStatus: trade.status } })
        if (claimed.count === 0) return false
        await tx.ctmDispute.create({
          data: {
            tradeId: trade.id,
            openedById: openerId,
            reason: reason as never,
            description: `Auto-escalated: the ${step.actor} did not ${actionText} within the deadline.`,
          },
        })
        return true
      })
      if (!escalated) continue

      notify(openerId, 'CTM_AUTO_DISPUTE', 'Dispute auto-opened', `Trade ${lbl(trade)}: the ${step.actor} missed the deadline to ${actionText}. Admin will review.`, { tradeRef: trade.tradeRef, displayRef: trade.displayRef, dispute: true })
      notify(missedActorId, 'CTM_AUTO_DISPUTE', 'Dispute auto-opened', `Trade ${lbl(trade)}: you missed the deadline to ${actionText}. Admin will review.`, { tradeRef: trade.tradeRef, displayRef: trade.displayRef, dispute: true })
      logger.warn({ tradeRef: trade.tradeRef, missedActor: step.actor, action: step.action, takerFirst: trade.takerFirst }, 'CTM auto-dispute: party missed step deadline')
      continue
    }

    // ── Terminal: both legs delivered, only the final ack is late ─────────────
    // Auto-complete if the DELIVERING merchant (the counterparty of the pending
    // confirmer) is trusted; else leave for admin review. Classic: confirmer=buyer,
    // deliverer=seller. Taker-first: confirmer=seller/taker, deliverer=buyer/maker.
    const delivererId = step.actor === 'buyer' ? trade.sellerId : trade.buyerId
    const delivererTier = (step.actor === 'buyer' ? trade.seller : trade.buyer).ctmMerchantProfile?.tier
    const autoComplete = delivererTier === 'verified' || delivererTier === 'elite'

    if (!autoComplete) {
      // Clear both deadline fields so this doesn't re-fire; admin resolves manually.
      await db.ctmTrade.update({ where: { id: trade.id }, data: { confirmDeadlineAt: null, proofDeadlineAt: null } })
      logger.warn({ tradeRef: trade.tradeRef, delivererTier, takerFirst: trade.takerFirst }, 'CTM final-confirm deadline missed — admin review needed')
      continue
    }

    let streakResult: { count: number; isMilestone: boolean } = { count: 0, isMilestone: false }
    let didComplete = false
    await db.$transaction(async (tx) => {
      // CAS guard: only complete a trade still in this (terminal-from) status. If the
      // confirmer acted in the same instant, that path wins and this no-ops —
      // preventing a double streak / stats increment for one trade.
      const claimed = await tx.ctmTrade.updateMany({ where: { id: trade.id, status: trade.status }, data: { status: 'completed', completedAt: new Date(), confirmDeadlineAt: null, proofDeadlineAt: null } })
      if (claimed.count === 0) return
      didComplete = true
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
      // Bump the combined buyer↔seller streak, atomic with the auto-completion.
      streakResult = await incrementTradeStreak(tx, trade.buyerId, trade.sellerId)
      // Award airdrop points to both sides (idempotent; no-op when the flag is off).
      await awardTradePointsTx(tx, { tradeType: 'ctm', tradeId: trade.id, buyerId: trade.buyerId, sellerId: trade.sellerId, fiatAmountPKR: trade.fiatAmount })
    })

    // Confirmer acted in the same instant — that path owns the completion side effects.
    if (!didComplete) continue

    // Clean auto-completion → release the maker's bond (idempotent; no-op when off).
    await releaseMakerBond({ tradeType: 'ctm', tradeId: trade.id }).catch((err) =>
      logger.error({ err, tradeId: trade.id }, 'Failed to release maker bond on CTM auto-complete'),
    )

    if (streakResult.count > 0) {
      const streakMsg = streakResult.isMilestone
        ? `🔥 Milestone! This is your ${ordinal(streakResult.count)} completed trade together. Thanks for building trust on the platform.`
        : `🤝 ${ordinal(streakResult.count)} completed trade between you two.`
      await postCtmSystemMessage(trade.id, trade.buyerId, streakMsg)
    }

    // The party who missed the final confirmation (the pending confirmer).
    const confirmerId = step.actor === 'buyer' ? trade.buyerId : trade.sellerId
    notify(confirmerId, 'CTM_AUTO_COMPLETED', 'Trade auto-completed', `Trade ${lbl(trade)} was auto-completed because you missed the confirmation deadline.`, { tradeRef: trade.tradeRef, displayRef: trade.displayRef })
    notify(delivererId, 'CTM_AUTO_COMPLETED', 'Trade auto-completed', `Trade ${lbl(trade)} was auto-completed after the counterparty's confirmation deadline passed.`, { tradeRef: trade.tradeRef, displayRef: trade.displayRef })
    logger.info({ tradeRef: trade.tradeRef, delivererTier, takerFirst: trade.takerFirst }, 'CTM auto-completed: final confirmation deadline missed')
  }
}

export async function runCtmDisputeEscalation() {
  const escalateAfter = new Date(Date.now() - 48 * 60 * 60 * 1000)

  const staleDisputes = await db.ctmDispute.findMany({
    where: { status: 'open', createdAt: { lte: escalateAfter }, escalatedAt: null },
    select: { id: true, tradeId: true, trade: { select: { tradeRef: true, displayRef: true, buyerId: true, sellerId: true } } },
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
    select: { id: true, tradeRef: true, displayRef: true, escrowAddress: true, escrowAmount: true, buyerId: true, sellerId: true },
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
        notify(trade.buyerId, 'CTM_ESCROW_CONFIRMED', 'USDT deposit confirmed', `Your USDT deposit for trade ${lbl(trade)} has been confirmed.`, { tradeRef: trade.tradeRef, displayRef: trade.displayRef })
        notify(trade.sellerId, 'CTM_ESCROW_CONFIRMED', 'USDT escrow received', `Buyer deposited USDT for trade ${lbl(trade)}. Please confirm the PKR payment or send tokens.`, { tradeRef: trade.tradeRef, displayRef: trade.displayRef })
        logger.info({ tradeRef: trade.tradeRef, txId: matchingTx.transaction_id }, 'CTM escrow deposit auto-confirmed')
      }
    } catch (err) {
      logger.warn({ tradeRef: trade.tradeRef, err }, 'CTM escrow monitor: error checking deposit')
    }
  }
}

// Auto-pause listings for merchants inactive for >7 days
export async function runCtmInactiveMerchantPause() {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // 7 days ago

  // Find active listings whose merchant hasn't been seen in 7 days
  const staleListings = await db.ctmListing.findMany({
    where: {
      status: 'active',
      merchantProfile: {
        is: {
          OR: [
            { lastActiveAt: null },
            { lastActiveAt: { lte: cutoff } },
          ],
        },
      },
    },
    select: {
      id: true,
      listingRef: true,
      merchantProfile: { select: { userId: true, lastActiveAt: true } },
    },
  })

  for (const listing of staleListings) {
    await db.ctmListing.update({ where: { id: listing.id }, data: { status: 'paused' } })
    notify(
      listing.merchantProfile.userId,
      'CTM_LISTING_AUTO_PAUSED',
      'Listing auto-paused',
      'Your CTM listing was paused due to 7 days of inactivity. Log in and reactivate it when you are ready.',
      { listingRef: listing.listingRef },
    )
    logger.info({ listingId: listing.id, userId: listing.merchantProfile.userId }, 'CTM listing auto-paused: merchant inactive')
  }

  if (staleListings.length > 0) {
    logger.info({ count: staleListings.length }, 'CTM inactive merchant pause: listings paused')
  }
}

export async function runCtmBidExpiry() {
  const now = new Date()

  const expiredBids = await db.ctmListingBid.findMany({
    where: { status: 'pending', expiresAt: { lte: now } },
    select: { id: true, bidderId: true, listing: { select: { token: { select: { symbol: true } } } } },
  })

  for (const bid of expiredBids) {
    await db.ctmListingBid.update({ where: { id: bid.id }, data: { status: 'expired' } })
    notify(bid.bidderId, 'CTM_BID_EXPIRED', 'Bid expired', `Your bid on ${bid.listing.token.symbol} expired — the merchant did not respond in time.`, { bidId: bid.id })
  }

  // Also wind up bids the merchant ACCEPTED but the buyer never confirmed payment
  // details on in time (status accepted_pending_buyer). Acceptance locked tokens on
  // the listing (availableAmount -> lockedAmount), so the window lapsing must RELEASE
  // that lock back — otherwise the tokens stay stuck and the buyer keeps seeing a
  // dead "Complete Trade Details" prompt for a bid that can no longer be completed.
  const staleAccepted = await db.ctmListingBid.findMany({
    where: { status: 'accepted_pending_buyer', expiresAt: { lte: now } },
    select: {
      id: true, bidderId: true, listingId: true, tokenAmount: true,
      listing: { select: { merchantProfile: { select: { userId: true } }, token: { select: { symbol: true } } } },
    },
  })

  for (const bid of staleAccepted) {
    try {
      const released = await db.$transaction(async (tx) => {
        // CAS guard: only the worker that flips it out of accepted_pending_buyer
        // releases the lock, so a buyer confirming at the same instant can't double-release.
        const flipped = await tx.ctmListingBid.updateMany({
          where: { id: bid.id, status: 'accepted_pending_buyer' },
          data: { status: 'expired' },
        })
        if (flipped.count === 0) return false
        await tx.ctmListing.update({
          where: { id: bid.listingId },
          data: { availableAmount: { increment: bid.tokenAmount }, lockedAmount: { decrement: bid.tokenAmount } },
        })
        return true
      })
      if (!released) continue
      notify(bid.bidderId, 'CTM_BID_EXPIRED', 'Bid expired',
        `Your accepted bid on ${bid.listing.token.symbol} expired — you didn't complete the payment details in time.`, { bidId: bid.id })
      notify(bid.listing.merchantProfile.userId, 'CTM_BID_EXPIRED', 'Accepted bid expired',
        `An accepted bid on your ${bid.listing.token.symbol} listing expired — the buyer didn't confirm in time. The tokens are available again.`, { bidId: bid.id })
    } catch (err) {
      logger.error({ err, bidId: bid.id }, 'CTM bid expiry: failed to release accepted_pending_buyer bid')
    }
  }

  if (expiredBids.length > 0 || staleAccepted.length > 0) {
    logger.info({ pending: expiredBids.length, accepted: staleAccepted.length }, 'CTM bid expiry: expired bids')
  }
}
