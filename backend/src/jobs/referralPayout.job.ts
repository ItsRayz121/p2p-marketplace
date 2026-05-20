import type { Job } from 'bullmq'
import { db } from '../lib/prisma'
import { logger } from '../lib/logger'
import { notify } from '../lib/notify'

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
    logger.debug({ userId }, 'Referral payout: bonus already paid — skipping')
    return
  }

  const config = await db.platformConfig.findUnique({ where: { key: 'referral_first_trade_bonus' } })
  const bonus = parseFloat(config?.value ?? '5')

  await db.$transaction(async (tx) => {
    const referrerWallet = await tx.wallet.findFirst({
      where: { userId: user.referredById!, coin: 'USDT' },
    })
    if (!referrerWallet) throw new Error(`Referrer wallet not found for userId: ${user.referredById}`)

    await tx.wallet.update({
      where: { id: referrerWallet.id },
      data: { balance: { increment: bonus } },
    })

    await tx.referralReward.create({
      data: {
        referrerId: user.referredById!,
        referredId: userId,
        rewardAmount: bonus,
        status: 'paid',
        paidAt: new Date(),
      },
    })

    await tx.user.update({
      where: { id: userId },
      data: { firstTradeBonusPaid: true },
    })
  })

  notify(
    user.referredById,
    'referral',
    'Referral Bonus!',
    `You earned ${bonus} USDT because someone you referred completed their first trade.`,
    { bonus, coin: 'USDT', referredUserId: userId },
  )

  logger.info({ referrerId: user.referredById, referredId: userId, bonus }, 'Referral payout processed')
}
