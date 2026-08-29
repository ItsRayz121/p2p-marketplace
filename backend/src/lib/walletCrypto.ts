import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto'
import { HDKey } from 'viem/accounts'
import { privateKeyToAccount } from 'viem/accounts'
import { getAddress, type Address } from 'viem'
import { env } from './env'
import { deriveSlip10Ed25519 } from './gas/nonEvmDerivation'
import { aptosAddressFromPrivateKeySeed, validateAptosAddress } from './gas/aptosWalletService'

const IV_LEN = 12
const TAG_LEN = 16

function getMasterKey(): Buffer {
  if (!env.WALLET_MASTER_KEY) {
    throw new Error('WALLET_MASTER_KEY is not configured')
  }
  return Buffer.from(env.WALLET_MASTER_KEY, 'hex')
}

export function encryptMasterSeed(seedBytes: Buffer): string {
  const key = getMasterKey()
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(seedBytes), cipher.final()])
  const tag = cipher.getAuthTag()
  key.fill(0)
  return Buffer.concat([iv, tag, ct]).toString('base64')
}

function decryptMasterSeed(): Buffer {
  if (!env.WALLET_MASTER_SEED_CIPHERTEXT) {
    throw new Error('WALLET_MASTER_SEED_CIPHERTEXT is not configured')
  }
  const buf = Buffer.from(env.WALLET_MASTER_SEED_CIPHERTEXT, 'base64')
  if (buf.length < IV_LEN + TAG_LEN + 1) {
    throw new Error('WALLET_MASTER_SEED_CIPHERTEXT is malformed')
  }
  const iv = buf.subarray(0, IV_LEN)
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN)
  const ct = buf.subarray(IV_LEN + TAG_LEN)
  const key = getMasterKey()
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const seed = Buffer.concat([decipher.update(ct), decipher.final()])
  key.fill(0)
  return seed
}

/**
 * Derive an EVM address from the master seed at BIP44 path m/44'/60'/0'/0/{index}.
 * The same address is valid across every EVM chain (Eth, BSC, Polygon, Arb, Op, Base).
 * The intermediate private key buffer is zeroed before returning. Returned
 * address is EIP-55 checksummed via viem's `getAddress`.
 */
export function deriveEvmAddress(index: number): Address {
  if (!Number.isInteger(index) || index < 0 || index >= 2 ** 31) {
    throw new Error('Invalid derivation index')
  }
  const seed = decryptMasterSeed()
  try {
    const hdkey = HDKey.fromMasterSeed(seed)
    const child = hdkey.derive(`m/44'/60'/0'/0/${index}`)
    if (!child.privateKey) {
      throw new Error('HD derivation produced no private key')
    }
    const pk = Buffer.from(child.privateKey)
    try {
      const pkHex = ('0x' + pk.toString('hex')) as `0x${string}`
      const account = privateKeyToAccount(pkHex)
      // getAddress normalises to EIP-55 checksum and validates length.
      return getAddress(account.address)
    } finally {
      pk.fill(0)
    }
  } finally {
    seed.fill(0)
  }
}

export function walletCustodyIsConfigured(): boolean {
  return !!env.WALLET_MASTER_KEY && !!env.WALLET_MASTER_SEED_CIPHERTEXT
}

/**
 * Derive the private key for a per-user EVM deposit address (same path as
 * deriveEvmAddress). ONLY for the admin sweep path — recovering funds stranded
 * on a deposit address when detection missed them. Never log the return value.
 * The decrypted seed and intermediate buffers are zeroed; the returned hex
 * string is unavoidably immutable (same trade-off as gasWalletService's
 * deriveEvmPrivateKeyHex).
 */
export function deriveEvmDepositPrivateKeyHex(index: number): `0x${string}` {
  if (!Number.isInteger(index) || index < 0 || index >= 2 ** 31) {
    throw new Error('Invalid derivation index')
  }
  const seed = decryptMasterSeed()
  try {
    const hdkey = HDKey.fromMasterSeed(seed)
    const child = hdkey.derive(`m/44'/60'/0'/0/${index}`)
    if (!child.privateKey) {
      throw new Error('HD derivation produced no private key')
    }
    const pk = Buffer.from(child.privateKey)
    child.privateKey.fill(0)
    const hex = ('0x' + pk.toString('hex')) as `0x${string}`
    pk.fill(0)
    return hex
  } finally {
    seed.fill(0)
  }
}

// ── Aptos (non-EVM) per-user deposit address derivation ─────────────────────────
// Aptos coin type 637, SLIP-0010 ed25519 (hardened-only). The per-user index is
// the final hardened segment, mirroring the EVM scheme (one address per user)
// but on Aptos' Ed25519 curve. The address is sha3-256(pubkey || 0x00) — see
// aptosAddressFromPrivateKeySeed (shared with the gas hot wallet so the format
// can never drift between the two).
const APTOS_COIN_TYPE = 637

/**
 * Derive the Aptos deposit address for a given per-user HD index from the same
 * master seed used for EVM. Pure function of (master seed, index); deterministic
 * so the matching private key can be re-derived later for sweeping. The
 * intermediate private-key buffer and the decrypted seed are both zeroed before
 * returning.
 */
export function deriveAptosDepositAddress(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= 2 ** 31) {
    throw new Error('Invalid derivation index')
  }
  const seed = decryptMasterSeed()
  try {
    const path = `m/44'/${APTOS_COIN_TYPE}'/0'/0'/${index}'`
    const { privateKey } = deriveSlip10Ed25519(seed, path)
    try {
      const address = aptosAddressFromPrivateKeySeed(privateKey)
      if (!validateAptosAddress(address)) {
        throw new Error('Derived Aptos address has an unexpected format')
      }
      return address
    } finally {
      privateKey.fill(0)
    }
  } finally {
    seed.fill(0)
  }
}

/**
 * Derive the raw Ed25519 private key (32 bytes) for a per-user Aptos deposit
 * address — same SLIP-0010 path as deriveAptosDepositAddress, so the key
 * provably controls the stored address. ONLY for the sweep path
 * (aptosDepositSweep.service.ts): moving deposited USDT off the per-user
 * address into the Aptos hot wallet so withdrawals can be paid from one place.
 *
 * The returned Buffer is the live private key — the caller MUST zero it in a
 * finally block. The decrypted master seed is zeroed here. Never log the return
 * value.
 */
export function deriveAptosDepositPrivateKey(index: number): Buffer {
  if (!Number.isInteger(index) || index < 0 || index >= 2 ** 31) {
    throw new Error('Invalid derivation index')
  }
  const seed = decryptMasterSeed()
  try {
    const path = `m/44'/${APTOS_COIN_TYPE}'/0'/0'/${index}'`
    const { privateKey } = deriveSlip10Ed25519(seed, path)
    return privateKey // caller responsibility to zero
  } finally {
    seed.fill(0)
  }
}

/**
 * True when custody is configured AND this Node build can compute sha3-256
 * (required for the Aptos address format). Mirrors validateAptosAtStartup's
 * sha3 guard so we never hand out an unspendable address.
 */
export function walletAptosCustodyIsConfigured(): boolean {
  if (!walletCustodyIsConfigured()) return false
  try {
    createHash('sha3-256').update(Buffer.from('probe')).digest()
    return true
  } catch {
    return false
  }
}

/**
 * Boot-time sanity check. Verifies that:
 *   - Either both `WALLET_MASTER_KEY` and `WALLET_MASTER_SEED_CIPHERTEXT` are
 *     set, or neither is. Half-configured custody is a deploy mistake we
 *     refuse to start with.
 *   - When both are set, the ciphertext actually decrypts and a derivation at
 *     index 0 produces a valid EVM address. Catches typo'd ciphertext, wrong
 *     key, or corrupted env values before we ever touch a user request.
 *
 * Throws on misconfiguration. Callers (server bootstrap) should let the
 * exception propagate so the process exits before serving traffic.
 */
export function validateWalletCustodyAtStartup(): { configured: boolean } {
  const hasKey = !!env.WALLET_MASTER_KEY
  const hasCt = !!env.WALLET_MASTER_SEED_CIPHERTEXT
  if (hasKey !== hasCt) {
    throw new Error(
      'Wallet custody is half-configured: WALLET_MASTER_KEY and WALLET_MASTER_SEED_CIPHERTEXT must both be set or both unset.',
    )
  }
  if (!hasKey) {
    return { configured: false }
  }
  // Roundtrip test — decrypt and derive once. Never log the result.
  try {
    const probe = deriveEvmAddress(0)
    if (!/^0x[0-9a-fA-F]{40}$/.test(probe)) {
      throw new Error('Derivation produced an invalid address shape')
    }
  } catch (err) {
    throw new Error(
      'Wallet custody decryption failed at startup. Check that WALLET_MASTER_KEY matches the key used to encrypt WALLET_MASTER_SEED_CIPHERTEXT. Underlying error: ' +
        (err instanceof Error ? err.message : String(err)),
    )
  }
  return { configured: true }
}
