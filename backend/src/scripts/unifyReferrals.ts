/**
 * One-shot backfill: unify referral attribution across the platform's two systems.
 *
 * Historically the signup referral (`User.referredById`, set when someone registered
 * with your code) and the gas referral (`GasReferral`, created only when someone used
 * your gas code at checkout) were independent — so the same person could be your
 * signup-referral but not your gas-referral, and vice-versa. The two surfaces now
 * behave as one (see lib/gas/gas.referral.ts `bindReferral`), and this script heals
 * the existing rows so the live counts/earnings start from the truth.
 *
 * First-touch is respected: whoever a user is already bound to in EITHER system stays
 * the owner; we only fill in the missing side. Self-references are skipped.
 *
 * Idempotent: re-running it is a no-op once every user is consistent.
 *
 * Usage:
 *   npx tsx src/scripts/unifyReferrals.ts          (apply)
 *   npx tsx src/scripts/unifyReferrals.ts --dry    (report only, no writes)
 */

import 'dotenv/config'
import '../lib/env'
import { db } from '../lib/prisma'
import { getOrCreateOwnCode } from '../lib/gas/gas.referral'

const DRY = process.argv.includes('--dry')

async function main() {
  console.log(`[unify-referrals] starting${DRY ? ' (dry run — no writes)' : ''}`)

  // Cache the owner's default gas code id so we don't re-query per binding.
  const ownerCodeId = new Map<string, string>()
  async function defaultGasCodeId(ownerId: string): Promise<string> {
    const cached = ownerCodeId.get(ownerId)
    if (cached) return cached
    const code = await getOrCreateOwnCode(ownerId)
    ownerCodeId.set(ownerId, code.id)
    return code.id
  }

  let gasCreated = 0
  let signupHealed = 0

  // ── 1. signup → gas: users referred at signup but with no gas binding ──────────
  const signupReferred = await db.user.findMany({
    where: { referredById: { not: null } },
    select: { id: true, referredById: true },
  })
  for (const u of signupReferred) {
    const ownerId = u.referredById!
    if (ownerId === u.id) continue // never self-bind
    const existing = await db.gasReferral.findUnique({ where: { referredId: u.id }, select: { id: true } })
    if (existing) continue
    if (DRY) { gasCreated++; continue }
    const codeId = await defaultGasCodeId(ownerId)
    try {
      await db.gasReferral.create({ data: { referredId: u.id, referrerId: ownerId, codeId } })
      gasCreated++
    } catch { /* unique race / already exists — skip */ }
  }

  // ── 2. gas → signup: users gas-bound but with no signup attribution ────────────
  const gasReferred = await db.gasReferral.findMany({ select: { referredId: true, referrerId: true } })
  for (const g of gasReferred) {
    if (g.referrerId === g.referredId) continue
    const res = DRY
      ? await db.user.count({ where: { id: g.referredId, referredById: null } })
      : (await db.user.updateMany({ where: { id: g.referredId, referredById: null }, data: { referredById: g.referrerId } })).count
    if (res > 0) signupHealed++
  }

  console.log(`[unify-referrals] gas bindings created from signup referrals: ${gasCreated}`)
  console.log(`[unify-referrals] signup attributions healed from gas referrals: ${signupHealed}`)
  console.log(`[unify-referrals] done${DRY ? ' (dry run)' : ''}`)
}

main()
  .catch((err) => { console.error('[unify-referrals] failed:', err); process.exit(1) })
  .finally(() => db.$disconnect())
