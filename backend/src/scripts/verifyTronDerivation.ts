/**
 * Phase 1 — TRON Wallet Verification Script
 *
 * LOCAL ONLY. Run on your own PC. Never run on Railway.
 * This script never sends data anywhere. No network calls are made.
 * Your mnemonic is never written to disk, logs, or shell history.
 *
 * Usage:
 *   cd "g:\P2P Final\backend"
 *   npx tsx src/scripts/verifyTronDerivation.ts
 */

import { pbkdf2Sync, createHash } from 'node:crypto'
import * as readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { HDKey } from 'viem/accounts'
import { privateKeyToAccount } from 'viem/accounts'

// ─── TRON Address Encoding ────────────────────────────────────────────────────
// TRON uses the same secp256k1 curve as Ethereum.
// The difference is only address encoding:
//   ETH  → 0x + 20 bytes (hex)
//   TRON → Base58Check(0x41 + same 20 bytes)

const BASE58_CHARS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function base58Encode(buf: Buffer): string {
  let num = BigInt('0x' + buf.toString('hex'))
  let result = ''
  const base = BigInt(58)
  while (num > 0n) {
    result = BASE58_CHARS[Number(num % base)]! + result
    num = num / base
  }
  for (let i = 0; i < buf.length && buf[i] === 0; i++) {
    result = '1' + result
  }
  return result
}

function ethAddressToTron(ethAddr: string): string {
  const raw = Buffer.from('41' + ethAddr.slice(2).toLowerCase(), 'hex')
  const h1  = createHash('sha256').update(raw).digest()
  const h2  = createHash('sha256').update(h1).digest()
  const checksum = h2.subarray(0, 4)
  return base58Encode(Buffer.concat([raw, checksum]))
}

// ─── BIP39 Mnemonic → 64-byte Seed ───────────────────────────────────────────
// Standard BIP39: PBKDF2-HMAC-SHA512, 2048 rounds
// No external bip39 package needed — Node.js crypto has everything required.

function mnemonicToSeed(mnemonic: string): Buffer {
  return pbkdf2Sync(
    mnemonic.trim().normalize('NFKD'),
    'mnemonic'.normalize('NFKD'),   // BIP39 uses "mnemonic" as the salt prefix
    2048,
    64,
    'sha512'
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const rl = readline.createInterface({ input, output })

  console.log('')
  console.log('══════════════════════════════════════════════════════')
  console.log('  RupChain — Phase 1: TRON Wallet Verification         ')
  console.log('══════════════════════════════════════════════════════')
  console.log('  LOCAL ONLY. No network calls. Nothing is logged.')
  console.log('  Type carefully — backspace works normally.')
  console.log('══════════════════════════════════════════════════════')
  console.log('')

  const mnemonic  = await rl.question('STEP 1 — Enter your mnemonic phrase (words separated by spaces):\n> ')
  console.log('')
  const knownAddr = await rl.question('STEP 2 — Enter your current TRON hot wallet address (starts with T):\n> ')
  rl.close()

  console.log('')
  console.log('Deriving addresses from mnemonic — please wait a few seconds...')
  console.log('')

  // Basic sanity check on word count
  const wordCount = mnemonic.trim().split(/\s+/).length
  if (![12, 15, 18, 21, 24].includes(wordCount)) {
    console.log(`⚠  WARNING: You entered ${wordCount} words. Standard mnemonics are 12, 15, 18, 21, or 24 words.`)
    console.log('   If this is wrong, results will not match.')
    console.log('')
  }

  const seed = mnemonicToSeed(mnemonic)

  // These are the most common paths used by TronLink, Trust Wallet, Ledger, MetaMask
  const derivationPaths = [
    "m/44'/195'/0'/0/0",   // ← TronLink / Trust Wallet default (most likely)
    "m/44'/195'/0'/0/1",   // index 1 — if hot wallet is the 2nd derived address
    "m/44'/195'/0'/0/2",   // index 2
    "m/44'/195'/0'",       // older Ledger firmware path
  ]

  console.log('Derived addresses:')
  console.log('─'.repeat(70))

  let foundPath: string | null = null
  let foundEvmAddress: string | null = null

  for (const path of derivationPaths) {
    try {
      const hdkey = HDKey.fromMasterSeed(seed)
      const child = hdkey.derive(path)

      if (!child.privateKey) {
        console.log(`  ${path.padEnd(30)}  →  (no private key — derivation failed)`)
        continue
      }

      const pkHex    = ('0x' + Buffer.from(child.privateKey).toString('hex')) as `0x${string}`
      const account  = privateKeyToAccount(pkHex)
      const tronAddr = ethAddressToTron(account.address)
      const evmAddr  = account.address
      const isMatch  = tronAddr === knownAddr.trim()

      if (isMatch) {
        console.log(`  ${path.padEnd(30)}  →  ${tronAddr}  ✓ MATCH`)
        console.log(`${''.padEnd(34)}EVM: ${evmAddr}`)
        foundPath       = path
        foundEvmAddress = evmAddr
      } else {
        console.log(`  ${path.padEnd(30)}  →  ${tronAddr}`)
        console.log(`${''.padEnd(34)}EVM: ${evmAddr}`)
      }
      console.log('')

      // Zero the private key buffer before it goes out of scope
      child.privateKey.fill(0)

    } catch (err) {
      console.log(`  ${path.padEnd(30)}  →  ERROR: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Zero the seed buffer
  seed.fill(0)

  // ─── Final Result ──────────────────────────────────────────────────────────

  console.log('═'.repeat(70))

  if (foundPath) {
    console.log('')
    console.log('  ✅  PASS — Your TRON hot wallet IS derived from this mnemonic.')
    console.log('')
    console.log(`  Matching derivation path : ${foundPath}`)
    console.log(`  EVM address (same key)   : ${foundEvmAddress}`)
    console.log('')
    console.log('  What this means:')
    console.log('  ─ Your TRON private key can be derived from the mnemonic at the path above.')
    console.log('  ─ The EVM address shown is what your BSC / ETH hot wallet would be')
    console.log('    IF those wallets also come from the same mnemonic at m/44\'/60\'/...')
    console.log('')
    console.log('  Next step: Share this PASS result with your developer.')
    console.log('  Keep note of the matching path.')
    console.log('')
  } else {
    console.log('')
    console.log('  ❌  FAIL — No matching address was found.')
    console.log('')
    console.log('  Possible reasons:')
    console.log('  A) You typed the wrong mnemonic (belongs to a different wallet)')
    console.log('  B) Your mnemonic has a passphrase (a secret "25th word")')
    console.log('     → Re-run and add the passphrase after your last word')
    console.log('  C) The TRON wallet was imported manually — it is a standalone')
    console.log('     private key, NOT derived from any mnemonic')
    console.log('  D) The TRON address you entered has a typo')
    console.log('')
    console.log('  Do NOT proceed to Phase 2 until you get a PASS result.')
    console.log('')
  }

  console.log('═'.repeat(70))
  console.log('')
}

main().catch(err => {
  console.error('')
  console.error('[ERROR]', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
