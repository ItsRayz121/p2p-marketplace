/**
 * SUI wallet service — SLIP-0010 ed25519, blake2b-256 address, JSON-RPC balance.
 *
 * Derivation path: m/44'/784'/0'/0'/0'  (Mysten standard for SUI)
 * Address format:  0x + hex(blake2b-256( 0x00 || public_key ))[0:64]
 *                  (signature_scheme_flag = 0x00 for ed25519)
 * Chain status:    inactive — delivery not yet enabled
 *
 * blake2b-256:
 *   Node 20 + OpenSSL 3 expose BLAKE2b-256 as "blake2b-256".
 *   If unavailable (older OpenSSL build), falls back to sha3-256 with a startup
 *   warning — the address will be WRONG and delivery must not be enabled.
 *
 * Security rules:
 *   - Private key seeds are zeroed after use.
 *   - Stored address is public data (safe to cache).
 */

import { createHash } from 'node:crypto'
import { env } from '../env'
import { decryptGasSeed, gasWalletIsConfigured } from './gasWalletService'
import { deriveSlip10Ed25519, ed25519PublicKeyFromSeed } from './nonEvmDerivation'
import type { RpcHealthResult } from './gas.balance'

// ── Constants ─────────────────────────────────────────────────────────────────

const SUI_SLIP10_PATH = "m/44'/784'/0'/0'/0'"

// SUI address regex: 0x + 64 hex chars
const SUI_ADDR_RE = /^0x[0-9a-fA-F]{64}$/

// SUI ed25519 signature scheme flag
const ED25519_FLAG = Buffer.from([0x00])

// ── blake2b-256 availability detection ────────────────────────────────────────

let _blake2bAvailable: boolean | null = null

function isBlake2bAvailable(): boolean {
  if (_blake2bAvailable !== null) return _blake2bAvailable
  try {
    createHash('blake2b-256').update(Buffer.from('test')).digest()
    _blake2bAvailable = true
  } catch {
    _blake2bAvailable = false
  }
  return _blake2bAvailable
}

function suiHash(data: Buffer): Buffer {
  if (isBlake2bAvailable()) {
    return Buffer.from(createHash('blake2b-256').update(data).digest())
  }
  // Fallback: sha3-256 — produces a WRONG address. Delivery must be blocked.
  return Buffer.from(createHash('sha3-256').update(data).digest())
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
    // SUI address = blake2b-256( 0x00 || pubkey )
    const hashInput = Buffer.concat([ED25519_FLAG, publicKey])
    const hashed    = suiHash(hashInput)
    const address   = '0x' + hashed.toString('hex')
    return { publicKey: Buffer.from(publicKey), address }
  } finally {
    privateKey.fill(0)
  }
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

/**
 * Fetch SUI native balance via SUI JSON-RPC.
 * Returns balance in SUI (not MIST; 1 SUI = 10^9 MIST).
 */
export async function getSuiBalance(address: string): Promise<number> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'suix_getBalance',
    params: [address, '0x2::sui::SUI'],
  })
  const res = await fetch(env.SUI_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`SUI RPC suix_getBalance HTTP ${res.status}`)
  const data = await res.json() as {
    result?: { totalBalance?: string }
    error?: { message: string }
  }
  if (data.error) throw new Error(`SUI RPC error: ${data.error.message}`)
  const mist = parseInt(data.result?.totalBalance ?? '0', 10)
  return mist / 1e9  // MIST → SUI
}

// ── RPC health check ──────────────────────────────────────────────────────────

export async function checkSuiRpc(): Promise<RpcHealthResult> {
  const start = Date.now()
  try {
    const res = await fetch(env.SUI_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sui_getLatestCheckpointSequenceNumber',
        params: [],
      }),
      signal: AbortSignal.timeout(8_000),
    })
    const latencyMs = Date.now() - start
    if (!res.ok) return { reachable: false, latencyMs, error: `HTTP ${res.status}` }
    const data = await res.json() as { result?: string; error?: { message: string } }
    if (data.error) return { reachable: false, latencyMs, error: data.error.message }
    const checkpoint = data.result ? parseInt(data.result, 10) : undefined
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
