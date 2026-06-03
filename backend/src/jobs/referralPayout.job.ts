import type { Job } from 'bullmq'
import { db } from '../lib/prisma'
import { logger } from '../lib/logger'

// NOTE: Automatic referral cash rewards are DISABLED.
// Previously this job credited the referrer's wallet from platform funds on the
// referred user's first trade. That is a financial-loss risk, so it has been
// replaced with a `pending` ReferralReward record for manual admin approval.
// No money moves automatically. See referral.routes.ts / admin review flow.
export async function processReferralPayout(job: Job) {
  const { userId } = job.data as { userId: string; tradeId?: string }

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { referredById: true, firstTradeBonusPaid: true },
  })

  if (!user) {
    logger.warn({ userId }, 'Referral payout: user not found')
    return
  }

  if (!user.referredById) {
    logger.debug({ userId }, 'Referral payout: user has no referrer — skipping')
    return
  }

  if (user.firstTradeBonusPaid) {
    logger.debug({ userId }, 'Referral payout: already recorded — skipping')
    return
  }

  const config = await db.platformConfig.findUnique({ where: { key: 'referral_first_trade_bonus' } })
  const bonus = parseFloat(config?.value ?? '0')

  // Record the qualifying referral as PENDING for admin review — do NOT credit any wallet.
  await db.$transaction(async (tx) => {
    await tx.referralReward.create({
      data: {
        referrerId: user.referredById!,
        referredId: userId,
        rewardAmount: bonus,
        status: 'pending',
      },
    })

    await tx.user.update({
      where: { id: userId },
      data: { firstTradeBonusPaid: true },
    })
  })

  logger.info(
    { referrerId: user.referredById, referredId: userId },
    'Referral qualifying trade recorded as pending (admin-approved rewards only)',
  )
}
