/**
 * SLIP-0010 ed25519 key derivation — pure Node.js crypto (no external libs).
 *
 * SLIP-0010 for ed25519 only supports HARDENED derivation (all path segments
 * must use ' suffix). Non-hardened ed25519 child keys are mathematically
 * impossible because the curve lacks a public-key homomorphism.
 *
 * Derivation paths used per chain:
 *   Solana  m/44'/501'/0'/0'      (Phantom/Solflare standard)
 *   SUI     m/44'/784'/0'/0'/0'   (Mysten standard)
 *   TON     m/44'/607'/0'/0'      (SLIP-0010 compatible path)
 *
 * Security rules (same as gasWalletService.ts for EVM/TRON):
 *   - Private key Buffers must be zeroed by the caller in a finally block.
 *   - Never cache private key bytes across module boundaries.
 *   - Public keys (addresses) are safe to cache.
 */

import { createHmac, createPrivateKey, createPublicKey } from 'node:crypto'

// ── Internal types ─────────────────────────────────────────────────────────────

interface Slip10Key {
  privateKey: Buffer  // 32 bytes — ed25519 seed
  chainCode:  Buffer  // 32 bytes
}

// ── HMAC-SHA512 ────────────────────────────────────────────────────────────────

function hmacSha512(key: Buffer, data: Buffer): Buffer {
  return Buffer.from(createHmac('sha512', key).update(data).digest())
}

// ── Master key from BIP39 seed ─────────────────────────────────────────────────

function masterKeyFromSeed(seed: Buffer): Slip10Key {
  const I = hmacSha512(Buffer.from('ed25519 seed'), seed)
  return {
    privateKey: Buffer.from(I.subarray(0, 32)),
    chainCode:  Buffer.from(I.subarray(32)),
  }
}

// ── Hardened child key derivation ─────────────────────────────────────────────

function hardenedChild(parent: Slip10Key, index: number): Slip10Key {
  // Hardened index space: 2^31 through 2^32-1
  const idx = (index | 0x80000000) >>> 0
  const idxBuf = Buffer.allocUnsafe(4)
  idxBuf.writeUInt32BE(idx)

  // Data = 0x00 || parent_private_key || index_uint32_be
  const data = Buffer.concat([Buffer.from([0x00]), parent.privateKey, idxBuf])
  const I = hmacSha512(parent.chainCode, data)

  return {
    privateKey: Buffer.from(I.subarray(0, 32)),
    chainCode:  Buffer.from(I.subarray(32)),
  }
}

// ── Path derivation ────────────────────────────────────────────────────────────

/**
 * Derive an ed25519 key from a BIP39 seed using SLIP-0010.
 *
 * @param seed   64-byte BIP39 seed (from decryptGasSeed())
 * @param path   derivation path e.g. "m/44'/501'/0'/0'" (ALL segments must be hardened)
 * @returns { privateKey, chainCode } — caller MUST zero privateKey in finally block
 */
export function deriveSlip10Ed25519(
  seed: Buffer,
  path: string,
): Slip10Key {
  const segments = path.split('/').slice(1) // strip leading 'm'
  let key = masterKeyFromSeed(seed)

  for (const seg of segments) {
    if (!seg.endsWith("'")) {
      throw new Error(
        `SLIP-0010 ed25519 requires all-hardened path segments; ` +
        `'${seg}' in '${path}' is not hardened`,
      )
    }
    const index = parseInt(seg.slice(0, -1), 10)
    if (isNaN(index) || index < 0 || index >= 0x80000000) {
      throw new Error(`Invalid path segment '${seg}' in '${path}'`)
    }
    key = hardenedChild(key, index)
  }

  return key
}

// ── ed25519 public key from private key seed ───────────────────────────────────

/**
 * Derive the 32-byte ed25519 public key from a 32-byte private key seed.
 *
 * Node ≥ 20 supports ed25519 natively via OpenSSL. We wrap the raw seed in
 * a PKCS#8 DER envelope which Node's crypto module understands.
 *
 * PKCS#8 DER for ed25519:
 *   30 2e                        SEQUENCE
 *     02 01 00                   INTEGER 0 (version)
 *     30 05 06 03 2b 65 70       SEQUENCE { OID 1.3.101.112 (Ed25519) }
 *     04 22 04 20 <32 bytes>     OCTET STRING containing OCTET STRING (seed)
 */
export function ed25519PublicKeyFromSeed(privateKeySeed: Buffer): Buffer {
  if (privateKeySeed.length !== 32) {
    throw new Error(`ed25519 seed must be 32 bytes; got ${privateKeySeed.length}`)
  }
  // PKCS#8 header: static bytes preceding the 32-byte seed
  const header = Buffer.from('302e020100300506032b657004220420', 'hex')
  const pkcs8  = Buffer.concat([header, privateKeySeed])

  const privKey = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })
  const pubKey  = createPublicKey(privKey)

  // SPKI DER export for ed25519: last 32 bytes are the raw public key
  const spki = pubKey.export({ format: 'der', type: 'spki' }) as Buffer
  return Buffer.from(spki.subarray(spki.length - 32))
}

// ── Base58 encoding (Bitcoin / Solana alphabet) ────────────────────────────────

// Same alphabet as tronweb (TRON uses base58Check; Solana uses raw base58).
const BASE58_ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

export function base58Encode(buf: Buffer): string {
  let num = BigInt('0x' + buf.toString('hex'))
  let result = ''
  const base = BigInt(58)
  while (num > 0n) {
    result = BASE58_ALPHA[Number(num % base)]! + result
    num /= base
  }
  // Preserve leading zero bytes as '1' characters
  for (let i = 0; i < buf.length && buf[i] === 0; i++) result = '1' + result
  return result
}
