/**
 * Gas wallet service — mnemonic-based key derivation.
 *
 * Architecture:
 *   GAS_MASTER_KEY (AES-256-GCM key)
 *   + GAS_SEED_CIPHERTEXT (encrypted BIP39 seed)
 *   → decryptGasSeed() → 64-byte seed
 *   → derive*(seed, index) → private key for a specific chain
 *
 * Rules enforced here:
 *   - Private key bytes are zeroed immediately after use
 *   - Seed buffer is NEVER cached — caller must zero it in a finally block
 *   - Addresses (public data) may be derived safely at startup
 *   - Private keys are never returned to callers outside this file;
 *     delivery functions call derive* inline and own the lifecycle
 */

import { createDecipheriv, createHash } from 'node:crypto'
import { HDKey } from 'viem/accounts'
import { privateKeyToAccount } from 'viem/accounts'
import { env } from '../env'

// ── Index conventions — fixed once production wallets are live ────────────────

/** Index 0 → hot wallet — signs outgoing delivery transactions */
export const HOT_WALLET_INDEX = 0

// ── TRON address encoding ─────────────────────────────────────────────────────
// TRON uses secp256k1 (same curve as EVM). The only difference is the address
// format: Base58Check( 0x41 || last-20-bytes-of-keccak256(pubkey) ) instead of
// the EVM hex encoding. Since viem gives us the EVM address directly, we just
// re-encode it into TRON format.

const BASE58_CHARS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function base58Encode(buf: Buffer): string {
  let num = BigInt('0x' + buf.toString('hex'))
  let result = ''
  const base = BigInt(58)
  while (num > 0n) {
    result = BASE58_CHARS[Number(num % base)]! + result
    num = num / base
  }
  for (let i = 0; i < buf.length && buf[i] === 0; i++) result = '1' + result
  return result
}

/** Convert a viem EVM address (0x...) to its TRON equivalent (T...) */
export function ethAddressToTron(ethAddr: string): string {
  const raw = Buffer.from('41' + ethAddr.slice(2).toLowerCase(), 'hex')
  const h1  = createHash('sha256').update(raw).digest()
  const h2  = createHash('sha256').update(h1).digest()
  return base58Encode(Buffer.concat([raw, h2.subarray(0, 4)]))
}

// ── Configuration check ────────────────────────────────────────────────────────

/** Returns true when both GAS_MASTER_KEY and GAS_SEED_CIPHERTEXT are set. */
export function gasWalletIsConfigured(): boolean {
  return !!(env.GAS_MASTER_KEY && env.GAS_SEED_CIPHERTEXT)
}

// ── Decryption ─────────────────────────────────────────────────────────────────

/**
 * Decrypt GAS_SEED_CIPHERTEXT with GAS_MASTER_KEY.
 * Returns the raw 64-byte BIP39 seed.
 *
 * IMPORTANT: the caller MUST call seed.fill(0) in a finally block.
 * Never cache this buffer. Never log it.
 */
export function decryptGasSeed(): Buffer {
  if (!env.GAS_MASTER_KEY || !env.GAS_SEED_CIPHERTEXT) {
    throw new Error(
      'Gas wallet not configured: GAS_MASTER_KEY and GAS_SEED_CIPHERTEXT must both be set',
    )
  }
  const buf = Buffer.from(env.GAS_SEED_CIPHERTEXT, 'base64')
  if (buf.length < 12 + 16 + 1) {
    throw new Error('GAS_SEED_CIPHERTEXT is malformed (too short)')
  }
  const iv  = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const ct  = buf.subarray(28)
  const key = Buffer.from(env.GAS_MASTER_KEY, 'hex')
  const dc  = createDecipheriv('aes-256-gcm', key, iv)
  dc.setAuthTag(tag)
  const seed = Buffer.concat([dc.update(ct), dc.final()])
  key.fill(0)
  return seed
}

// ── Key derivation ─────────────────────────────────────────────────────────────

/**
 * Derive a TRON private key at m/44'/195'/0'/0/{index}.
 * Returns plain hex WITHOUT 0x prefix — the format TronWeb expects.
 *
 * Use this value immediately and do not store it. The internal byte buffer
 * is zeroed before returning; the returned string cannot be zeroed (JS
 * strings are immutable) — minimise its scope.
 */
export function deriveTronPrivateKeyHex(seed: Buffer, index: number): string {
  const hdkey = HDKey.fromMasterSeed(seed)
  const child = hdkey.derive(`m/44'/195'/0'/0/${index}`)
  if (!child.privateKey) throw new Error('TRON HD derivation produced no private key')
  const hex = Buffer.from(child.privateKey).toString('hex')
  child.privateKey.fill(0)
  return hex
}

/**
 * Derive the TRON address (public — safe to log and cache) at a given index.
 * Does NOT return the private key.
 */
function deriveTronAddress(seed: Buffer, index: number): string {
  const hdkey = HDKey.fromMasterSeed(seed)
  const child = hdkey.derive(`m/44'/195'/0'/0/${index}`)
  if (!child.privateKey) throw new Error('TRON HD derivation produced no private key')
  const pkHex   = ('0x' + Buffer.from(child.privateKey).toString('hex')) as `0x${string}`
  child.privateKey.fill(0)
  const account = privateKeyToAccount(pkHex)
  return ethAddressToTron(account.address)
}

// ── Startup validation ─────────────────────────────────────────────────────────

/**
 * Boot-time sanity check for the gas wallet mnemonic system.
 *
 * Validates that:
 *   - GAS_MASTER_KEY and GAS_SEED_CIPHERTEXT are either both set or both unset.
 *     Half-configured is a deploy mistake the server refuses to start with.
 *   - When both are set, the ciphertext decrypts and produces a valid T... address.
 *     Catches a typo'd ciphertext or wrong master key before any request is served.
 *
 * Returns { configured: boolean, tronHotWallet?: string }.
 * Throws on misconfiguration — let the exception propagate to kill the process.
 */
export function validateGasWalletAtStartup(): {
  configured: boolean
  tronHotWallet?: string
} {
  const hasKey = !!env.GAS_MASTER_KEY
  const hasCt  = !!env.GAS_SEED_CIPHERTEXT

  if (hasKey !== hasCt) {
    throw new Error(
      'Gas wallet is half-configured: GAS_MASTER_KEY and GAS_SEED_CIPHERTEXT must ' +
      'both be set or both unset. Check Railway environment variables.',
    )
  }

  if (!hasKey) {
    return { configured: false }
  }

  const seed = decryptGasSeed()
  try {
    const tronHotWallet = deriveTronAddress(seed, HOT_WALLET_INDEX)
    if (!/^T[A-Za-z1-9]{33}$/.test(tronHotWallet)) {
      throw new Error(
        `Gas wallet: derived TRON address has unexpected format: ${tronHotWallet}`,
      )
    }
    return { configured: true, tronHotWallet }
  } finally {
    seed.fill(0)
  }
}
