// USDT/PKR ad-bid expiry — the AdBid equivalent of ctm.jobs.ts's
// runCtmBidExpiry. Nothing previously swept stale AdBid rows: a 'pending' bid
// just sat there past its 30-min window (harmless — acceptAdBid already checks
// expiresAt), but an 'accepted_pending_buyer' bid is worse — accepting a bid
// decrements the ad's availableAmount immediately, and with no sweep to release
// it, a buyer who never finishes confirmBidDetails() left that inventory
// permanently locked out of the ad with no path back.
import { db } from '../lib/prisma'
import { logger } from '../lib/logger'
import { notify } from '../lib/notify'

export async function runAdBidExpiry(): Promise<void> {
  const now = new Date()

  const expiredBids = await db.adBid.findMany({
    where: { status: 'pending', expiresAt: { lte: now } },
    select: { id: true, bidderId: true, adId: true },
  })

  for (const bid of expiredBids) {
    await db.adBid.update({ where: { id: bid.id }, data: { status: 'expired' } })
    notify(bid.bidderId, 'AD_BID_EXPIRED', 'Bid expired', 'Your bid on a USDT listing expired — the seller did not respond in time.', { bidId: bid.id, adId: bid.adId })
  }

  // Wind up bids the ad owner ACCEPTED but the bidder never confirmed payment
  // details on in time (accepted_pending_buyer). Acceptance already decremented
  // the ad's availableAmount, so the window lapsing must restore it — otherwise
  // the amount stays stuck and the bidder keeps seeing a dead "Complete Trade
  // Details" prompt for a bid that can no longer be completed.
  const staleAccepted = await db.adBid.findMany({
    where: { status: 'accepted_pending_buyer', expiresAt: { lte: now } },
    select: { id: true, bidderId: true, adId: true, usdtAmount: true, ad: { select: { userId: true } } },
  })

  for (const bid of staleAccepted) {
    try {
      const released = await db.$transaction(async (tx) => {
        // CAS guard: only the worker that flips it out of accepted_pending_buyer
        // releases the lock, so a bidder confirming at the same instant can't double-release.
        const flipped = await tx.adBid.updateMany({
          where: { id: bid.id, status: 'accepted_pending_buyer' },
          data: { status: 'expired' },
        })
        if (flipped.count === 0) return false
        await tx.ad.update({
          where: { id: bid.adId },
          data: { availableAmount: { increment: bid.usdtAmount } },
        })
        return true
      })
      if (!released) continue
      notify(bid.bidderId, 'AD_BID_EXPIRED', 'Bid expired', 'Your accepted bid expired — you did not complete the payment details in time.', { bidId: bid.id, adId: bid.adId })
      notify(bid.ad.userId, 'AD_BID_EXPIRED', 'Accepted bid expired', 'An accepted bid on your listing expired — the buyer did not confirm in time. The amount is available again.', { bidId: bid.id, adId: bid.adId })
    } catch (err) {
      logger.error({ err, bidId: bid.id }, 'Ad bid expiry: failed to release accepted_pending_buyer bid')
    }
  }

  if (expiredBids.length > 0 || staleAccepted.length > 0) {
    logger.info({ pending: expiredBids.length, accepted: staleAccepted.length }, 'Ad bid expiry: expired bids')
  }
}
