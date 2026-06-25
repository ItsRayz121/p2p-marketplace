/**
 * One-shot go-live: turn the public referral + custom-link program ON.
 *
 * Sets the two feature flags that gate everything in the new referral hub:
 *   - gas_referral_enabled  → commission accrual + the live earnings/withdraw surface
 *   - gas_affiliate_enabled → buyer auto-discount + self-service custom links + affiliate apply
 *
 * It also seeds the program's numeric defaults ONLY IF they are not already set, so an
 * admin who later tunes them in /admin/config is never overridden by a re-run:
 *   - gas_referral_user_discount_pct  = 5   (friend discount on every referral link)
 *   - gas_referral_default_pct        = 5   (referrer commission)
 *   - gas_custom_link_max             = 2   (custom links per user)
 *   - gas_custom_link_cooldown_days   = 30  (post-delete cooldown before a slot reopens)
 *
 * Existing base codes are healed to carry the friend discount lazily on first read
 * (getOrCreateOwnCode), so no data backfill is needed here.
 *
 * Idempotent. Usage:
 *   npx tsx src/scripts/enableReferralProgram.ts
 */
import 'dotenv/config'
import '../lib/env'
import { db } from '../lib/prisma'

/** Force a flag/value to the given setting. */
async function setConfig(key: string, value: string) {
  await db.platformConfig.upsert({ where: { key }, create: { key, value }, update: { value } })
  console.log(`  set   ${key} = ${value}`)
}

/** Seed a default only when the key is missing (never clobber an admin-tuned value). */
async function ensureConfig(key: string, value: string) {
  const existing = await db.platformConfig.findUnique({ where: { key } })
  if (existing) { console.log(`  keep  ${key} = ${existing.value} (already set)`); return }
  await db.platformConfig.create({ data: { key, value } })
  console.log(`  seed  ${key} = ${value}`)
}

async function main() {
  console.log('[enable-referrals] turning the referral + custom-link program ON')
  await setConfig('gas_referral_enabled', 'true')
  await setConfig('gas_affiliate_enabled', 'true')
  await ensureConfig('gas_referral_user_discount_pct', '5')
  await ensureConfig('gas_referral_default_pct', '5')
  await ensureConfig('gas_custom_link_max', '2')
  await ensureConfig('gas_custom_link_cooldown_days', '30')
  console.log('[enable-referrals] done — flags propagate to the live server within ~15s.')
}

main()
  .catch((err) => { console.error('[enable-referrals] failed:', err); process.exit(1) })
  .finally(() => db.$disconnect())
