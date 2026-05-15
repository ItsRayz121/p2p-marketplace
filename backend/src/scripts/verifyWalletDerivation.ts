/**
 * Verify that every GasHotWallet row's address matches the mnemonic-derived address.
 * Run after mnemonic rotation, new deployments, or any wallet configuration change.
 *
 * Usage:
 *   npx ts-node src/scripts/verifyWalletDerivation.ts
 */

import { db } from '../lib/prisma'
import { gasWalletIsConfigured, getTronHotWalletAddress, getEvmHotWalletAddress } from '../lib/gas/gasWalletService'
import { getSolanaHotWalletAddress } from '../lib/gas/solanaWalletService'
import { getTonHotWalletAddress } from '../lib/gas/tonWalletService'
import { getSuiHotWalletAddress } from '../lib/gas/suiWalletService'

async function main() {
  if (!gasWalletIsConfigured()) {
    console.error('❌ Gas mnemonic not configured')
    process.exit(1)
  }

  const wallets = await db.gasHotWallet.findMany({ orderBy: [{ chain: 'asc' }, { hdIndex: 'asc' }] })

  console.log(`\n${'='.repeat(70)}`)
  console.log('WALLET DERIVATION VERIFICATION')
  console.log(`${'='.repeat(70)}\n`)

  let allOk = true

  for (const w of wallets) {
    let derivedAddress: string | null = null
    let error: string | null = null

    try {
      if (w.chain === 'TRON') {
        derivedAddress = getTronHotWalletAddress(w.hdIndex)
      } else if (w.chain === 'SOL') {
        derivedAddress = getSolanaHotWalletAddress()
      } else if (w.chain === 'TON') {
        derivedAddress = getTonHotWalletAddress()
      } else if (w.chain === 'SUI') {
        derivedAddress = getSuiHotWalletAddress()
      } else {
        derivedAddress = getEvmHotWalletAddress(w.hdIndex)
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }

    const match = derivedAddress
      ? derivedAddress.toLowerCase() === w.address.toLowerCase()
      : null

    const icon = match === true ? '✅' : match === false ? '❌' : '⚠️'
    if (match === false) allOk = false

    console.log(`${icon}  ${w.chain.padEnd(6)} [idx=${w.hdIndex}]`)
    console.log(`    DB address:      ${w.address}`)
    console.log(`    Derived address: ${derivedAddress ?? '(error)'}`)
    if (error) console.log(`    Error:           ${error}`)
    console.log()
  }

  console.log(`${'='.repeat(70)}`)
  if (allOk) {
    console.log('✅ All wallet addresses match derived addresses.')
  } else {
    console.log('❌ MISMATCH DETECTED — wallets do not match mnemonic derivation.')
    console.log('   Do NOT process orders until this is resolved.')
  }
  console.log()
  process.exit(allOk ? 0 : 1)
}

main().catch((err) => { console.error(err); process.exit(1) })
