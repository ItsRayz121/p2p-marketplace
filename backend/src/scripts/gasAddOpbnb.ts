/**
 * One-off, idempotent: create the opBNB gas chain + native BNB token (2026-07-02).
 *
 * opBNB is a BSC L2 (chainId 204). Its native gas coin is also BNB, but it lives
 * on its OWN network with its own RPC + balance — it is NOT the same as BNB on
 * BSC mainnet. Migration 20260702210000 added the `OPBNB` value to the GasChain
 * enum and gas.chains.ts already models GAS_CHAINS.OPBNB, but the matching
 * GasChainConfig ROW was never seeded into prod — so opBNB never appeared under
 * Gas → Chains, and orders wrongly modelled as a BSC-nested "opBNB Gas" token
 * delivered BNB on BSC mainnet instead of opBNB.
 *
 * This creates the real opBNB chain (slug OPBNB, backendChainId OPBNB) plus its
 * native BNB token so:
 *   • opBNB shows up under Gas → Chains as its own chain, and
 *   • orders placed on it resolve chain = opBNB and deliver on the opBNB network.
 *
 * The chain is created INACTIVE + not delivery-live: after running this, fund the
 * EVM hot wallet with BNB ON opBNB, then flip Active / Visible in the admin. The
 * old BSC-nested "opBNB Gas" token should be deleted (Gas → Chains → BSC → Tokens).
 *
 * Run on the target DB (e.g. Railway):  npm run gas:add-opbnb
 * Idempotent — safe to re-run. Reversible via the admin chain/token config.
 */

import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

const OPBNB_PRESETS = [0.0005, 0.001, 0.002, 0.005]

async function main() {
  console.log('— Add opBNB gas chain + native BNB token —\n')

  const chain = await db.gasChainConfig.upsert({
    where: { slug: 'OPBNB' },
    // Preserve admin-tuned fields on re-run: only (re)assert identity + backendChainId.
    update: {
      name: 'opBNB',
      backendChainId: 'OPBNB',
      networkLabel: 'opBNB',
      explorerBase: 'https://opbnb.bscscan.com',
    },
    create: {
      slug: 'OPBNB',
      name: 'opBNB',
      symbol: 'BNB',
      category: 'bnb',
      networkLabel: 'opBNB',
      addressType: 'EVM',
      explorerBase: 'https://opbnb.bscscan.com',
      backendChainId: 'OPBNB',
      chainType: 'EVM',
      feeMethod: 'EVM_RPC',
      coingeckoId: 'binancecoin',
      platformFeeUsdt: 0.25,
      isActive: false,        // Go-Live after funding the hot wallet on opBNB.
      isVisibleToUsers: false,
      readinessState: 'inactive',
      displayOrder: 12,
    },
  })
  console.log(`✓ Chain ready: ${chain.name} (${chain.slug}) — backendChainId=${chain.backendChainId}`)

  const existing = await db.gasTokenConfig.findFirst({
    where: { chainConfigId: chain.id, tokenType: 'native' },
  })

  if (existing) {
    await db.gasTokenConfig.update({
      where: { id: existing.id },
      data: {
        name: 'BNB (opBNB)', symbol: 'BNB', tokenType: 'native',
        contractAddress: null, priceSymbol: 'BNB',
        ...(Array.isArray(existing.presetAmounts) && (existing.presetAmounts as unknown[]).length > 0
          ? {}
          : { presetAmounts: OPBNB_PRESETS }),
      },
    })
    console.log(`  ↺ Native BNB (opBNB) token updated (id ${existing.id}).`)
  } else {
    const created = await db.gasTokenConfig.create({
      data: {
        chainConfigId: chain.id,
        name: 'BNB (opBNB)',
        symbol: 'BNB',
        tokenType: 'native',
        contractAddress: null,
        priceSymbol: 'BNB',
        presetAmounts: OPBNB_PRESETS,
        platformFeeUsdt: null, // inherit chain default
        minAmount: 0.0005,
        maxUsdValue: 10,
        isActive: false,
        isVisibleToUsers: false,
        isArchived: false,
        displayOrder: 1,
      },
    })
    console.log(`  + Native BNB (opBNB) token created (id ${created.id}).`)
  }

  console.log('\n✅ Done. opBNB now exists as its own chain under Gas → Chains.')
  console.log('   Next: fund the EVM hot wallet with BNB *on opBNB*, then flip')
  console.log('   the chain + token Active/Visible. Delete the old BSC-nested')
  console.log('   "opBNB Gas" token (Gas → Chains → BNB Smart Chain → Tokens).')
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => db.$disconnect())
