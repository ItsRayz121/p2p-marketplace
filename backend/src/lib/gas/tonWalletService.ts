/**
 * TON wallet service — SLIP-0010 ed25519 key derivation, HTTP API balance.
 *
 * Derivation path: m/44'/607'/0'/0'  (SLIP-0010 compatible path for TON)
 * Address format:  Real WalletContractV4 (V4R2) raw address derived via @ton/ton.
 *                  StateInit hash is computed by WalletContractV4.create().address.
 * Chain status:    beta — delivery enabled via @ton/ton WalletContractV4
 *
 * Security rules:
 *   - Private key seeds are zeroed after use.
 *   - Stored address is public data derived from the public key (safe to cache).
 */

import { Address, WalletContractV4 } from '@ton/ton'
import { env } from '../env'
import { decryptGasSeed, gasWalletIsConfigured } from './gasWalletService'
import { deriveSlip10Ed25519, ed25519PublicKeyFromSeed } from './nonEvmDerivation'
import type { RpcHealthResult } from './gas.balance'

// ── Constants ─────────────────────────────────────────────────────────────────

const TON_SLIP10_PATH = "m/44'/607'/0'/0'"

// Free public TON HTTP API v2 endpoint(s) used as fallbacks when the operator's
// primary endpoint returns a transient 5xx / network error. toncenter.com is the
// canonical public gateway. Operators should still set a keyed primary via
// TON_ENDPOINT_URL for rate limits; these only catch primary outages.
const TON_PUBLIC_FALLBACKS = ['https://toncenter.com']

export interface TonEndpoint {
  /** Base URL with no trailing slash, e.g. https://toncenter.com */
  baseUrl: string
  /** Whether this is the operator-configured primary (gets the API key). */
  isPrimary: boolean
}

/**
 * Ordered, de-duplicated list of TON endpoints to try: operator primary first,
 * then free public fallbacks. Only the primary carries the API key (a toncenter
 * key is not valid on a different provider).
 */
export function getTonEndpointsInOrder(): TonEndpoint[] {
  const primary = env.TON_ENDPOINT_URL.replace(/\/$/, '')
  const seen = new Set<string>()
  const out: TonEndpoint[] = []
  for (const [i, base] of [primary, ...TON_PUBLIC_FALLBACKS].entries()) {
    const url = base.replace(/\/$/, '')
    if (seen.has(url)) continue
    seen.add(url)
    out.push({ baseUrl: url, isPrimary: i === 0 })
  }
  return out
}

// TON raw address regex: workchain_id:64hex_chars
// (this is the format we generate — not the user-friendly bounceable/non-bounceable form)
const TON_RAW_ADDR_RE = /^0:[0-9a-f]{64}$/i

// ── Address format helpers ────────────────────────────────────────────────────

/**
 * Convert a raw TON address (0:hex64) to user-friendly non-bounceable format (UQ...).
 * Non-bounceable is standard for deposit addresses — TON sent to a non-existent
 * bounceable address bounces back; non-bounceable prevents that.
 */
export function tonRawToFriendly(rawAddr: string): string {
  try {
    const addr = Address.parse(rawAddr)
    return addr.toString({ bounceable: false, urlSafe: true })
  } catch {
    return rawAddr // fallback: return as-is if parsing fails
  }
}

export function validateTonAddress(addr: string): boolean {
  // Accept raw format (0:hex64) or user-friendly format (48-char base64url)
  return TON_RAW_ADDR_RE.test(addr) || /^[A-Za-z0-9+/_-]{48}$/.test(addr)
}

// ── Key + address derivation ───────────────────────────────────────────────────

/**
 * Derive the TON V4R2 hot wallet address from the BIP39 seed.
 * Uses WalletContractV4 to compute the real StateInit-based address.
 * Derivation path: m/44'/607'/0'/0' (SLIP-0010 compatible for TON)
 */
function deriveTonPublicKeyAndAddress(seed: Buffer): { publicKey: Buffer; address: string } {
  const { privateKey } = deriveSlip10Ed25519(seed, TON_SLIP10_PATH)
  try {
    const publicKey = ed25519PublicKeyFromSeed(privateKey)
    const wallet = WalletContractV4.create({ workchain: 0, publicKey: Buffer.from(publicKey) })
    // Raw format (0:hex64) — accepted by TON HTTP API and consistent with address validation
    return { publicKey: Buffer.from(publicKey), address: wallet.address.toRawString() }
  } finally {
    privateKey.fill(0)
  }
}

// ── Delivery key helper ───────────────────────────────────────────────────────

/**
 * Derive the TON V4R2 keypair for delivery signing.
 * Returns { privateKey (32 bytes), publicKey (32 bytes) }.
 * Caller MUST zero both Buffers immediately after use (in a finally block).
 */
export function deriveTonKeypairForDelivery(seed: Buffer): { privateKey: Buffer; publicKey: Buffer } {
  const { privateKey } = deriveSlip10Ed25519(seed, TON_SLIP10_PATH)
  const publicKey = ed25519PublicKeyFromSeed(privateKey)
  return { privateKey, publicKey: Buffer.from(publicKey) } // caller responsibility to zero
}

// ── Address cache ─────────────────────────────────────────────────────────────

let _tonAddressCache: string | null = null

export function getTonHotWalletAddress(): string | null {
  if (!gasWalletIsConfigured()) return null
  if (_tonAddressCache) return _tonAddressCache
  const seed = decryptGasSeed()
  try {
    const { address } = deriveTonPublicKeyAndAddress(seed)
    _tonAddressCache = address
    return _tonAddressCache
  } finally {
    seed.fill(0)
  }
}

export function clearTonAddressCache(): void {
  _tonAddressCache = null
}

/** Returns the TON hot wallet address in user-friendly non-bounceable format (UQ...). */
export function getTonHotWalletFriendlyAddress(): string | null {
  const raw = getTonHotWalletAddress()
  if (!raw) return null
  return tonRawToFriendly(raw)
}

// ── Startup validation ────────────────────────────────────────────────────────

export function validateTonAtStartup(): {
  configured: boolean
  address?: string
  warning?: string
  error?: string
} {
  if (!gasWalletIsConfigured()) return { configured: false }
  try {
    const seed = decryptGasSeed()
    let address: string
    try {
      const result = deriveTonPublicKeyAndAddress(seed)
      address = result.address
    } finally {
      seed.fill(0)
    }

    if (!TON_RAW_ADDR_RE.test(address)) {
      return { configured: true, error: `Derived TON address has unexpected format: ${address}` }
    }

    _tonAddressCache = address
    return { configured: true, address }
  } catch (err) {
    return {
      configured: true,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ── Balance fetching ──────────────────────────────────────────────────────────

/**
 * Fetch TON balance via TON HTTP API v2 (toncenter.com or self-hosted).
 * Returns balance in TON (not nanotons).
 */
export async function getTonBalance(address: string): Promise<number> {
  let lastErr: unknown
  for (const ep of getTonEndpointsInOrder()) {
    try {
      const url = `${ep.baseUrl}/api/v2/getAddressBalance?address=${encodeURIComponent(address)}`
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (ep.isPrimary && env.TON_API_KEY) headers['X-API-Key'] = env.TON_API_KEY

      const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) })
      if (!res.ok) throw new Error(`TON API getAddressBalance HTTP ${res.status}`)
      const data = await res.json() as { ok: boolean; result?: string; error?: string }
      if (!data.ok) throw new Error(`TON API error: ${data.error}`)
      const nanotons = parseInt(data.result ?? '0', 10)
      return nanotons / 1e9  // nanotons → TON
    } catch (err) {
      lastErr = err // try the next endpoint
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('TON API getAddressBalance failed on all endpoints')
}

// ── RPC health check ──────────────────────────────────────────────────────────

export async function checkTonRpc(): Promise<RpcHealthResult> {
  let lastResult: RpcHealthResult = { reachable: false, latencyMs: 0, error: 'no TON endpoint configured' }
  for (const ep of getTonEndpointsInOrder()) {
    const start = Date.now()
    try {
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (ep.isPrimary && env.TON_API_KEY) headers['X-API-Key'] = env.TON_API_KEY

      const res = await fetch(`${ep.baseUrl}/api/v2/getMasterchainInfo`, {
        headers,
        signal: AbortSignal.timeout(8_000),
      })
      const latencyMs = Date.now() - start
      if (!res.ok) { lastResult = { reachable: false, latencyMs, error: `HTTP ${res.status}` }; continue }
      const data = await res.json() as { ok: boolean; result?: { last?: { seqno?: number } }; error?: string }
      if (!data.ok) { lastResult = { reachable: false, latencyMs, error: data.error ?? 'API returned ok:false' }; continue }
      const blockNumber = data.result?.last?.seqno
      return { reachable: true, latencyMs, ...(blockNumber !== undefined ? { blockNumber } : {}) }
    } catch (err) {
      lastResult = { reachable: false, latencyMs: Date.now() - start, error: err instanceof Error ? err.message : String(err) }
    }
  }
  return lastResult
}

// ── Dry-run delivery check ────────────────────────────────────────────────────

export async function dryRunTonDelivery(toAddress: string, amountTon: number): Promise<{
  ok: boolean
  hotWalletAddress: string | null
  hotWalletBalance: number | null
  toAddressValid: boolean
  rpc: RpcHealthResult
  warning?: string
  error?: string
}> {
  const hotWalletAddress = getTonHotWalletAddress()
  const toAddressValid = validateTonAddress(toAddress)
  const rpc = await checkTonRpc()

  let hotWalletBalance: number | null = null
  let error: string | undefined

  if (!hotWalletAddress) {
    error = 'TON hot wallet not configured (mnemonic system required)'
  } else if (!rpc.reachable) {
    error = `TON RPC unreachable: ${rpc.error}`
  } else if (!toAddressValid) {
    error = `Invalid TON address: ${toAddress}`
  } else {
    try {
      hotWalletBalance = await getTonBalance(hotWalletAddress)
      if (hotWalletBalance < amountTon) {
        error = `Insufficient balance: ${hotWalletBalance} TON < ${amountTon} TON required`
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
  }

  return {
    ok: !error,
    hotWalletAddress,
    hotWalletBalance,
    toAddressValid,
    rpc,
    ...(error ? { error } : {}),
  }
}
