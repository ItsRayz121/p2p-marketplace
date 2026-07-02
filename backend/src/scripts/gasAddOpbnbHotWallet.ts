/**
 * One-off, idempotent: create the OPBNB GasHotWallet row (2026-07-02).
 *
 * Activating the opBNB chain in admin requires an ACTIVE GasHotWallet row for
 * chain OPBNB (see admin.routes.ts chain-activation prerequisites). opBNB shares
 * the EVM hot-wallet ADDRESS with BSC (same key, chainId 204), so instead of
 * needing GAS_MASTER_KEY / GAS_SEED_CIPHERTEXT locally, this copies the address
 * straight from the existing BSC GasHotWallet row.
 *
 * Also normalises the opBNB chain's DB rpcUrl/rpcUrlFallback to opBNB public RPCs
 * (they may show BSC defaults in the Edit form). Note: native balance + delivery
 * for opBNB use env.OPBNB_RPC_URL in code (gas.balance / gas.delivery), so this
 * is just to keep the admin UI honest.
 *
 * Run on the target DB (e.g. Railway):  npm run gas:add-opbnb-hotwallet
 * Idempotent — safe to re-run.
 */

import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

const OPBNB_RPC_PRIMARY  = 'https://opbnb-mainnet-rpc.bnbchain.org'
const OPBNB_RPC_FALLBACK = 'https://opbnb-rpc.publicnode.com'

async function main() {
  console.log('— Add opBNB hot-wallet row —\n')

  const bsc = await db.gasHotWallet.findFirst({ where: { chain: 'BSC' } })
  if (!bsc) {
    console.error('✗ No BSC GasHotWallet row found — run seed-gas-hot-wallets first, then re-run.')
    process.exit(1)
  }

  const row = await db.gasHotWallet.upsert({
    where:  { chain_hdIndex: { chain: 'OPBNB', hdIndex: 0 } },
    create: { chain: 'OPBNB', address: bsc.address, isActive: true, hdIndex: 0 },
    update: { address: bsc.address, isActive: true },
  })
  console.log(`✓ OPBNB hot wallet ready: ${row.address} (active)`)

  // Normalise the chain's stored RPC URLs so the admin Edit form doesn't show BSC.
  const chain = await db.gasChainConfig.findUnique({ where: { slug: 'OPBNB' } })
  if (chain) {
    await db.gasChainConfig.update({
      where: { id: chain.id },
      data:  { rpcUrl: OPBNB_RPC_PRIMARY, rpcUrlFallback: OPBNB_RPC_FALLBACK },
    })
    console.log(`✓ opBNB chain RPC URLs set to opBNB endpoints.`)
  }

  console.log('\n✅ Done. You can now activate the opBNB chain in admin.')
  console.log('   (Ensure the EVM hot wallet holds BNB *on opBNB* before going Delivery Live.)')
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => db.$disconnect())
