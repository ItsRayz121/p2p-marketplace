import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { HDKey } from 'viem/accounts'
import { privateKeyToAccount } from 'viem/accounts'
import { getAddress, type Address } from 'viem'
import { env } from './env'

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
