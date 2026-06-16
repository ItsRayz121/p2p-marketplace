// Trusted-device 2FA: after a user clears the login TOTP on a device and opts in,
// we issue a long-lived httpOnly `device_trust` cookie and store its hash here.
// Future logins from the SAME device (matching fingerprint) skip the login code
// until the 30-day window lapses or a security event revokes the trust.
//
// IMPORTANT: this ONLY shortcuts the *login* code. Step-up 2FA for withdrawals
// and admin money-moves (X-TOTP-Code) is untouched and still required every time.
import { createHash, randomBytes } from 'node:crypto'
import { db } from '../lib/prisma'
import { hashToken } from '../lib/hash'
import { env } from '../lib/env'

export const DEVICE_COOKIE_NAME = 'device_trust'
const DEVICE_TRUST_TTL_DAYS = 30
const DEVICE_TRUST_TTL_MS = DEVICE_TRUST_TTL_DAYS * 24 * 60 * 60 * 1000

// Cookie mirrors the refresh-token cookie's cross-site posture (Vercel ⇄ Railway).
export const DEVICE_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: (env.NODE_ENV === 'production' ? 'none' : 'lax') as 'none' | 'lax',
  secure: env.NODE_ENV === 'production',
  path: '/',
  maxAge: DEVICE_TRUST_TTL_DAYS * 24 * 60 * 60, // seconds
  ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
}

// Device binding: a stable hash of the user-agent. If the UA changes (different
// browser/OS) the fingerprint no longer matches and we fall back to asking for
// the code — exactly the "something is abnormal" guard we want.
function deviceFingerprint(userAgent?: string): string {
  return createHash('sha256').update(userAgent ?? 'unknown').digest('hex')
}

// Condense a raw user-agent into a short human-readable label for the device list.
function deviceLabel(userAgent?: string): string {
  if (!userAgent) return 'Unknown device'
  const ua = userAgent
  const browser =
    /Edg\//.test(ua) ? 'Edge' :
    /OPR\/|Opera/.test(ua) ? 'Opera' :
    /Chrome\//.test(ua) ? 'Chrome' :
    /Firefox\//.test(ua) ? 'Firefox' :
    /Safari\//.test(ua) ? 'Safari' :
    'Browser'
  const os =
    /Windows/.test(ua) ? 'Windows' :
    /Android/.test(ua) ? 'Android' :
    /iPhone|iPad|iOS/.test(ua) ? 'iOS' :
    /Mac OS X|Macintosh/.test(ua) ? 'macOS' :
    /Linux/.test(ua) ? 'Linux' :
    'Unknown OS'
  return `${browser} on ${os}`.slice(0, 200)
}

/**
 * Returns true if the presented device-trust token belongs to an active, unexpired
 * trust record for this user AND the device fingerprint still matches. On success
 * the record's lastUsedAt/lastIp are refreshed. Anything off → false (ask for code).
 */
export async function isDeviceTrusted(params: {
  userId: string
  token: string | undefined
  userAgent?: string | undefined
  ip?: string | undefined
}): Promise<boolean> {
  const { userId, token, userAgent, ip } = params
  if (!token) return false

  const device = await db.trustedDevice.findUnique({
    where: { tokenHash: hashToken(token) },
  })
  if (!device) return false
  if (device.userId !== userId) return false
  if (device.revokedAt) return false
  if (device.expiresAt < new Date()) return false
  // Device binding — UA must still match the fingerprint captured at enrolment.
  if (device.fingerprint !== deviceFingerprint(userAgent)) return false

  await db.trustedDevice
    .update({
      where: { id: device.id },
      data: { lastUsedAt: new Date(), lastIp: ip ?? device.lastIp },
    })
    .catch(() => undefined)

  return true
}

/**
 * Enrols the current device and returns the RAW token to set as the cookie.
 * Only the hash is persisted.
 */
export async function createTrustedDevice(params: {
  userId: string
  userAgent?: string | undefined
  ip?: string | undefined
}): Promise<string> {
  const { userId, userAgent, ip } = params
  const token = randomBytes(32).toString('hex')

  await db.trustedDevice.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      fingerprint: deviceFingerprint(userAgent),
      label: deviceLabel(userAgent),
      ip: ip ?? null,
      lastIp: ip ?? null,
      expiresAt: new Date(Date.now() + DEVICE_TRUST_TTL_MS),
    },
  })

  return token
}

/**
 * Revoke EVERY trusted device for a user. Called on security events
 * (password change/reset, 2FA disable/re-enable) so a fresh code is required again.
 */
export async function revokeAllTrustedDevices(userId: string): Promise<void> {
  await db.trustedDevice.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  })
}

/** Revoke a single trusted device the user no longer recognises. */
export async function revokeTrustedDevice(userId: string, id: string): Promise<void> {
  await db.trustedDevice.updateMany({
    where: { id, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  })
}

export interface TrustedDeviceView {
  id: string
  label: string
  ip: string | null
  lastIp: string | null
  createdAt: string
  lastUsedAt: string
  expiresAt: string
  current: boolean
}

/** List a user's active trusted devices (marks the one matching `currentToken`). */
export async function listTrustedDevices(
  userId: string,
  currentToken?: string,
): Promise<TrustedDeviceView[]> {
  const currentHash = currentToken ? hashToken(currentToken) : null
  const devices = await db.trustedDevice.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastUsedAt: 'desc' },
  })
  return devices.map((d) => ({
    id: d.id,
    label: d.label ?? 'Unknown device',
    ip: d.ip,
    lastIp: d.lastIp,
    createdAt: d.createdAt.toISOString(),
    lastUsedAt: d.lastUsedAt.toISOString(),
    expiresAt: d.expiresAt.toISOString(),
    current: currentHash !== null && d.tokenHash === currentHash,
  }))
}
