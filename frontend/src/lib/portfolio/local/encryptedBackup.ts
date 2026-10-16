import { z } from 'zod'

/**
 * Passphrase-encrypted backup for the local-only tracker (WebCrypto: PBKDF2-SHA256 -> AES-256-GCM).
 *
 * What this is for: a file you can keep somewhere safe without exposing your records to whoever
 * finds it. What it is NOT: protection for data sitting in this browser, and no defence against
 * malicious script on this site (an attacker who can run code here can read the data after you
 * unlock it). The passphrase and the derived key are never stored or sent anywhere.
 */
export const ENC_FORMAT = 'rupchain-portfolio-encrypted'
export const ENC_VERSION = 1
export const KDF_ITERATIONS = 600_000
const MIN_ITERATIONS = 100_000
const MAX_ITERATIONS = 2_000_000 // a hostile file must not be able to make unlocking run forever
export const MIN_PASSPHRASE = 8
const MAX_BYTES = 12 * 1024 * 1024

const enc = new TextEncoder()
const dec = new TextDecoder()

function toB64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
function fromB64(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const fileSchema = z.object({
  format: z.literal(ENC_FORMAT),
  version: z.literal(ENC_VERSION),
  kdf: z.object({ name: z.literal('PBKDF2'), hash: z.literal('SHA-256'), iterations: z.number().int().min(MIN_ITERATIONS).max(MAX_ITERATIONS), salt: z.string().min(16).max(64) }).strict(),
  cipher: z.object({ name: z.literal('AES-GCM'), iv: z.string().min(12).max(32) }).strict(),
  data: z.string().min(1),
}).strict()

type Header = Omit<z.infer<typeof fileSchema>, 'data'>

const aad = (h: Header) => enc.encode(JSON.stringify({ format: h.format, version: h.version, kdf: h.kdf, cipher: { name: h.cipher.name } }))

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  )
}

export function isEncryptedBackup(text: string): boolean {
  try { return (JSON.parse(text) as { format?: unknown }).format === ENC_FORMAT } catch { return false }
}

export function passphraseProblem(p: string): string | null {
  return p.length < MIN_PASSPHRASE ? `Use at least ${MIN_PASSPHRASE} characters. A longer phrase is safer.` : null
}

export async function encryptBackup(plaintext: string, passphrase: string, iterations = KDF_ITERATIONS): Promise<string> {
  const problem = passphraseProblem(passphrase)
  if (problem) throw new Error(problem)
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const header: Header = {
    format: ENC_FORMAT, version: ENC_VERSION,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: toB64(salt) },
    cipher: { name: 'AES-GCM', iv: toB64(iv) },
  }
  const key = await deriveKey(passphrase, salt, iterations)
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad(header) as BufferSource }, key, enc.encode(plaintext))
  return JSON.stringify({ ...header, data: toB64(new Uint8Array(ct)) })
}

export type DecryptResult = { ok: true; text: string } | { ok: false; error: string }

export async function decryptBackup(fileText: string, passphrase: string): Promise<DecryptResult> {
  if (fileText.length > MAX_BYTES) return { ok: false, error: 'This file is too large to be a portfolio backup.' }
  let json: unknown
  try { json = JSON.parse(fileText) } catch { return { ok: false, error: 'This file is not a valid backup.' } }
  const parsed = fileSchema.safeParse(json)
  if (!parsed.success) return { ok: false, error: 'This file is not a valid encrypted backup.' }
  const { data, ...header } = parsed.data
  try {
    const key = await deriveKey(passphrase, fromB64(header.kdf.salt), header.kdf.iterations)
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(header.cipher.iv) as BufferSource, additionalData: aad(header) as BufferSource }, key, fromB64(data) as BufferSource)
    return { ok: true, text: dec.decode(pt) }
  } catch {
    // AES-GCM authentication failure: wrong passphrase OR a changed/damaged file. They look the same on purpose.
    return { ok: false, error: 'Wrong passphrase, or the file is damaged.' }
  }
}
