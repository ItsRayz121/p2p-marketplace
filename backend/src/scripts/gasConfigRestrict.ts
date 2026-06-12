/**
 * One-off, idempotent gas config update (2026-06-12).
 *
 * Applies three admin-approved configuration changes that live in the DB (not code):
 *
 *   1. Aptos USDT/USDC fungible-asset metadata addresses — so their balances show in
 *      the hot-wallet token view (and so token delivery can later be enabled). DISPLAY
 *      ONLY: `deliveryLive` is left untouched (still false by default), so a wrong
 *      address can only show a 0 balance — it can never move funds until a super-admin
 *      flips delivery live in the UI. ⚠ VERIFY these addresses before going live.
 *
 *   2. Base + Base USDC — activated for ADMIN visibility only. Externally-deposited
 *      USDC on Base will now appear in the wallet token view. Base stays hidden from
 *      users (isVisibleToUsers=false) so it is NOT offered as a payment option.
 *
 *   3. Restrict gas payments to BNB (BSC) + Aptos (APT) only. Every other chain has
 *      isVisibleToUsers set to false, removing it from the public /gas-fee/chains list.
 *      Hot wallets stay active so refunds/visibility on those chains keep working.
 *
 * Run on the target DB (e.g. Railway):  npm run gas:config-restrict
 * Idempotent — safe to run multiple times. Reversible via the admin Chain/Token config.
 */

import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

// ⚠ VERIFY before enabling delivery. Canonical Aptos fungible-asset metadata addresses.
// These are wired for DISPLAY only here (deliveryLive untouched).
const APTOS_USDC_FA = '0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b'
const APTOS_USDT_FA = '0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b'

// backendChainId values allowed to accept user gas payments.
const PAYMENT_CHAINS = ['BSC', 'APT']

async function main() {
  console.log('— Gas config update (restrict payments → BNB + Aptos) —\n')

  // ── 1. Aptos token FA metadata addresses ─────────────────────────────────────
  const aptos = await db.gasChainConfig.findFirst({
    where: { OR: [{ backendChainId: 'APT' }, { slug: { in: ['APT', 'APTOS'] } }] },
    include: { tokens: true },
  })
  if (!aptos) {
    console.warn('⚠ Aptos chain config not found — create it under Gas Chains first, then re-run.')
  } else {
    for (const [symbol, addr] of [['USDC', APTOS_USDC_FA], ['USDT', APTOS_USDT_FA]] as const) {
      const tok = aptos.tokens.find((t) => t.symbol.toUpperCase() === symbol)
      if (!tok) { console.warn(`  ⚠ Aptos ${symbol} token row not found — skipping`); continue }
      await db.gasTokenConfig.update({
        where: { id: tok.id },
        data: { contractAddress: addr, isActive: true },
      })
      console.log(`  ✓ Aptos ${symbol}: contractAddress set + active (delivery still gated, deliveryLive=${tok.deliveryLive})`)
    }
    if (aptos.chainType !== 'APTOS') {
      await db.gasChainConfig.update({ where: { id: aptos.id }, data: { chainType: 'APTOS' } })
      console.log('  ✓ Aptos chainType → APTOS')
    }
  }

  // ── 2. Base — admin visibility only (hidden from users) ──────────────────────
  const base = await db.gasChainConfig.findUnique({ where: { slug: 'BASE' }, include: { tokens: true } })
  if (!base) {
    console.warn('⚠ Base chain config not found — skipping.')
  } else {
    await db.gasChainConfig.update({ where: { id: base.id }, data: { isActive: true, isVisibleToUsers: false } })
    const usdc = base.tokens.find((t) => t.symbol.toUpperCase() === 'USDC')
    if (usdc) {
      await db.gasTokenConfig.update({ where: { id: usdc.id }, data: { isActive: true } })
      console.log('  ✓ Base + Base USDC active for admin wallet view (Base hidden from users)')
    } else {
      console.warn('  ⚠ Base USDC token row not found.')
    }
  }

  // ── 3. Restrict user payments to BNB (BSC) + Aptos (APT) ─────────────────────
  const all = await db.gasChainConfig.findMany()
  for (const c of all) {
    const allowed = c.backendChainId != null && PAYMENT_CHAINS.includes(c.backendChainId)
    if (allowed && !c.isVisibleToUsers) {
      await db.gasChainConfig.update({ where: { id: c.id }, data: { isVisibleToUsers: true } })
      console.log(`  ✓ ${c.slug}: payments ENABLED (visible to users)`)
    } else if (!allowed && c.isVisibleToUsers) {
      await db.gasChainConfig.update({ where: { id: c.id }, data: { isVisibleToUsers: false } })
      console.log(`  ✓ ${c.slug}: payments DISABLED (hidden from users)`)
    }
  }

  console.log('\n✅ Done. User-facing gas payment chains: BNB (BSC) + Aptos (APT) only.')
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => db.$disconnect())
