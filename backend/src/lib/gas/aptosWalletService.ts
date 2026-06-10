/**
 * Aptos wallet service — SLIP-0010 ed25519, sha3-256 address derivation.
 *
 * Derivation path: m/44'/637'/0'/0'/0'  (BIP44 coin type 637 for Aptos)
 * Address format:  0x + hex( sha3_256( public_key || 0x00 ) )
 *                  (0x00 = Ed25519SingleKey scheme byte)
 *
 * sha3-256 is available in Node 18+ via OpenSSL.
 *
 * Security rules (same as all other wallet services):
 *   - Private key seeds are zeroed immediately after use.
 *   - The derived address (public data) is safe to cache.
 *   - Private keys are NEVER returned across module boundaries.
 */

import { createHash } from 'node:crypto'
import { decryptGasSeed, gasWalletIsConfigured } from './gasWalletService'
import { deriveSlip10Ed25519, ed25519PublicKeyFromSeed } from './nonEvmDerivation'

// ── Constants ─────────────────────────────────────────────────────────────────

const APTOS_SLIP10_PATH = "m/44'/637'/0'/0'/0'"

// Aptos address: 0x + 64 hex chars (32-byte sha3-256 hash)
const APTOS_ADDR_RE = /^0x[0-9a-fA-F]{64}$/

// Ed25519 single-key scheme identifier appended before hashing
const SINGLE_KEY_SCHEME = Buffer.from([0x00])

// ── Address validation ────────────────────────────────────────────────────────

export function validateAptosAddress(addr: string): boolean {
  return APTOS_ADDR_RE.test(addr)
}

// ── Address derivation ────────────────────────────────────────────────────────

function deriveAptosAddress(seed: Buffer): string {
  const { privateKey } = deriveSlip10Ed25519(seed, APTOS_SLIP10_PATH)
  try {
    const pubKey  = ed25519PublicKeyFromSeed(privateKey)
    const payload = Buffer.concat([pubKey, SINGLE_KEY_SCHEME])
    const hash    = Buffer.from(createHash('sha3-256').update(payload).digest())
    return '0x' + hash.toString('hex')
  } finally {
    privateKey.fill(0)
  }
}

// ── Delivery / refund key helper ───────────────────────────────────────────────

/**
 * Derive the Aptos Ed25519 private key seed (32 bytes) for signing outgoing
 * transfers (USDT refunds). The returned Buffer is the raw private key — the
 * caller MUST zero it immediately after use (in a finally block).
 */
export function deriveAptosPrivateKeyForDelivery(seed: Buffer): Buffer {
  const { privateKey } = deriveSlip10Ed25519(seed, APTOS_SLIP10_PATH)
  return privateKey // caller responsibility to zero
}

// ── Address cache ─────────────────────────────────────────────────────────────

let _aptosAddressCache: string | null = null

/**
 * Return the derived Aptos hot wallet address.
 * Returns null if the mnemonic system is not configured.
 * Cached after first successful derivation.
 */
export function getAptosHotWalletAddress(): string | null {
  if (!gasWalletIsConfigured()) return null
  if (_aptosAddressCache) return _aptosAddressCache
  const seed = decryptGasSeed()
  try {
    _aptosAddressCache = deriveAptosAddress(seed)
    return _aptosAddressCache
  } finally {
    seed.fill(0)
  }
}

export function clearAptosAddressCache(): void {
  _aptosAddressCache = null
}

// ── Startup validation ────────────────────────────────────────────────────────

export function validateAptosAtStartup(): {
  configured: boolean
  address?: string
  warning?: string
  error?: string
} {
  if (!gasWalletIsConfigured()) return { configured: false }
  try {
    // Verify sha3-256 is available
    createHash('sha3-256').update(Buffer.from('test')).digest()
  } catch {
    return { configured: true, error: 'sha3-256 not available in this Node.js build — Aptos address derivation disabled' }
  }
  try {
    const seed = decryptGasSeed()
    let address: string
    try {
      address = deriveAptosAddress(seed)
    } finally {
      seed.fill(0)
    }
    if (!validateAptosAddress(address)) {
      return { configured: true, error: `Derived Aptos address has unexpected format: ${address}` }
    }
    _aptosAddressCache = address
    return { configured: true, address }
  } catch (err) {
    return {
      configured: true,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
