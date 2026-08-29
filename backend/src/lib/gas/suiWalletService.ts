/**
 * SUI wallet service — SLIP-0010 ed25519, blake2b-256 address, JSON-RPC balance.
 *
 * Derivation path: m/44'/784'/0'/0'/0'  (Mysten standard for SUI)
 * Address format:  0x + hex(blake2b-256( 0x00 || public_key ))[0:64]
 *                  (signature_scheme_flag = 0x00 for ed25519)
 * Chain status:    beta — delivery enabled via @mysten/sui
 *
 * Address hashing — IMPORTANT:
 *   The address MUST be derived with the SAME blake2b-256 the delivery keypair
 *   uses, or deposits land on an address the keypair can't sign for. We used to
 *   hash via Node's `createHash('blake2b-256')`, which is ONLY exposed on
 *   OpenSSL builds that ship BLAKE2b-256 as a digest — many builds (incl. some
 *   Node 24 / Windows / Railway images) do NOT, and the old code then silently
 *   fell back to sha3-256, producing a WRONG, unspendable address. Symptom:
 *   balance shows funded, but delivery fails with "No valid gas coins found for
 *   the transaction" (the keypair's real blake2b address is empty).
 *   We now derive the address via the Mysten SDK's own Ed25519PublicKey (pure-JS
 *   blake2b, host-independent) so display/balance == the spendable delivery
 *   address on every host.
 *
 * Security rules:
 *   - Private key seeds are zeroed after use.
 *   - Stored address is public data (safe to cache).
 */

import { env } from '../env'
import { redis } from '../redis'
import { logger } from '../logger'
import { decryptGasSeed, gasWalletIsConfigured } from './gasWalletService'
import { deriveSlip10Ed25519, ed25519PublicKeyFromSeed } from './nonEvmDerivation'
import type { RpcHealthResult } from './gas.balance'

// ── Constants ─────────────────────────────────────────────────────────────────

const SUI_SLIP10_PATH = "m/44'/784'/0'/0'/0'"

// Built-in public SUI mainnet JSON-RPC endpoints, tried (in order) after the
// operator-configured SUI_RPC_URL / SUI_RPC_URL_FALLBACK. All keyless. The
// Mysten public fullnode alone is not reliable from shared cloud egress IPs
// (per-IP rate limiting → sustained HTTP 429), which silently froze SUI balance
// refresh + RPC health for weeks. Failing over across independent providers is
// the permanent fix.
const SUI_PUBLIC_FALLBACK_RPCS = [
  'https://fullnode.mainnet.sui.io',
  'https://sui-rpc.publicnode.com',
  'https://sui-mainnet.public.blastapi.io',
  'https://sui-mainnet-endpoint.blockvision.org',
  'https://rpc-mainnet.suiscan.xyz',
  'https://sui-mainnet-rpc.allthatnode.com',
] as const

/**
 * Ordered, de-duplicated list of SUI JSON-RPC endpoints to try:
 *   1. operator primary (SUI_RPC_URL);
 *   2. operator-supplied extras (SUI_RPC_URL_FALLBACK, comma-separated);
 *   3. built-in keyless public endpoints (independent providers).
 * A rate-limited or down primary no longer takes SUI offline — the caller walks
 * this list until one endpoint answers.
 */
export function getSuiRpcEndpoints(): string[] {
  const extras = (env.SUI_RPC_URL_FALLBACK ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const ordered = [env.SUI_RPC_URL, ...extras, ...SUI_PUBLIC_FALLBACK_RPCS]
  return [...new Set(ordered)]
}

interface SuiRpcCallOpts {
  /** Per-request timeout (ms). Default 10s. */
  timeoutMs?: number
  /**
   * JSON-RPC error codes that are a valid "answer" for this method (e.g. -32000
   * "not found" for a tx lookup) — returned to the caller instead of triggering
   * failover to the next endpoint.
   */
  benignErrorCodes?: number[]
}

class SuiRpcBenignError extends Error {
  constructor(public readonly code: number, message: string) {
    super(message)
    this.name = 'SuiRpcBenignError'
  }
}

/**
 * Call a SUI JSON-RPC method with automatic failover across getSuiRpcEndpoints().
 * A network error, timeout, HTTP 429/5xx, or non-benign JSON-RPC error moves on
 * to the next endpoint. Throws the last error only when every endpoint fails.
 */
export async function suiRpcCall<T = unknown>(
  method: string,
  params: unknown[],
  opts: SuiRpcCallOpts = {},
): Promise<T> {
  const { timeoutMs = 10_000, benignErrorCodes = [] } = opts
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  let lastErr: unknown

  for (const url of getSuiRpcEndpoints()) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) {
        // 429 / 5xx → try the next provider; 4xx (other) is unlikely to differ
        // but we still fail over since a bad gateway can masquerade as 400.
        lastErr = new Error(`SUI RPC ${method} HTTP ${res.status} @ ${url}`)
        continue
      }
      const data = (await res.json()) as { result?: T; error?: { message?: string; code?: number } }
      if (data.error) {
        const code = data.error.code ?? 0
        const msg = data.error.message ?? JSON.stringify(data.error)
        if (benignErrorCodes.includes(code)) throw new SuiRpcBenignError(code, msg)
        lastErr = new Error(`SUI RPC ${method} error ${code}: ${msg} @ ${url}`)
        continue
      }
      return data.result as T
    } catch (err) {
      if (err instanceof SuiRpcBenignError) throw err
      lastErr = err
    }
  }

  logger.error(
    { method, err: lastErr instanceof Error ? lastErr.message : String(lastErr) },
    '[sui-rpc] all endpoints failed',
  )
  throw lastErr instanceof Error ? lastErr : new Error(`SUI RPC ${method} failed on all endpoints`)
}

export { SuiRpcBenignError }

// SUI address regex: 0x + 64 hex chars
const SUI_ADDR_RE = /^0x[0-9a-fA-F]{64}$/

// ── blake2b-256 availability (retained for API compatibility) ──────────────────

// Address hashing no longer depends on Node's OpenSSL blake2b — the Mysten SDK
// (@noble/hashes) provides a pure-JS blake2b that is always available. Kept as a
// constant `true` so existing callers/UI fields (`blake2bAvailable`) keep working
// without claiming a missing-digest risk that no longer exists.
function isBlake2bAvailable(): boolean {
  return true
}

// ── Address validation ────────────────────────────────────────────────────────

export function validateSuiAddress(addr: string): boolean {
  return SUI_ADDR_RE.test(addr)
}

// ── Key + address derivation ──────────────────────────────────────────────────

function deriveSuiPublicKeyAndAddress(seed: Buffer): { publicKey: Buffer; address: string } {
  const { privateKey } = deriveSlip10Ed25519(seed, SUI_SLIP10_PATH)
  try {
    const publicKey = ed25519PublicKeyFromSeed(privateKey)
    // Derive the address via the Mysten SDK's Ed25519PublicKey so it always
    // matches what the delivery keypair (Ed25519Keypair) signs as — both use the
    // SDK's pure-JS blake2b-256( 0x00 || pubkey ), independent of host OpenSSL.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Ed25519PublicKey } = require('@mysten/sui/keypairs/ed25519') as typeof import('@mysten/sui/keypairs/ed25519')
    const address = new Ed25519PublicKey(new Uint8Array(publicKey)).toSuiAddress()
    return { publicKey: Buffer.from(publicKey), address }
  } finally {
    privateKey.fill(0)
  }
}

// ── Delivery key helper ───────────────────────────────────────────────────────

/**
 * Derive the raw 32-byte ed25519 private key seed for SUI delivery signing.
 * Caller MUST zero the returned Buffer immediately after use (in a finally block).
 * This is the seed that @mysten/sui Ed25519Keypair.fromSecretKey expects.
 */
export function deriveSuiPrivateKeyForDelivery(seed: Buffer): Buffer {
  const { privateKey } = deriveSlip10Ed25519(seed, SUI_SLIP10_PATH)
  return privateKey // caller responsibility to zero
}

// ── Address cache ─────────────────────────────────────────────────────────────

let _suiAddressCache: string | null = null

export function getSuiHotWalletAddress(): string | null {
  if (!gasWalletIsConfigured()) return null
  if (_suiAddressCache) return _suiAddressCache
  const seed = decryptGasSeed()
  try {
    const { address } = deriveSuiPublicKeyAndAddress(seed)
    _suiAddressCache = address
    return _suiAddressCache
  } finally {
    seed.fill(0)
  }
}

export function clearSuiAddressCache(): void {
  _suiAddressCache = null
}

// ── Startup validation ────────────────────────────────────────────────────────

export function validateSuiAtStartup(): {
  configured: boolean
  address?: string
  blake2bAvailable?: boolean
  warning?: string
  error?: string
} {
  if (!gasWalletIsConfigured()) return { configured: false }

  const blake2bAvailable = isBlake2bAvailable()
  try {
    const seed = decryptGasSeed()
    let address: string
    try {
      const result = deriveSuiPublicKeyAndAddress(seed)
      address = result.address
    } finally {
      seed.fill(0)
    }

    if (!validateSuiAddress(address)) {
      return { configured: true, blake2bAvailable, error: `Derived SUI address has unexpected format: ${address}` }
    }

    _suiAddressCache = address

    const warning = blake2bAvailable
      ? undefined
      : 'CRITICAL: blake2b-256 not available on this Node build — SUI address uses sha3-256 fallback and is INCORRECT. DO NOT activate SUI delivery on this host.'

    return { configured: true, address, blake2bAvailable, ...(warning ? { warning } : {}) }
  } catch (err) {
    return {
      configured: true,
      blake2bAvailable,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ── Balance fetching ──────────────────────────────────────────────────────────

const SUI_BALANCE_CACHE_TTL_S = 60

/**
 * Fetch SUI native balance via SUI JSON-RPC, failing over across every endpoint
 * in getSuiRpcEndpoints(). A 60s Redis cache absorbs bursts (admin panel + dry
 * runs + monitor) so we don't invite rate limiting on the public providers.
 * Returns balance in SUI (not MIST; 1 SUI = 10^9 MIST).
 */
export async function getSuiBalance(address: string): Promise<number> {
  const cacheKey = `gasbal:sui:${address}`
  try {
    const cached = await redis.get(cacheKey)
    if (cached !== null) return parseFloat(cached)
  } catch { /* redis miss is non-fatal */ }

  const result = await suiRpcCall<{ totalBalance?: string }>(
    'suix_getBalance',
    [address, '0x2::sui::SUI'],
  )
  const mist = parseInt(result?.totalBalance ?? '0', 10)
  const sui = mist / 1e9 // MIST → SUI

  try { await redis.set(cacheKey, String(sui), 'EX', SUI_BALANCE_CACHE_TTL_S) } catch { /* non-fatal */ }
  return sui
}

// ── RPC health check ──────────────────────────────────────────────────────────

export async function checkSuiRpc(): Promise<RpcHealthResult> {
  const start = Date.now()
  try {
    const result = await suiRpcCall<string>('sui_getLatestCheckpointSequenceNumber', [], { timeoutMs: 8_000 })
    const latencyMs = Date.now() - start
    const checkpoint = result ? parseInt(result, 10) : undefined
    return { reachable: true, latencyMs, ...(checkpoint !== undefined ? { blockNumber: checkpoint } : {}) }
  } catch (err) {
    return { reachable: false, latencyMs: Date.now() - start, error: err instanceof Error ? err.message : String(err) }
  }
}

// ── Dry-run delivery check ────────────────────────────────────────────────────

export async function dryRunSuiDelivery(toAddress: string, amountSui: number): Promise<{
  ok: boolean
  hotWalletAddress: string | null
  hotWalletBalance: number | null
  toAddressValid: boolean
  blake2bAvailable: boolean
  rpc: RpcHealthResult
  error?: string
}> {
  const hotWalletAddress = getSuiHotWalletAddress()
  const toAddressValid = validateSuiAddress(toAddress)
  const blake2bAvailable = isBlake2bAvailable()
  const rpc = await checkSuiRpc()

  let hotWalletBalance: number | null = null
  let error: string | undefined

  if (!blake2bAvailable) {
    error = 'blake2b-256 unavailable — SUI address derivation is using sha3-256 fallback and is incorrect'
  } else if (!hotWalletAddress) {
    error = 'SUI hot wallet not configured (mnemonic system required)'
  } else if (!rpc.reachable) {
    error = `SUI RPC unreachable: ${rpc.error}`
  } else if (!toAddressValid) {
    error = `Invalid SUI address: ${toAddress}`
  } else {
    try {
      hotWalletBalance = await getSuiBalance(hotWalletAddress)
      if (hotWalletBalance < amountSui) {
        error = `Insufficient balance: ${hotWalletBalance} SUI < ${amountSui} SUI required`
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
    blake2bAvailable,
    rpc,
    ...(error ? { error } : {}),
  }
}
