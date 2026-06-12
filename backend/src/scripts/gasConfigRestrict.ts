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

// Canonical USDT/USDC token contracts per EVM chain (backendChainId → addresses).
// Correcting these fixes the "decimals returned no data (0x)" read error that
// happens when a token row holds a wrong/placeholder contract address.
const EVM_TOKEN_CONTRACTS: Record<string, { USDT: string; USDC: string }> = {
  BSC:   { USDT: '0x55d398326f99059fF775485246999027B3197955', USDC: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d' },
  ETH:   { USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7', USDC: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' },
  BASE:  { USDT: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  ARB:   { USDT: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' },
  OP:    { USDT: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', USDC: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85' },
  MATIC: { USDT: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', USDC: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' },
  AVAX:  { USDT: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', USDC: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E' },
}

async function main() {
  console.log('— Gas config update (restrict payments → BNB + Aptos) —\n')

  // ── 0. Correct EVM USDT/USDC contract addresses (fixes "decimals 0x") ────────
  for (const [chainId, contracts] of Object.entries(EVM_TOKEN_CONTRACTS)) {
    const cfg = await db.gasChainConfig.findFirst({ where: { backendChainId: chainId }, include: { tokens: true } })
    if (!cfg) continue
    for (const sym of ['USDT', 'USDC'] as const) {
      const tok = cfg.tokens.find((t) => t.symbol.toUpperCase() === sym)
      if (!tok) continue
      const want = contracts[sym]
      if ((tok.contractAddress ?? '').toLowerCase() !== want.toLowerCase()) {
        await db.gasTokenConfig.update({ where: { id: tok.id }, data: { contractAddress: want } })
        console.log(`  ✓ ${cfg.slug} ${sym}: contractAddress corrected → ${want}`)
      }
    }
  }

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
