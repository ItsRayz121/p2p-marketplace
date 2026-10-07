// Puts a trading hold on anyone who ignores an open dispute for 24 hours.
//
// A buyer can open a dispute against anyone, so a hold on the first claim would
// be abusable. Silence is different: a respondent who has not written a single
// dispute message within 24 hours is the pattern we saw with the Sidra seller
// (took the money, vanished). Honest respondents answer, so they are never held.
// An admin releases the hold once the dispute is settled.
import { db } from '../lib/prisma'
import { logger } from '../lib/logger'
import { notify } from '../lib/notify'
import { computeModerationStatus, recordModerationAction } from '../lib/moderation'
import { pauseUserListings } from '../lib/tradingHold'
import { FLAGS, isFlagEnabled } from '../services/platformFlags.service'

const SILENCE_MS = 24 * 60 * 60 * 1000
const REASON = 'No response to an open dispute within 24 hours'

export async function runDisputeAutoHold(): Promise<{ held: number }> {
  if (!(await isFlagEnabled(FLAGS.DISPUTE_AUTO_HOLD, false))) return { held: 0 }
  const cutoff = new Date(Date.now() - SILENCE_MS)

  const [usdt, ctm] = await Promise.all([
    db.dispute.findMany({
      where: { status: { not: 'resolved' }, createdAt: { lte: cutoff } },
      select: { openedById: true, trade: { select: { buyerId: true, sellerId: true } }, messages: { select: { senderId: true } } },
    }),
    db.ctmDispute.findMany({
      where: { status: { not: 'resolved' }, createdAt: { lte: cutoff } },
      select: { openedById: true, trade: { select: { buyerId: true, sellerId: true } }, messages: { select: { senderId: true } } },
    }),
  ])

  const silent = new Set<string>()
  for (const d of [...usdt, ...ctm]) {
    const respondent = d.openedById === d.trade.buyerId ? d.trade.sellerId : d.trade.buyerId
    if (!d.messages.some((m) => m.senderId === respondent)) silent.add(respondent)
  }
  if (silent.size === 0) return { held: 0 }

  const users = await db.user.findMany({
    where: { id: { in: [...silent] }, tradingHold: false, role: { notIn: ['admin', 'super_admin'] } },
    select: { id: true, isBanned: true, isSuspended: true, bannedUntil: true, underReview: true },
  })

  let held = 0
  for (const u of users) {
    try {
      await db.user.update({
        where: { id: u.id },
        data: { tradingHold: true, tradingHoldReason: REASON, tradingHoldSince: new Date(), tradingHoldBy: null },
      })
      await pauseUserListings(u.id)
      const status = computeModerationStatus(u)
      await recordModerationAction({
        targetUserId: u.id, moderatorId: null, action: 'trading_hold', reason: REASON, previousStatus: status, newStatus: status,
      })
      notify(
        u.id, 'moderation', 'Trading hold on your account',
        'A dispute against you has had no reply for 24 hours. Open Messages and answer it to get the hold lifted.',
        { action: 'trading_hold', auto: true }, undefined, '/messages',
      )
      held++
    } catch (err) {
      logger.error({ err, userId: u.id }, 'dispute auto-hold failed for user')
    }
  }
  if (held) logger.info({ held }, 'Dispute auto-hold applied')
  return { held }
}
