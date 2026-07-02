/**
 * One-off, idempotent opBNB GO-LIVE (2026-07-02).
 *
 * Runs the two admin actions that were deliberately left manual after
 * `gas:add-opbnb` seeded the chain INACTIVE (the hot wallet was under-funded and
 * going live under-funded would fail real deliveries). The operator has now
 * confirmed the EVM hot wallet is funded with BNB *on opBNB*, so this:
 *
 *   1. DELETES the old, mismodeled BSC-nested "opBNB Gas" token — the one that
 *      wrongly delivered BNB on BSC mainnet instead of opBNB. Any GasFeeOrder that
 *      referenced it is left intact (relation is onDelete: SetNull). A token is
 *      only deleted if it is NOT under the real OPBNB chain. If a giveaway campaign
 *      still points at it (required plain-string ref, no FK), it is SKIPPED with a
 *      loud warning rather than orphaning the campaign.
 *
 *   2. Flips the real opBNB chain live: isActive + isVisibleToUsers +
 *      readinessState='stable' (public gas page requires beta|stable to be visible
 *      AND orderable — see lib/gas/chainMeta.ts), and its native BNB (opBNB) token
 *      Active + Visible.
 *
 * Prereq: `npm run gas:add-opbnb` (chain + native token rows) and
 *         `npm run gas:add-opbnb-hotwallet` (OPBNB hot-wallet row) already ran.
 *
 * Run on the target DB (e.g. Railway):  npm run gas:opbnb-go-live
 * Idempotent — safe to re-run. Reversible via the admin Chain/Token config.
 */

import 'dotenv/config' // load backend/.env for local runs (Railway injects env directly)
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

async function main() {
  console.log('— opBNB GO-LIVE (delete old token + flip chain/token live) —\n')

  const chain = await db.gasChainConfig.findUnique({
    where: { slug: 'OPBNB' },
    include: { tokens: true },
  })
  if (!chain) {
    console.error('✗ OPBNB chain config not found. Run `npm run gas:add-opbnb` first, then re-run.')
    process.exit(1)
  }

  // ── 1. Delete the old BSC-nested "opBNB" gas token(s) ────────────────────────
  // Match any token whose name/symbol references opBNB but lives under a DIFFERENT
  // chain than the real OPBNB chain (i.e. the BSC-nested mismodel).
  const stale = await db.gasTokenConfig.findMany({
    where: {
      chainConfigId: { not: chain.id },
      OR: [
        { name: { contains: 'opbnb', mode: 'insensitive' } },
        { name: { contains: 'opBNB', mode: 'insensitive' } },
      ],
    },
    include: { chain: { select: { slug: true, name: true } } },
  })

  if (stale.length === 0) {
    console.log('  ✓ No old BSC-nested opBNB token found (already deleted or never existed).')
  }
  for (const tok of stale) {
    const giveawayRefs = await db.gasGiveawayCampaign.count({ where: { gasTokenConfigId: tok.id } })
    if (giveawayRefs > 0) {
      console.warn(
        `  ⚠ SKIP delete of "${tok.name}" (id ${tok.id}, under ${tok.chain.slug}) — ` +
        `${giveawayRefs} giveaway campaign(s) still reference it. Repoint/close those first.`,
      )
      continue
    }
    const orderRefs = await db.gasFeeOrder.count({ where: { gasTokenConfigId: tok.id } })
    await db.gasTokenConfig.delete({ where: { id: tok.id } })
    console.log(
      `  ✓ Deleted old token "${tok.name}" (id ${tok.id}) under ${tok.chain.slug}` +
      (orderRefs > 0 ? ` — ${orderRefs} historical order(s) kept, gasTokenConfigId set null.` : '.'),
    )
  }

  // ── 2. Flip the real opBNB chain + native token live ─────────────────────────
  await db.gasChainConfig.update({
    where: { id: chain.id },
    data: { isActive: true, isVisibleToUsers: true, isArchived: false, readinessState: 'stable' },
  })
  console.log(`  ✓ Chain ${chain.name} (${chain.slug}) → Active + Visible + readiness=stable`)

  const native = chain.tokens.find((t) => t.tokenType === 'native')
  if (!native) {
    console.warn('  ⚠ Native BNB (opBNB) token row not found — run `npm run gas:add-opbnb` to create it.')
  } else {
    await db.gasTokenConfig.update({
      where: { id: native.id },
      data: { isActive: true, isVisibleToUsers: true, isArchived: false },
    })
    console.log(`  ✓ Native token "${native.name}" (id ${native.id}) → Active + Visible`)
  }

  console.log('\n✅ Done. opBNB is live: visible + orderable on the public /gas page,')
  console.log('   delivering BNB on the opBNB network. Reversible via admin Chain/Token config.')
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => db.$disconnect())
