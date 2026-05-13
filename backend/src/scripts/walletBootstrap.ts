/* eslint-disable no-console */
/**
 * One-shot CLI to generate a master HD seed and emit the AES-256-GCM ciphertext
 * the backend expects in `WALLET_MASTER_SEED_CIPHERTEXT`.
 *
 * Usage:
 *   1) Generate a fresh master key:    openssl rand -hex 32
 *      Paste it into `WALLET_MASTER_KEY` (Railway secrets, .env.local — same value
 *      everywhere this seed will be decrypted).
 *   2) Run:                            npm run wallet:bootstrap
 *      The script prints the ciphertext. Paste it into `WALLET_MASTER_SEED_CIPHERTEXT`.
 *
 * Refuses to run if `WALLET_MASTER_SEED_CIPHERTEXT` is already set, so you can't
 * accidentally rotate the seed and orphan all existing user deposit addresses.
 */
import 'dotenv/config'
import { randomBytes, createCipheriv } from 'node:crypto'

function bail(msg: string): never {
  console.error('\n[error] ' + msg + '\n')
  process.exit(1)
}

const key = process.env.WALLET_MASTER_KEY
if (!key) bail('WALLET_MASTER_KEY is not set. Generate one with: openssl rand -hex 32')
if (!/^[0-9a-fA-F]{64}$/.test(key)) bail('WALLET_MASTER_KEY must be 64 hex chars (32 bytes).')

if (process.env.WALLET_MASTER_SEED_CIPHERTEXT) {
  bail(
    'WALLET_MASTER_SEED_CIPHERTEXT is already set in this environment.\n' +
      '  Rotating it would orphan every existing per-user deposit address.\n' +
      '  If you really need a new seed, unset the env var first and run again.',
  )
}

// Generate 64 bytes of entropy as the BIP32 master seed (no BIP39 wordlist).
const seed = randomBytes(64)

const keyBuf = Buffer.from(key, 'hex')
const iv = randomBytes(12)
const cipher = createCipheriv('aes-256-gcm', keyBuf, iv)
const ct = Buffer.concat([cipher.update(seed), cipher.final()])
const tag = cipher.getAuthTag()
keyBuf.fill(0)
seed.fill(0)

const blob = Buffer.concat([iv, tag, ct]).toString('base64')

console.log('\n[ok] Master seed generated and encrypted under WALLET_MASTER_KEY.')
console.log('\n  Set this in Railway (and any local .env that needs to decrypt deposits):')
console.log('\n    WALLET_MASTER_SEED_CIPHERTEXT=' + blob + '\n')
console.log('  Keep WALLET_MASTER_KEY and WALLET_MASTER_SEED_CIPHERTEXT secret.')
console.log('  Anyone with both can derive every user deposit address.\n')
