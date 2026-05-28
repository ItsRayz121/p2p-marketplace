/**
 * Gas wallet service — mnemonic-based key derivation for all chains.
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
 *   - Addresses (public — 0x.../T...) are derived once at startup and cached
 *   - Private keys are NEVER cached and NEVER returned across module boundaries
 *
 * Derivation paths (BIP44):
 *   TRON  m/44'/195'/0'/0/{index}   secp256k1, Base58Check address
 *   EVM   m/44'/60'/0'/0/{index}    secp256k1, same 0x address on ALL EVM chains
 *           (ETH, BSC, Base, ARB, OP, Polygon, Avalanche, opBNB)
 */

import { createDecipheriv, createHash } from 'node:crypto'
import { HDKey } from 'viem/accounts'
import { privateKeyToAccount } from 'viem/accounts'
import { env } from '../env'

// ── Index conventions — fixed once production wallets are live ────────────────

/** Index 0 → hot wallet — signs outgoing delivery transactions */
export const HOT_WALLET_INDEX = 0

export const TREASURY_TRON_INDEX = HOT_WALLET_INDEX
export const TREASURY_EVM_INDEX  = HOT_WALLET_INDEX

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

// ── Private key derivation ─────────────────────────────────────────────────────

/**
 * Derive a TRON private key at m/44'/195'/0'/0/{index}.
 * Returns plain hex WITHOUT 0x prefix — the format TronWeb expects.
 *
 * Use this value immediately. Do not store it. The internal byte buffer is
 * zeroed before returning; JS strings are immutable so cannot be zeroed —
 * minimise the scope of the returned value.
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
 * Derive an EVM private key at m/44'/60'/0'/0/{index}.
 * Returns hex WITH 0x prefix — the format viem expects.
 * One derivation covers ALL EVM chains (ETH, BSC, Base, ARB, OP, Polygon, Avalanche, opBNB).
 *
 * Use this value immediately. Do not store it.
 */
export function deriveEvmPrivateKeyHex(seed: Buffer, index: number): `0x${string}` {
  const hdkey = HDKey.fromMasterSeed(seed)
  const child = hdkey.derive(`m/44'/60'/0'/0/${index}`)
  if (!child.privateKey) throw new Error('EVM HD derivation produced no private key')
  const hex = ('0x' + Buffer.from(child.privateKey).toString('hex')) as `0x${string}`
  child.privateKey.fill(0)
  return hex
}

// ── Address-only derivation (no private key exposure) ─────────────────────────

function deriveTronAddress(seed: Buffer, index: number): string {
  const hdkey = HDKey.fromMasterSeed(seed)
  const child = hdkey.derive(`m/44'/195'/0'/0/${index}`)
  if (!child.privateKey) throw new Error('TRON HD derivation produced no private key')
  const pkHex = ('0x' + Buffer.from(child.privateKey).toString('hex')) as `0x${string}`
  child.privateKey.fill(0)
  return ethAddressToTron(privateKeyToAccount(pkHex).address)
}

function deriveEvmAddress(seed: Buffer, index: number): string {
  const hdkey = HDKey.fromMasterSeed(seed)
  const child = hdkey.derive(`m/44'/60'/0'/0/${index}`)
  if (!child.privateKey) throw new Error('EVM HD derivation produced no private key')
  const pkHex = ('0x' + Buffer.from(child.privateKey).toString('hex')) as `0x${string}`
  child.privateKey.fill(0)
  return privateKeyToAccount(pkHex).address  // EIP-55 checksummed
}

// ── Cached public address getters ──────────────────────────────────────────────
// Addresses are public data — safe to cache in module scope.
// Private keys are NEVER cached.

let _tronAddressCache: string | null = null
let _evmAddressCache:  string | null = null

/**
 * Return the derived TRON hot wallet address (T...) at the given HD index.
 * Index 0 is cached after first call. Other indices are derived on demand.
 * Returns null when mnemonic system is not configured.
 */
export function getTronHotWalletAddress(index = HOT_WALLET_INDEX): string | null {
  if (!gasWalletIsConfigured()) return null
  if (index === HOT_WALLET_INDEX && _tronAddressCache) return _tronAddressCache
  const seed = decryptGasSeed()
  try {
    const addr = deriveTronAddress(seed, index)
    if (index === HOT_WALLET_INDEX) _tronAddressCache = addr
    return addr
  } finally {
    seed.fill(0)
  }
}

/**
 * Return the derived EVM hot wallet address (0x..., EIP-55 checksummed) at the given HD index.
 * The same address is valid on ETH, BSC, Base, ARB, OP, Polygon, Avalanche, opBNB.
 * Index 0 is cached after first call. Other indices are derived on demand.
 * Returns null when mnemonic system is not configured.
 */
export function getEvmHotWalletAddress(index = HOT_WALLET_INDEX): string | null {
  if (!gasWalletIsConfigured()) return null
  if (index === HOT_WALLET_INDEX && _evmAddressCache) return _evmAddressCache
  const seed = decryptGasSeed()
  try {
    const addr = deriveEvmAddress(seed, index)
    if (index === HOT_WALLET_INDEX) _evmAddressCache = addr
    return addr
  } finally {
    seed.fill(0)
  }
}

// ── Multi-hot-wallet selector ─────────────────────────────────────────────────

import { db } from '../prisma'
import type { GasChain } from '@prisma/client'

/**
 * Select the best hot wallet for delivery on a chain using weighted random selection.
 * Falls back to primary (hdIndex=0) if no wallets have weight > 0.
 * Throws if no active wallet is found for the chain.
 */
export async function selectHotWallet(chain: GasChain) {
  const wallets = await db.gasHotWallet.findMany({
    where: { chain, isActive: true },
    orderBy: { hdIndex: 'asc' },
  })

  if (wallets.length === 0) throw new Error(`No active hot wallet for chain ${chain}`)
  if (wallets.length === 1) return wallets[0]!

  // Weighted random selection
  const totalWeight = wallets.reduce((s, w) => s + w.weight, 0)
  if (totalWeight === 0) return wallets[0]! // all weights zero — use primary

  let rand = Math.random() * totalWeight
  for (const w of wallets) {
    rand -= w.weight
    if (rand <= 0) return w
  }
  return wallets[wallets.length - 1]!
}

// ── Treasury address getters ──────────────────────────────────────────────────

let _tronTreasuryAddressCache: string | null = null
let _evmTreasuryAddressCache:  string | null = null

/**
 * Return the derived TRON treasury wallet address (T...) at index 100.
 * Cached after first call. Returns null when mnemonic system is not configured.
 */
export function getTronTreasuryAddress(): string | null {
  if (!gasWalletIsConfigured()) return null
  if (_tronTreasuryAddressCache) return _tronTreasuryAddressCache
  const seed = decryptGasSeed()
  try {
    _tronTreasuryAddressCache = deriveTronAddress(seed, TREASURY_TRON_INDEX)
    return _tronTreasuryAddressCache
  } finally {
    seed.fill(0)
  }
}

/**
 * Return the derived EVM treasury wallet address (0x...) at index 101.
 * Cached after first call. Returns null when mnemonic system is not configured.
 */
export function getEvmTreasuryAddress(): string | null {
  if (!gasWalletIsConfigured()) return null
  if (_evmTreasuryAddressCache) return _evmTreasuryAddressCache
  const seed = decryptGasSeed()
  try {
    _evmTreasuryAddressCache = deriveEvmAddress(seed, TREASURY_EVM_INDEX)
    return _evmTreasuryAddressCache
  } finally {
    seed.fill(0)
  }
}

// ── Startup validation ─────────────────────────────────────────────────────────

/**
 * Boot-time sanity check for the gas wallet mnemonic system.
 *
 * Validates:
 *   - GAS_MASTER_KEY and GAS_SEED_CIPHERTEXT are both set or both unset.
 *   - When set, decrypts and derives valid TRON + EVM addresses.
 *   - Non-EVM chains (SOL/TON/SUI) are validated separately (they don't block startup).
 *
 * Throws on EVM/TRON misconfiguration — let the exception kill the process.
 * Non-EVM errors are logged as warnings (chains are inactive).
 */
export function validateGasWalletAtStartup(): {
  configured: boolean
  tronHotWallet?: string
  evmHotWallet?: string
  nonEvm?: {
    sol?: { address: string; warning?: string } | { error: string }
    ton?: { address: string; warning?: string } | { error: string }
    sui?: { address: string; blake2bAvailable?: boolean; warning?: string } | { error: string }
  }
} {
  const hasKey = !!env.GAS_MASTER_KEY
  const hasCt  = !!env.GAS_SEED_CIPHERTEXT

  if (hasKey !== hasCt) {
    throw new Error(
      'Gas wallet is half-configured: GAS_MASTER_KEY and GAS_SEED_CIPHERTEXT must ' +
      'both be set or both unset. Check Railway environment variables.',
    )
  }

  if (!hasKey) return { configured: false }

  const seed = decryptGasSeed()
  try {
    const tronHotWallet = deriveTronAddress(seed, HOT_WALLET_INDEX)
    const evmHotWallet  = deriveEvmAddress(seed, HOT_WALLET_INDEX)

    if (!/^T[A-Za-z1-9]{33}$/.test(tronHotWallet)) {
      throw new Error(`Derived TRON address has unexpected format: ${tronHotWallet}`)
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(evmHotWallet)) {
      throw new Error(`Derived EVM address has unexpected format: ${evmHotWallet}`)
    }

    _tronAddressCache = tronHotWallet
    _evmAddressCache  = evmHotWallet

    // Non-EVM validation — chains are inactive so errors are non-fatal warnings
    const { validateSolanaAtStartup } = require('./solanaWalletService') as typeof import('./solanaWalletService')
    const { validateTonAtStartup }    = require('./tonWalletService')    as typeof import('./tonWalletService')
    const { validateSuiAtStartup }    = require('./suiWalletService')    as typeof import('./suiWalletService')

    const solResult = validateSolanaAtStartup()
    const tonResult = validateTonAtStartup()
    const suiResult = validateSuiAtStartup()

    const nonEvm = {
      sol: solResult.error
        ? { error: solResult.error }
        : { address: solResult.address!, ...(solResult.warning ? { warning: solResult.warning } : {}) },
      ton: tonResult.error
        ? { error: tonResult.error }
        : { address: tonResult.address!, ...(tonResult.warning ? { warning: tonResult.warning } : {}) },
      sui: suiResult.error
        ? { error: suiResult.error }
        : {
            address: suiResult.address!,
            ...(suiResult.blake2bAvailable !== undefined ? { blake2bAvailable: suiResult.blake2bAvailable } : {}),
            ...(suiResult.warning ? { warning: suiResult.warning } : {}),
          },
    }

    return { configured: true, tronHotWallet, evmHotWallet, nonEvm }
  } finally {
    seed.fill(0)
  }
}

// ── Effective deposit address ──────────────────────────────────────────────────
// Returns the address users should send USDT to for a given chain.
// Priority: (1) explicit env var, (2) mnemonic-derived hot wallet, (3) null.
//
// For EVM chains the hot wallet IS the deposit address — funds land there
// and the same wallet signs outgoing delivery transactions.
// For TRON the same principle applies (TronWeb uses the same derived key).

export type DepositAddressSource = 'env_var' | 'mnemonic_derived' | 'unconfigured'

export interface EffectiveDepositAddress {
  address: string | null
  source: DepositAddressSource
  chain: string
}

export function getEffectiveDepositAddress(
  chain: string,
  envVarAddress: string | undefined,
): EffectiveDepositAddress {
  if (envVarAddress) {
    return { address: envVarAddress, source: 'env_var', chain }
  }

  const upperChain = chain.toUpperCase()
  if (upperChain === 'TRON') {
    const addr = getTronHotWalletAddress()
    return { address: addr, source: addr ? 'mnemonic_derived' : 'unconfigured', chain }
  }

  // All EVM chains share the same derived hot wallet address
  const EVM_CHAINS = ['BSC', 'ETHEREUM', 'BASE', 'ARB', 'OP', 'MATIC', 'AVAX']
  if (EVM_CHAINS.includes(upperChain)) {
    const addr = getEvmHotWalletAddress()
    return { address: addr, source: addr ? 'mnemonic_derived' : 'unconfigured', chain }
  }

  return { address: null, source: 'unconfigured', chain }
}
