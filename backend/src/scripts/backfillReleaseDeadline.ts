// One-time backfill: payment_confirmed USDT trades predating the release-window
// fix have releaseDeadlineAt = null, so the (now unconditional) tradeEscalation
// job will never pick them up — the `lt: now` filter doesn't match null. Stamp a
// past deadline so the next sweep escalates them to a dispute for admin review,
// exactly as if they'd just missed their (now-always-enforced) release window.
import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()

async function main() {
  const stuck = await db.trade.findMany({
    where: { status: 'payment_confirmed', releaseDeadlineAt: null },
    select: { id: true, orderRef: true, createdAt: true, buyerId: true, sellerId: true },
  })
  console.log(`Found ${stuck.length} payment_confirmed trade(s) with no release deadline:`)
  console.log(JSON.stringify(stuck, null, 2))

  if (stuck.length === 0) return

  const result = await db.trade.updateMany({
    where: { status: 'payment_confirmed', releaseDeadlineAt: null },
    data: { releaseDeadlineAt: new Date() },
  })
  console.log(`Backfilled releaseDeadlineAt on ${result.count} trade(s). The next tradeEscalation sweep (every 30 min) will auto-escalate them to a dispute for admin review.`)
}
main().then(() => db.$disconnect()).catch((e) => { console.error(e); db.$disconnect(); process.exit(1) })
