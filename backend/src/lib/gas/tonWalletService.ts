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

// Public TON HTTP API v2 gateway used as a keyless last-resort fallback. The
// keyless public toncenter tier is hard rate-limited and frequently 5xx's on
// getSeqno/sendBoc, so the REAL resilience comes from the orbs ton-access
// fallback below (decentralised + unthrottled, no API key required).
const TON_PUBLIC_TONCENTER = 'https://toncenter.com'

export interface TonEndpoint {
  /** Full JSON-RPC URL for TonClient ({ endpoint }) — e.g. https://…/api/v2/jsonRPC */
  jsonRpcUrl: string
  /** Base for REST v2 calls; append `/getAddressBalance`, `/getMasterchainInfo`, `/jetton/…`. */
  restBase: string
  /** API key to send (X-API-Key header / TonClient apiKey). Only the keyed operator primary. */
  apiKey?: string
  /** Human label for logs/diagnostics. */
  label: string
}

// orbs ton-access resolves an unthrottled, keyless endpoint via a config lookup.
// Cache it so we don't re-fetch that config on every balance read / delivery.
let _orbsCache: { url: string; at: number } | null = null
const ORBS_TTL_MS = 10 * 60_000

async function resolveOrbsEndpoint(): Promise<string | null> {
  if (_orbsCache && Date.now() - _orbsCache.at < ORBS_TTL_MS) return _orbsCache.url
  try {
    const { getHttpEndpoint } = await import('@orbs-network/ton-access')
    const url = await getHttpEndpoint() // mainnet toncenter-api-v2 jsonRPC, keyless
    _orbsCache = { url, at: Date.now() }
    return url
  } catch (err) {
    // Surface why the orbs fallback was skipped — otherwise a failed resolution is
    // invisible and TON delivery silently degrades to operator + public toncenter only.
    console.warn('[ton] orbs ton-access endpoint resolution failed; falling back to toncenter:', err instanceof Error ? err.message : String(err))
    return null
  }
}

function toncenterEndpoint(base: string, apiKey: string | undefined, label: string): TonEndpoint {
  const b = base.replace(/\/$/, '')
  return { jsonRpcUrl: `${b}/api/v2/jsonRPC`, restBase: `${b}/api/v2`, ...(apiKey ? { apiKey } : {}), label }
}

/**
 * Ordered, de-duplicated TON endpoints to try, async because the orbs fallback is
 * resolved over the network:
 *   1. operator primary (TON_ENDPOINT_URL) with TON_API_KEY if configured;
 *   2. orbs ton-access — decentralised, unthrottled, keyless (the real fallback);
 *   3. public toncenter.com (keyless last resort).
 * Only the operator primary carries the API key — a toncenter key isn't valid
 * on a different provider.
 */
export async function getTonEndpoints(): Promise<TonEndpoint[]> {
  const out: TonEndpoint[] = []
  const seen = new Set<string>()
  const push = (ep: TonEndpoint | null) => {
    if (!ep || seen.has(ep.jsonRpcUrl)) return
    seen.add(ep.jsonRpcUrl)
    out.push(ep)
  }

  push(toncenterEndpoint(env.TON_ENDPOINT_URL, env.TON_API_KEY || undefined, 'operator'))

  const orbs = await resolveOrbsEndpoint()
  if (orbs) push({ jsonRpcUrl: orbs, restBase: orbs.replace(/\/jsonRPC$/i, ''), label: 'orbs-ton-access' })

  push(toncenterEndpoint(TON_PUBLIC_TONCENTER, undefined, 'toncenter-public'))
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
  for (const ep of await getTonEndpoints()) {
    try {
      const url = `${ep.restBase}/getAddressBalance?address=${encodeURIComponent(address)}`
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (ep.apiKey) headers['X-API-Key'] = ep.apiKey

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
  for (const ep of await getTonEndpoints()) {
    const start = Date.now()
    try {
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (ep.apiKey) headers['X-API-Key'] = ep.apiKey

      const res = await fetch(`${ep.restBase}/getMasterchainInfo`, {
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
