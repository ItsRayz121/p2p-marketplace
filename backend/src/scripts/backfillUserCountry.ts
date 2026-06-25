/**
 * One-shot backfill: resolve each user's country from their stored registrationIp.
 *
 * Only touches users that have a registrationIp but no country yet, so it's safe to
 * re-run (it resumes where it left off). Rate-limited to stay within the free ipwho.is
 * allowance (~2/sec). Private/loopback IPs and lookup failures are skipped silently.
 *
 * Usage:
 *   npx tsx src/scripts/backfillUserCountry.ts
 */
import 'dotenv/config'
import '../lib/env'
import { db } from '../lib/prisma'
import { lookupCountry } from '../lib/geoip'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const users = await db.user.findMany({
    where: { registrationIp: { not: null }, country: null },
    select: { id: true, registrationIp: true },
  })
  console.log(`[backfill-country] ${users.length} users to resolve`)

  let updated = 0, skipped = 0
  for (const u of users) {
    const info = await lookupCountry(u.registrationIp)
    if (info) {
      await db.user.update({ where: { id: u.id }, data: { country: info.country, countryCode: info.countryCode } })
      updated++
    } else {
      skipped++
    }
    await sleep(550) // stay under the free rate limit
  }

  console.log(`[backfill-country] done — ${updated} resolved, ${skipped} skipped`)
}

main()
  .catch((err) => { console.error('[backfill-country] failed:', err); process.exit(1) })
  .finally(() => db.$disconnect())
