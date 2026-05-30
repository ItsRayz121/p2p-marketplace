/**
 * Phase 2 — Encrypt your BIP39 mnemonic into GAS_SEED_CIPHERTEXT
 *
 * LOCAL ONLY. Run on your own PC. Never run on Railway.
 * This script never sends data anywhere. No network calls are made.
 * Your mnemonic is never written to disk, logs, or shell history.
 *
 * Prerequisites:
 *   1. Generate GAS_MASTER_KEY:
 *      node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *      Save that value somewhere secure (password manager).
 *
 *   2. Set GAS_MASTER_KEY in your local terminal session:
 *      $env:GAS_MASTER_KEY = "paste-your-64-char-hex-here"
 *
 *   3. Run this script:
 *      npx tsx src/scripts/encryptGasMnemonic.ts
 *
 *   4. Copy the GAS_SEED_CIPHERTEXT value it prints and add it to Railway.
 */

import { pbkdf2Sync, createCipheriv, randomBytes } from 'node:crypto'
import * as readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

async function main() {
  console.log('')
  console.log('══════════════════════════════════════════════════════')
  console.log('  RupChain — Phase 2: Encrypt Gas Wallet Mnemonic      ')
  console.log('══════════════════════════════════════════════════════')
  console.log('  LOCAL ONLY. No network calls. Nothing is logged.')
  console.log('  Your mnemonic is never written to disk.')
  console.log('══════════════════════════════════════════════════════')
  console.log('')

  // ── Validate GAS_MASTER_KEY is set ────────────────────────────────────────

  const masterKeyHex = process.env['GAS_MASTER_KEY']

  if (!masterKeyHex) {
    console.error('  ❌  ERROR: GAS_MASTER_KEY is not set in this terminal session.')
    console.error('')
    console.error('  Fix: Run this in PowerShell first, then re-run this script:')
    console.error('')
    console.error('    $env:GAS_MASTER_KEY = "your-64-char-hex-key"')
    console.error('')
    console.error('  To generate a new key (run once, save it securely):')
    console.error('    node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"')
    process.exit(1)
  }

  if (!/^[0-9a-fA-F]{64}$/.test(masterKeyHex)) {
    console.error('  ❌  ERROR: GAS_MASTER_KEY must be exactly 64 hex characters (32 bytes).')
    console.error(`  You provided ${masterKeyHex.length} characters.`)
    process.exit(1)
  }

  // ── Guard: refuse to run if ciphertext is already set ─────────────────────
  // This prevents accidentally re-encrypting a different mnemonic and
  // overwriting the one already in production.

  if (process.env['GAS_SEED_CIPHERTEXT']) {
    console.error('  ❌  ERROR: GAS_SEED_CIPHERTEXT is already set in this terminal session.')
    console.error('')
    console.error('  This guard exists to prevent accidentally overwriting a live ciphertext.')
    console.error('  If you truly need to re-encrypt, unset GAS_SEED_CIPHERTEXT first:')
    console.error('    Remove-Item Env:GAS_SEED_CIPHERTEXT')
    process.exit(1)
  }

  // ── Read mnemonic interactively ───────────────────────────────────────────

  const rl = readline.createInterface({ input, output })

  const mnemonic = await rl.question('STEP 1 — Enter your mnemonic phrase (words separated by spaces):\n> ')
  console.log('')
  rl.close()

  const wordCount = mnemonic.trim().split(/\s+/).length
  if (![12, 15, 18, 21, 24].includes(wordCount)) {
    console.log(`  ⚠  WARNING: You entered ${wordCount} words. Standard mnemonics are 12, 15, 18, 21, or 24 words.`)
    console.log('     Continuing — but double-check your phrase if this looks wrong.')
    console.log('')
  }

  console.log('  Encrypting — please wait...')
  console.log('')

  // ── BIP39: mnemonic → 64-byte seed ────────────────────────────────────────

  const seed = pbkdf2Sync(
    mnemonic.trim().normalize('NFKD'),
    'mnemonic'.normalize('NFKD'),
    2048,
    64,
    'sha512'
  )

  // ── AES-256-GCM encrypt the seed ──────────────────────────────────────────
  // Layout: iv(12 bytes) || authTag(16 bytes) || ciphertext(64 bytes)
  // Total:  92 bytes → ~124 chars base64

  const key    = Buffer.from(masterKeyHex, 'hex')
  const iv     = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct     = Buffer.concat([cipher.update(seed), cipher.final()])
  const tag    = cipher.getAuthTag()

  // Zero sensitive buffers immediately after use
  key.fill(0)
  seed.fill(0)

  const ciphertext = Buffer.concat([iv, tag, ct]).toString('base64')

  // ── Print result ──────────────────────────────────────────────────────────

  console.log('══════════════════════════════════════════════════════')
  console.log('  ✅  SUCCESS — Your mnemonic has been encrypted.')
  console.log('══════════════════════════════════════════════════════')
  console.log('')
  console.log('  Copy the line below and add it as a Railway variable:')
  console.log('')
  console.log(`  GAS_SEED_CIPHERTEXT=${ciphertext}`)
  console.log('')
  console.log('══════════════════════════════════════════════════════')
  console.log('  IMPORTANT — Read before closing this window:')
  console.log('══════════════════════════════════════════════════════')
  console.log('')
  console.log('  1. Copy GAS_SEED_CIPHERTEXT now — this is the only time it is shown.')
  console.log('  2. Add GAS_MASTER_KEY to Railway (the hex key you set above).')
  console.log('  3. Add GAS_SEED_CIPHERTEXT to Railway (the value printed above).')
  console.log('  4. Do NOT commit either value to git.')
  console.log('  5. Do NOT share this terminal output in screenshots or chat.')
  console.log('  6. After adding to Railway, close this terminal window.')
  console.log('')
  console.log('  GAS_MASTER_KEY + GAS_SEED_CIPHERTEXT together can derive')
  console.log('  every private key in your gas wallet system. Treat them')
  console.log('  with the same care as your mnemonic itself.')
  console.log('')
}

main().catch(err => {
  console.error('')
  console.error('[ERROR]', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
