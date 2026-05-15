/**
 * TON wallet service — SLIP-0010 ed25519 key derivation, HTTP API balance.
 *
 * Derivation path: m/44'/607'/0'/0'  (SLIP-0010 compatible path for TON)
 * Address format:  Raw TON address computed from public key (simplified v4R2 approximation).
 *                  IMPORTANT: The exact TON wallet V4R2 StateInit address requires the
 *                  @ton/core SDK for TL-B cell serialization. This implementation stores
 *                  a deterministic placeholder for startup validation only. When activating
 *                  TON delivery, replace with proper @ton/core address derivation.
 * Chain status:    inactive — delivery not yet enabled
 *
 * Security rules:
 *   - Private key seeds are zeroed after use.
 *   - Stored address is the sha256 fingerprint of the public key (safe, non-secret).
 */

import { createHash } from 'node:crypto'
import { env } from '../env'
import { decryptGasSeed, gasWalletIsConfigured } from './gasWalletService'
import { deriveSlip10Ed25519, ed25519PublicKeyFromSeed } from './nonEvmDerivation'
import type { RpcHealthResult } from './gas.balance'

// ── Constants ─────────────────────────────────────────────────────────────────

const TON_SLIP10_PATH = "m/44'/607'/0'/0'"

// TON raw address regex: workchain_id:64hex_chars
// (this is the format we generate — not the user-friendly bounceable/non-bounceable form)
const TON_RAW_ADDR_RE = /^0:[0-9a-f]{64}$/i

// ── Address validation ────────────────────────────────────────────────────────

export function validateTonAddress(addr: string): boolean {
  // Accept raw format (0:hex64) or user-friendly format (48-char base64url)
  return TON_RAW_ADDR_RE.test(addr) || /^[A-Za-z0-9+/_-]{48}$/.test(addr)
}

// ── Key + address derivation ───────────────────────────────────────────────────

/**
 * Derive the TON hot wallet ed25519 public key from the BIP39 seed.
 *
 * NOTE: The TON V4R2 wallet address is derived from the StateInit hash which
 * depends on the wallet contract bytecode + public key. Until @ton/core is
 * added as a dependency, we return a deterministic placeholder:
 *   "0:" + sha256(0x00 || pubkey).toString('hex')
 *
 * This address is used for internal validation only. It will NOT receive funds
 * correctly unless replaced with a proper V4R2 derivation before activation.
 */
function deriveTonPublicKeyAndAddress(seed: Buffer): { publicKey: Buffer; address: string } {
  const { privateKey } = deriveSlip10Ed25519(seed, TON_SLIP10_PATH)
  try {
    const publicKey = ed25519PublicKeyFromSeed(privateKey)
    // Simplified placeholder: 0:sha256(flag || pubkey)
    const hashInput = Buffer.concat([Buffer.from([0x00]), publicKey])
    const fingerprint = createHash('sha256').update(hashInput).digest('hex')
    const address = `0:${fingerprint}`
    return { publicKey: Buffer.from(publicKey), address }
  } finally {
    privateKey.fill(0)
  }
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
    return {
      configured: true,
      address,
      // Remind operators that this is the simplified form until @ton/core is integrated
      warning: 'TON address is a derivation placeholder. Integrate @ton/core before activating delivery.',
    }
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
  const baseUrl = env.TON_ENDPOINT_URL.replace(/\/$/, '')
  const url = `${baseUrl}/api/v2/getAddressBalance?address=${encodeURIComponent(address)}`
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (env.TON_API_KEY) headers['X-API-Key'] = env.TON_API_KEY

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`TON API getAddressBalance HTTP ${res.status}`)
  const data = await res.json() as { ok: boolean; result?: string; error?: string }
  if (!data.ok) throw new Error(`TON API error: ${data.error}`)
  const nanotons = parseInt(data.result ?? '0', 10)
  return nanotons / 1e9  // nanotons → TON
}

// ── RPC health check ──────────────────────────────────────────────────────────

export async function checkTonRpc(): Promise<RpcHealthResult> {
  const baseUrl = env.TON_ENDPOINT_URL.replace(/\/$/, '')
  const start = Date.now()
  try {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (env.TON_API_KEY) headers['X-API-Key'] = env.TON_API_KEY

    const res = await fetch(`${baseUrl}/api/v2/getMasterchainInfo`, {
      headers,
      signal: AbortSignal.timeout(8_000),
    })
    const latencyMs = Date.now() - start
    if (!res.ok) return { reachable: false, latencyMs, error: `HTTP ${res.status}` }
    const data = await res.json() as { ok: boolean; result?: { last?: { seqno?: number } }; error?: string }
    if (!data.ok) return { reachable: false, latencyMs, error: data.error ?? 'API returned ok:false' }
    const blockNumber = data.result?.last?.seqno
    return { reachable: true, latencyMs, ...(blockNumber !== undefined ? { blockNumber } : {}) }
  } catch (err) {
    return { reachable: false, latencyMs: Date.now() - start, error: err instanceof Error ? err.message : String(err) }
  }
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
    warning: 'TON delivery requires @ton/core integration and a properly-registered V4R2 wallet before activation.',
    ...(error ? { error } : {}),
  }
}
