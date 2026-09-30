import bcrypt from 'bcryptjs'
import { createHmac, randomBytes } from 'node:crypto'
import { env } from './env'

const BCRYPT_ROUNDS = 12

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS)
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash)
}

export function generateOtp(): string {
  // Cryptographically random 6-digit code
  const num = parseInt(randomBytes(3).toString('hex'), 16) % 1_000_000
  return String(num).padStart(6, '0')
}

export async function hashOtp(code: string): Promise<string> {
  return bcrypt.hash(code, 10) // Lower rounds for OTP (speed matters)
}

export async function verifyOtp(code: string, hash: string): Promise<boolean> {
  return bcrypt.compare(code, hash)
}

export function hashToken(token: string): string {
  // HMAC-SHA256 of refresh token — stored in DB instead of plaintext
  return createHmac('sha256', env.JWT_REFRESH_SECRET).update(token).digest('hex')
}

export function hashCnic(cnic: string, idType: 'national_id' | 'passport' = 'national_id'): string {
  // Normalize: remove dashes and spaces, uppercase. A national ID keeps the exact
  // pre-passport hash (so existing CNIC hashes still match); a passport number is
  // namespaced so it can never collide with a national ID number.
  const normalized = cnic.replace(/[-\s]/g, '').toUpperCase()
  const input = idType === 'passport' ? `PP:${normalized}` : normalized
  return createHmac('sha256', env.CNIC_HASH_SECRET).update(input).digest('hex')
}

export function generateReferralCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let code = ''
  const bytes = randomBytes(8)
  for (let i = 0; i < 8; i++) {
    code += chars[bytes[i]! % chars.length]
  }
  return code
}

export function generateOrderRef(prefix: string): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const suffix = randomBytes(6).toString('hex').toUpperCase()  // 48 bits of entropy
  return `${prefix}-${date}-${suffix}`
}

// 192-bit cryptographically random token for guest order privacy
export function generateTrackingToken(): string {
  return randomBytes(24).toString('hex')
}
