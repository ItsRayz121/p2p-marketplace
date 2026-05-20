/**
 * Solana wallet service — SLIP-0010 ed25519, base58 address, JSON-RPC balance.
 *
 * Derivation path: m/44'/501'/0'/0'  (Phantom / Solflare standard)
 * Address format:  base58( 32-byte ed25519 public key )
 * Chain status:    inactive — delivery not yet enabled
 *
 * Security rules:
 *   - Private key seeds are zeroed immediately after use.
 *   - The address (public key) is safe to cache.
 *   - No delivery logic is implemented here — gas.delivery.ts enforces the guard.
 */

import { env } from '../env'
import { decryptGasSeed, gasWalletIsConfigured } from './gasWalletService'
import { deriveSlip10Ed25519, ed25519PublicKeyFromSeed, base58Encode } from './nonEvmDerivation'
import type { RpcHealthResult } from './gas.balance'

// ── Constants ─────────────────────────────────────────────────────────────────

const SOLANA_SLIP10_PATH = "m/44'/501'/0'/0'"

// Solana address regex: base58, 32-44 characters
const SOLANA_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

// ── Address validation ────────────────────────────────────────────────────────

export function validateSolanaAddress(addr: string): boolean {
  return SOLANA_ADDR_RE.test(addr)
}

// ── Key derivation ────────────────────────────────────────────────────────────

/**
 * Derive the Solana hot wallet ed25519 public key (32 bytes) from the BIP39 seed.
 * Caller must zero the returned Buffer after use (it's a public key, but still).
 */
function deriveSolanaPublicKey(seed: Buffer): Buffer {
  const { privateKey } = deriveSlip10Ed25519(seed, SOLANA_SLIP10_PATH)
  try {
    return ed25519PublicKeyFromSeed(privateKey)
  } finally {
    privateKey.fill(0)
  }
}

// ── Address derivation ────────────────────────────────────────────────────────

/**
 * Derive the Solana hot wallet address (base58 encoded public key).
 * Returns null if the mnemonic system is not configured.
 */
export function deriveSolanaHotWalletAddress(): string | null {
  if (!gasWalletIsConfigured()) return null
  const seed = decryptGasSeed()
  try {
    const pubKey = deriveSolanaPublicKey(seed)
    return base58Encode(pubKey)
  } finally {
    seed.fill(0)
  }
}

// ── Delivery key helper ───────────────────────────────────────────────────────

/**
 * Derive the raw 32-byte ed25519 private key seed for transaction signing.
 * Caller MUST zero the returned Buffer immediately after use (in a finally block).
 * This is the SLIP-0010 derived seed that @solana/web3.js Keypair.fromSeed expects.
 */
export function deriveSolanaPrivateKeyForDelivery(seed: Buffer): Buffer {
  const { privateKey } = deriveSlip10Ed25519(seed, SOLANA_SLIP10_PATH)
  return privateKey // caller responsibility to zero
}

// ── Address cache ─────────────────────────────────────────────────────────────

let _solanaAddressCache: string | null = null

export function getSolanaHotWalletAddress(): string | null {
  if (!gasWalletIsConfigured()) return null
  if (_solanaAddressCache) return _solanaAddressCache
  _solanaAddressCache = deriveSolanaHotWalletAddress()
  return _solanaAddressCache
}

export function clearSolanaAddressCache(): void {
  _solanaAddressCache = null
}

// ── Startup validation ────────────────────────────────────────────────────────

export function validateSolanaAtStartup(): {
  configured: boolean
  address?: string
  warning?: string
  error?: string
} {
  if (!gasWalletIsConfigured()) return { configured: false }
  try {
    const address = deriveSolanaHotWalletAddress()
    if (!address || !validateSolanaAddress(address)) {
      return { configured: true, error: `Derived Solana address has unexpected format: ${address}` }
    }
    _solanaAddressCache = address
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
 * Fetch SOL native balance for an address via Solana JSON-RPC.
 * Returns balance in SOL (not lamports).
 */
export async function getSolanaBalance(address: string): Promise<number> {
  const rpcUrl = env.SOL_RPC_URL
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'getBalance',
    params: [address, { commitment: 'confirmed' }],
  })
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Solana RPC getBalance HTTP ${res.status}`)
  const data = await res.json() as { result?: { value?: number }; error?: { message: string } }
  if (data.error) throw new Error(`Solana RPC error: ${data.error.message}`)
  const lamports = data.result?.value ?? 0
  return lamports / 1e9  // lamports → SOL
}

// ── RPC health check ──────────────────────────────────────────────────────────

export async function checkSolanaRpc(): Promise<RpcHealthResult> {
  const rpcUrl = env.SOL_RPC_URL
  const start = Date.now()
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [{ commitment: 'finalized' }] }),
      signal: AbortSignal.timeout(8_000),
    })
    const latencyMs = Date.now() - start
    if (!res.ok) return { reachable: false, latencyMs, error: `HTTP ${res.status}` }
    const data = await res.json() as { result?: number; error?: { message: string } }
    if (data.error) return { reachable: false, latencyMs, error: data.error.message }
    const slot = typeof data.result === 'number' ? data.result : undefined
    return { reachable: true, latencyMs, ...(slot !== undefined ? { blockNumber: slot } : {}) }
  } catch (err) {
    return { reachable: false, latencyMs: Date.now() - start, error: err instanceof Error ? err.message : String(err) }
  }
}

// ── Dry-run delivery check ────────────────────────────────────────────────────

/**
 * Dry-run: verify that a Solana delivery would be possible.
 * Does NOT send a transaction. Used for admin pre-activation testing.
 */
export async function dryRunSolanaDelivery(toAddress: string, amountSol: number): Promise<{
  ok: boolean
  hotWalletAddress: string | null
  hotWalletBalance: number | null
  toAddressValid: boolean
  rpc: RpcHealthResult
  error?: string
}> {
  const hotWalletAddress = getSolanaHotWalletAddress()
  const toAddressValid = validateSolanaAddress(toAddress)
  const rpc = await checkSolanaRpc()

  let hotWalletBalance: number | null = null
  let error: string | undefined

  if (!hotWalletAddress) {
    error = 'SOL hot wallet not configured (mnemonic system required)'
  } else if (!rpc.reachable) {
    error = `Solana RPC unreachable: ${rpc.error}`
  } else if (!toAddressValid) {
    error = `Invalid Solana address: ${toAddress}`
  } else {
    try {
      hotWalletBalance = await getSolanaBalance(hotWalletAddress)
      if (hotWalletBalance < amountSol) {
        error = `Insufficient balance: ${hotWalletBalance} SOL < ${amountSol} SOL required`
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
