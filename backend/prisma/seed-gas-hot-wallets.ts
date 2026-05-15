/**
 * Seed script: upsert GasHotWallet rows for TRON, BSC, and ETH.
 * Run with: npx ts-node --project tsconfig.json prisma/seed-gas-hot-wallets.ts
 *
 * Requires: GAS_MASTER_KEY and GAS_SEED_CIPHERTEXT env vars (same as the server).
 *
 * Idempotent — safe to re-run. Uses upsert so re-running after address changes
 * (mnemonic rotation) will update the address automatically.
 */

import { PrismaClient } from '@prisma/client'
import { validateGasWalletAtStartup } from '../src/lib/gas/gasWalletService'

const db = new PrismaClient()

async function main() {
  const result = validateGasWalletAtStartup()

  if (!result.configured) {
    console.error(
      '✗ GAS_MASTER_KEY / GAS_SEED_CIPHERTEXT are not set.\n' +
      '  Set them in your .env file (same values as Railway) and re-run.',
    )
    process.exit(1)
  }

  const { tronHotWallet, evmHotWallet } = result as Required<typeof result>

  const rows = [
    { chain: 'TRON' as const, address: tronHotWallet },
    { chain: 'BSC'  as const, address: evmHotWallet  },
    { chain: 'ETH'  as const, address: evmHotWallet  },
  ]

  for (const { chain, address } of rows) {
    await db.gasHotWallet.upsert({
      where:  { chain },
      create: { chain, address, isActive: true },
      update: { address },
    })
    console.log(`✓ ${chain}: ${address}`)
  }

  console.log('\n✅ GasHotWallet seed complete.')
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => db.$disconnect())
