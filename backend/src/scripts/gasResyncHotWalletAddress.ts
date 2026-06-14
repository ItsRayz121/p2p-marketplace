/**
 * Re-sync GasHotWallet.address to the live, mnemonic-derived address.
 *
 *   npm run gas:resync-hot-wallets           # read-only drift report
 *   npm run gas:resync-hot-wallets -- --fix  # update any drifted rows
 *
 * Why this exists:
 *   The Treasury Overview, balance monitor, and cached balances all read the
 *   STORED GasHotWallet.address column — NOT the live-derived address. If the
 *   derivation method changes (e.g. the SUI blake2b fix 1f685af), the stored
 *   address can drift from the address the delivery keypair actually controls.
 *   Symptom seen 2026-06-14: admin showed the SUI hot wallet as the OLD sha3
 *   address 0x1990cc… (with the stranded 2 SUI) while delivery used the correct
 *   blake2b address 0x85ab44… (empty). Funding the displayed address would have
 *   sent more SUI to the dead address.
 *
 *   This script re-derives every row's address from the live mnemonic and, with
 *   --fix, updates the stored value so admin display == the spendable delivery
 *   address. Read-only by default. Safe to run against production.
 *
 *   Each chain's derivation module is loaded LAZILY so a missing optional dep
 *   (e.g. @ton/crypto absent from a local node_modules) only skips that one
 *   chain instead of aborting the whole run.
 *
 * After --fix, click "Refresh Balance" on each updated chain in admin (or wait
 * for the 30-min monitor cycle) so the cached balance reflects the new address.
 */

import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { db as sharedDb } from '../lib/prisma'

// `railway run` injects the INTERNAL DATABASE_URL (postgres.railway.internal),
// which is only reachable from inside Railway's network — so a local run can't
// connect. Set RESYNC_DATABASE_URL to Railway's PUBLIC database URL to run this
// from your machine while still getting the gas seed from `railway run`.
const overrideDbUrl = process.env.RESYNC_DATABASE_URL?.trim()
const db = overrideDbUrl
  ? new PrismaClient({ datasources: { db: { url: overrideDbUrl } } })
  : sharedDb

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', gray: '\x1b[90m',
}

const EVM_CHAINS = new Set(['BSC', 'ETH', 'BASE', 'ARB', 'OP', 'MATIC', 'AVAX'])

/**
 * Live mnemonic-derived address for a stored hot-wallet row, or null if the
 * derivation isn't available (unsupported chain or a failed lazy import).
 */
async function deriveLive(chain: string, hdIndex: number): Promise<string | null> {
  try {
    if (chain === 'SUI')  return (await import('../lib/gas/suiWalletService')).getSuiHotWalletAddress()
    if (chain === 'SOL')  return (await import('../lib/gas/solanaWalletService')).getSolanaHotWalletAddress()
    if (chain === 'TON')  return (await import('../lib/gas/tonWalletService')).getTonHotWalletAddress()
    if (chain === 'TRON') return (await import('../lib/gas/gasWalletService')).getTronHotWalletAddress(hdIndex)
    if (EVM_CHAINS.has(chain)) return (await import('../lib/gas/gasWalletService')).getEvmHotWalletAddress(hdIndex)
    return null
  } catch (e) {
    console.log(`  ${C.yellow}(could not load ${chain} derivation: ${(e as Error).message.split('\n')[0]})${C.reset}`)
    return null
  }
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

async function main() {
  const doFix = process.argv.includes('--fix')
  console.log(`\n${C.bold}${C.cyan}Gas Hot Wallet Address Re-sync${C.reset}  ${C.dim}(${doFix ? 'FIX mode' : 'read-only'})${C.reset}`)
  console.log(`${C.dim}DB: ${overrideDbUrl ? 'RESYNC_DATABASE_URL (public override)' : 'DATABASE_URL (default)'}${C.reset}\n`)

  const wallets = await db.gasHotWallet.findMany({ orderBy: { chain: 'asc' } })
  if (wallets.length === 0) { console.log(`${C.yellow}No GasHotWallet rows found.${C.reset}\n`); return }

  let drifted = 0
  let fixed = 0
  let skipped = 0

  for (const w of wallets) {
    const live = await deriveLive(w.chain, w.hdIndex)
    if (!live) { console.log(`${C.gray}• ${w.chain.padEnd(6)} (hd ${w.hdIndex}) — no live derivation; skipped${C.reset}`); skipped++; continue }

    if (sameAddress(w.address, live)) {
      console.log(`${C.green}✓ ${w.chain.padEnd(6)}${C.reset} ${C.dim}(hd ${w.hdIndex})${C.reset} in sync  ${C.gray}${w.address}${C.reset}`)
      continue
    }

    drifted++
    console.log(`${C.red}✗ ${w.chain.padEnd(6)} DRIFT${C.reset} ${C.dim}(hd ${w.hdIndex})${C.reset}`)
    console.log(`    stored: ${C.yellow}${w.address}${C.reset}`)
    console.log(`    live:   ${C.green}${live}${C.reset}`)

    if (doFix) {
      await db.gasHotWallet.update({ where: { id: w.id }, data: { address: live } })
      fixed++
      console.log(`    ${C.green}→ updated stored address to live value${C.reset}`)
    }
  }

  console.log('')
  console.log(`${C.bold}Summary:${C.reset} ${wallets.length} wallet(s), ${drifted} drifted${doFix ? `, ${fixed} fixed` : ''}${skipped ? `, ${skipped} skipped` : ''}.`)
  if (drifted > 0 && !doFix) {
    console.log(`${C.yellow}Re-run with  --fix  to update the drifted address(es).${C.reset}`)
  } else if (fixed > 0) {
    console.log(`${C.green}Done. Now click "Refresh Balance" on each fixed chain in admin (or wait for the 30-min monitor) to refresh the cached balance.${C.reset}`)
  }
  console.log('')
}

main()
  .then(async () => { await db.$disconnect(); process.exit(0) })
  .catch(async (e) => { console.error(`\n${C.red}Re-sync crashed:${C.reset}`, e); await db.$disconnect(); process.exit(1) })
