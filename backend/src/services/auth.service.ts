import { randomBytes } from 'node:crypto'
import { applyWithdrawalLock } from './withdrawal-security.service'
import {
  generate as otpGenerate,
  verify as otpVerify,
  generateSecret as otpGenerateSecret,
  generateURI,
} from 'otplib'

const authenticator = {
  generateSecret: () => otpGenerateSecret(),
  keyuri: (account: string, service: string, secret: string) =>
    generateURI({ secret, label: account, issuer: service }) as string,
  generate: (secret: string) => otpGenerate({ secret }) as Promise<string>,
  verify: async ({ token, secret }: { token: string; secret: string }): Promise<boolean> => {
    const result = await otpVerify({ token, secret })
    return (result as { valid: boolean }).valid
  },
}
import qrcode from 'qrcode'
import { db } from '../lib/prisma'
import { AppError } from '../lib/errors'
import {
  hashPassword,
  verifyPassword,
  generateOtp,
  hashOtp,
  verifyOtp,
  hashToken,
  generateReferralCode,
} from '../lib/hash'
import { signAccessToken, signPreAuthToken, verifyPreAuthToken, signAppealToken } from '../lib/jwt'
import { sendOtpEmail } from './email.service'
import { logger } from '../lib/logger'
import { env } from '../lib/env'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RegisterInput {
  email: string
  password: string
  fullName: string
  referralCode?: string
  intendedRole?: string
  ip?: string
}

export interface LoginInput {
  email: string
  password: string
  userAgent?: string
  ip?: string
}

export interface LoginResult {
  accessToken?: string
  refreshToken?: string
  preAuthToken?: string
  requiresTwoFa: boolean
  user?: SafeUser
  // Set when the account is banned/suspended. The appeal token lets the user
  // submit an appeal without a full session.
  restricted?: {
    status: 'banned' | 'suspended'
    reason: string | null
    until: string | null
    appealToken: string
  }
}

export interface SafeUser {
  id: string
  email: string
  fullName: string
  username: string
  role: string
  kycStatus: string
  kycLevel: string
  isEmailVerified: boolean
  twoFaEnabled: boolean
  referralCode: string
  dailyBuyUsed: number
  dailyBuyLimit: number
  createdAt: Date
  withdrawalLockedUntil: Date | null
  withdrawalLockReason: string | null
  avatarUrl: string | null
  usernameChangedAt: Date | null
  tradeStats: {
    totalTrades: number
    completedTrades: number
    completionRate: number
    avgRating: number
    badge: string
    badgeLabel: string
    trustScore: number
  } | null
}

// In production the frontend (Vercel) and backend (Railway) live on different
// origins, so the refresh-token cookie must be SameSite=None;Secure to survive
// cross-site fetches. Locally we keep 'lax' (works with http://localhost).
const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: (env.NODE_ENV === 'production' ? 'none' : 'lax') as 'none' | 'lax',
  secure: env.NODE_ENV === 'production',
  path: '/',
  maxAge: 7 * 24 * 60 * 60, // 7 days in seconds
  // When COOKIE_DOMAIN is set (e.g. ".rupchain.com"), the refresh cookie becomes
  // first-party across subdomains — avoids third-party-cookie blocking between a
  // Vercel frontend and a Railway backend on the same parent domain.
  ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Prisma Decimal fields return a Decimal object, but if a column is null (e.g.
// older rows before a db push added the column) calling .toNumber() throws.
// Plain JS numbers are also accepted so the helper is safe in both cases.
function dec(val: { toNumber: () => number } | number | null | undefined, fallback = 0): number {
  if (val == null) return fallback
  if (typeof val === 'number') return val
  return val.toNumber()
}

function toSafeUser(
  user: {
    id: string
    email: string
    fullName: string
    username: string
    role: string
    kycStatus: string
    kycLevel: string
    isEmailVerified: boolean
    twoFaEnabled: boolean
    referralCode: string
    dailyBuyUsed: { toNumber: () => number } | number | null
    dailyBuyLimit: { toNumber: () => number } | number | null
    createdAt: Date
    withdrawalLockedUntil: Date | null
    withdrawalLockReason: string | null
    avatarUrl: string | null
    usernameChangedAt: Date | null
    tradeStats: {
      totalTrades: number
      completedTrades: number
      completionRate: { toNumber: () => number } | number | null
      avgRating: { toNumber: () => number } | number | null
      badge: string
      badgeLabel: string
      trustScore: number
    } | null
  },
): SafeUser {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    username: user.username,
    role: user.role,
    kycStatus: user.kycStatus,
    kycLevel: user.kycLevel,
    isEmailVerified: user.isEmailVerified,
    twoFaEnabled: user.twoFaEnabled,
    referralCode: user.referralCode,
    dailyBuyUsed: dec(user.dailyBuyUsed),
    dailyBuyLimit: dec(user.dailyBuyLimit, 50000),
    createdAt: user.createdAt,
    withdrawalLockedUntil: user.withdrawalLockedUntil,
    withdrawalLockReason: user.withdrawalLockReason,
    avatarUrl: user.avatarUrl,
    usernameChangedAt: user.usernameChangedAt,
    tradeStats: user.tradeStats
      ? {
          totalTrades: user.tradeStats.totalTrades,
          completedTrades: user.tradeStats.completedTrades,
          completionRate: dec(user.tradeStats.completionRate),
          avgRating: dec(user.tradeStats.avgRating),
          badge: user.tradeStats.badge,
          badgeLabel: user.tradeStats.badgeLabel,
          trustScore: user.tradeStats.trustScore,
        }
      : null,
  }
}

const USER_SELECT = {
  id: true,
  email: true,
  fullName: true,
  username: true,
  role: true,
  kycStatus: true,
  kycLevel: true,
  isEmailVerified: true,
  isSuspended: true,
  isBanned: true,
  twoFaEnabled: true,
  referralCode: true,
  googleId: true,
  dailyBuyUsed: true,
  dailyBuyLimit: true,
  createdAt: true,
  withdrawalLockedUntil: true,
  withdrawalLockReason: true,
  avatarUrl: true,
  usernameChangedAt: true,
  tradeStats: {
    select: {
      totalTrades: true,
      completedTrades: true,
      completionRate: true,
      avgRating: true,
      badge: true,
      badgeLabel: true,
      trustScore: true,
    },
  },
} as const

// ─── Service Methods ──────────────────────────────────────────────────────────

export async function register(input: RegisterInput): Promise<{ message: string }> {
  const { email, password, fullName, referralCode, intendedRole, ip } = input

  // Check email uniqueness
  const existing = await db.user.findUnique({ where: { email }, select: { id: true } })
  if (existing) throw new AppError('CONFLICT', 'An account with this email already exists', 409)

  // Resolve referral code to referrerId
  let referredById: string | undefined
  if (referralCode) {
    const referrer = await db.user.findUnique({
      where: { referralCode },
      select: { id: true },
    })
    if (!referrer) throw new AppError('VALIDATION_ERROR', 'Invalid referral code', 400)
    referredById = referrer.id
  }

  const passwordHash = await hashPassword(password)
  const username = `user_${randomBytes(3).toString('hex')}`
  const userReferralCode = generateReferralCode()
  const otpCode = generateOtp()
  const otpHash = await hashOtp(otpCode)

  await db.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email,
        passwordHash,
        fullName,
        username,
        referralCode: userReferralCode,
        ...(referredById ? { referredById } : {}),
        ...(ip ? { registrationIp: ip } : {}),
        intendedRole: intendedRole ?? 'user',
        termsAcceptedAt: new Date(),
        termsVersion: 'v1.0',
      },
    })

    await tx.tradeStats.create({ data: { userId: user.id } })

    await tx.wallet.create({
      data: {
        userId: user.id,
        coin: 'USDT',
        network: 'TRC20',
        balance: 0,
        lockedBalance: 0,
      },
    })

    await tx.otpCode.create({
      data: {
        userId: user.id,
        type: 'email_verify',
        codeHash: otpHash,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
      },
    })
  })

  // Send OTP email (non-blocking on failure)
  sendOtpEmail(email, otpCode, 'verify').catch((err) =>
    logger.error({ err, email }, 'Failed to send verification OTP'),
  )

  return { message: 'Registration successful. Check your email for a verification code.' }
}

export async function login(input: LoginInput): Promise<LoginResult> {
  const { email, password, userAgent, ip } = input

  const user = await db.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      passwordHash: true,
      role: true,
      isEmailVerified: true,
      isBanned: true,
      isSuspended: true,
      bannedUntil: true,
      suspendedUntil: true,
      moderationReason: true,
      twoFaEnabled: true,
      twoFaSecret: true,
    },
  })

  if (!user) throw new AppError('INVALID_CREDENTIALS', 'Invalid email or password', 401)

  const passwordValid = await verifyPassword(password, user.passwordHash)
  if (!passwordValid) throw new AppError('INVALID_CREDENTIALS', 'Invalid email or password', 401)

  if (!user.isEmailVerified)
    throw new AppError('EMAIL_NOT_VERIFIED', 'Please verify your email before logging in', 403)
  // Banned / suspended users do NOT get a full session. Instead we return a
  // restricted payload with a scoped appeal token so they can appeal.
  if (user.isBanned || user.isSuspended) {
    return {
      requiresTwoFa: false,
      restricted: {
        status: user.isBanned ? 'banned' : 'suspended',
        reason: user.moderationReason ?? null,
        until: (user.isBanned ? user.bannedUntil : user.suspendedUntil)?.toISOString() ?? null,
        appealToken: signAppealToken({ userId: user.id, email: user.email }),
      },
    }
  }

  // 2FA flow — issue pre-auth token, do NOT issue full session yet
  if (user.twoFaEnabled) {
    const preAuthToken = signPreAuthToken({ userId: user.id, email: user.email })
    return { requiresTwoFa: true, preAuthToken }
  }

  // Issue full session
  const { accessToken, refreshToken } = await createSession(user.id, user.email, user.role, userAgent, ip)

  const fullUser = await db.user.findUnique({ where: { id: user.id }, select: USER_SELECT })
  if (!fullUser) throw new AppError('NOT_FOUND', 'User not found', 404)

  return {
    requiresTwoFa: false,
    accessToken,
    refreshToken,
    user: toSafeUser(fullUser),
  }
}

export async function verifyEmail(userId: string, code: string): Promise<void> {
  const otp = await db.otpCode.findFirst({
    where: {
      userId,
      type: 'email_verify',
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  })

  if (!otp) throw new AppError('INVALID_OTP', 'Invalid or expired verification code', 400)

  const valid = await verifyOtp(code, otp.codeHash)
  if (!valid) throw new AppError('INVALID_OTP', 'Invalid or expired verification code', 400)

  await db.$transaction([
    db.otpCode.update({ where: { id: otp.id }, data: { usedAt: new Date() } }),
    db.user.update({ where: { id: userId }, data: { isEmailVerified: true } }),
  ])
}

// Verifies the OTP and immediately creates a login session so the frontend
// can redirect the user into the app without a separate login step.
export async function verifyEmailAndLogin(
  userId: string,
  code: string,
  userAgent?: string,
  ip?: string,
): Promise<{ accessToken: string; refreshToken: string; user: SafeUser }> {
  await verifyEmail(userId, code)

  const user = await db.user.findUnique({ where: { id: userId }, select: USER_SELECT })
  if (!user) throw new AppError('NOT_FOUND', 'User not found', 404)

  const { accessToken, refreshToken } = await createSession(user.id, user.email, user.role, userAgent, ip)

  return { accessToken, refreshToken, user: toSafeUser(user) }
}

export async function resendOtp(email: string, type: 'verify' | 'reset'): Promise<void> {
  const user = await db.user.findUnique({ where: { email }, select: { id: true, isEmailVerified: true } })
  // Silently succeed if user not found (prevents email enumeration)
  if (!user) return

  const otpType = type === 'verify' ? 'email_verify' : 'password_reset'

  if (type === 'verify' && user.isEmailVerified) {
    throw new AppError('ALREADY_VERIFIED', 'Email is already verified', 400)
  }

  const code = generateOtp()
  const codeHash = await hashOtp(code)

  await db.otpCode.create({
    data: {
      userId: user.id,
      type: otpType,
      codeHash,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    },
  })

  sendOtpEmail(email, code, type).catch((err) =>
    logger.error({ err, email }, 'Failed to resend OTP'),
  )
}

export async function forgotPassword(email: string): Promise<void> {
  const user = await db.user.findUnique({ where: { email }, select: { id: true } })
  // Silently succeed to prevent email enumeration
  if (!user) return

  const code = generateOtp()
  const codeHash = await hashOtp(code)

  await db.otpCode.create({
    data: {
      userId: user.id,
      type: 'password_reset',
      codeHash,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    },
  })

  sendOtpEmail(email, code, 'reset').catch((err) =>
    logger.error({ err, email }, 'Failed to send password reset OTP'),
  )
}

export async function resetPassword(email: string, code: string, newPassword: string): Promise<void> {
  const user = await db.user.findUnique({ where: { email }, select: { id: true } })
  if (!user) throw new AppError('INVALID_OTP', 'Invalid or expired reset code', 400)

  const otp = await db.otpCode.findFirst({
    where: {
      userId: user.id,
      type: 'password_reset',
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  })

  if (!otp) throw new AppError('INVALID_OTP', 'Invalid or expired reset code', 400)

  const valid = await verifyOtp(code, otp.codeHash)
  if (!valid) throw new AppError('INVALID_OTP', 'Invalid or expired reset code', 400)

  const passwordHash = await hashPassword(newPassword)

  await db.$transaction([
    db.otpCode.update({ where: { id: otp.id }, data: { usedAt: new Date() } }),
    db.user.update({ where: { id: user.id }, data: { passwordHash } }),
    // Revoke all existing sessions on password reset
    db.session.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ])

  // Lock withdrawals for 24h after a password reset (security policy).
  // Fire-and-forget — failure must not roll back the reset itself.
  void applyWithdrawalLock(user.id, 'password_reset').catch(() => {})
}

export async function refreshAccessToken(
  tokenFromCookie: string,
): Promise<{ accessToken: string }> {
  const tokenHash = hashToken(tokenFromCookie)

  const session = await db.session.findUnique({
    where: { token: tokenHash },
    include: { user: { select: { id: true, email: true, role: true, isBanned: true } } },
  })

  if (!session || session.revokedAt || session.expiresAt < new Date()) {
    throw new AppError('UNAUTHORIZED', 'Invalid or expired session', 401)
  }
  if (session.user.isBanned) {
    throw new AppError('ACCOUNT_BANNED', 'Your account has been banned', 403)
  }

  const accessToken = signAccessToken({
    userId: session.user.id,
    email: session.user.email,
    role: session.user.role,
  })

  return { accessToken }
}

export async function logout(userId: string, tokenFromCookie?: string): Promise<void> {
  if (tokenFromCookie) {
    const tokenHash = hashToken(tokenFromCookie)
    await db.session.updateMany({
      where: { userId, token: tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    })
  } else {
    // Revoke all sessions for this user
    await db.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    })
  }
}

export async function getMe(userId: string): Promise<SafeUser> {
  const user = await db.user.findUnique({ where: { id: userId }, select: USER_SELECT })
  if (!user) throw new AppError('NOT_FOUND', 'User not found', 404)
  return toSafeUser(user)
}

// ─── 2FA ──────────────────────────────────────────────────────────────────────

export async function setup2Fa(userId: string): Promise<{ secret: string; qrCodeUrl: string; otpauthUrl: string }> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { email: true, twoFaEnabled: true },
  })
  if (!user) throw new AppError('NOT_FOUND', 'User not found', 404)
  if (user.twoFaEnabled) throw new AppError('CONFLICT', '2FA is already enabled', 409)

  const secret = authenticator.generateSecret()
  const otpauthUrl = authenticator.keyuri(user.email, 'RupChain', secret)
  const qrCodeUrl = await qrcode.toDataURL(otpauthUrl)

  // Store secret temporarily (not yet enabled)
  await db.user.update({ where: { id: userId }, data: { twoFaSecret: secret } })

  return { secret, qrCodeUrl, otpauthUrl }
}

export async function enable2Fa(userId: string, code: string): Promise<void> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { twoFaSecret: true, twoFaEnabled: true },
  })
  if (!user) throw new AppError('NOT_FOUND', 'User not found', 404)
  if (user.twoFaEnabled) throw new AppError('CONFLICT', '2FA is already enabled', 409)
  if (!user.twoFaSecret) throw new AppError('VALIDATION_ERROR', 'Run 2FA setup first', 400)

  const valid = await authenticator.verify({ token: code, secret: user.twoFaSecret })
  if (!valid) throw new AppError('INVALID_OTP', 'Invalid 2FA code', 400)

  await db.user.update({ where: { id: userId }, data: { twoFaEnabled: true } })
}

export async function disable2Fa(userId: string, code: string): Promise<void> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { twoFaSecret: true, twoFaEnabled: true },
  })
  if (!user) throw new AppError('NOT_FOUND', 'User not found', 404)
  if (!user.twoFaEnabled) throw new AppError('VALIDATION_ERROR', '2FA is not enabled', 400)
  if (!user.twoFaSecret) throw new AppError('VALIDATION_ERROR', '2FA secret not found', 400)

  const valid = await authenticator.verify({ token: code, secret: user.twoFaSecret })
  if (!valid) throw new AppError('INVALID_OTP', 'Invalid 2FA code', 400)

  await db.user.update({
    where: { id: userId },
    data: { twoFaEnabled: false, twoFaSecret: null },
  })

  // Lock withdrawals for 72h after 2FA is disabled (security policy).
  void applyWithdrawalLock(userId, '2fa_disabled').catch(() => {})
}

export async function verify2Fa(
  preAuthToken: string,
  code: string,
  userAgent?: string,
  ip?: string,
): Promise<LoginResult> {
  const payload = verifyPreAuthToken(preAuthToken)
  if (!payload) throw new AppError('UNAUTHORIZED', 'Invalid or expired pre-auth token', 401)

  const user = await db.user.findUnique({
    where: { id: payload.userId },
    select: {
      id: true,
      email: true,
      role: true,
      twoFaSecret: true,
      twoFaEnabled: true,
      isBanned: true,
      isSuspended: true,
    },
  })

  if (!user) throw new AppError('NOT_FOUND', 'User not found', 404)
  if (user.isBanned) throw new AppError('ACCOUNT_BANNED', 'Your account has been banned', 403)
  if (user.isSuspended) throw new AppError('ACCOUNT_SUSPENDED', 'Your account has been suspended', 403)
  if (!user.twoFaEnabled || !user.twoFaSecret)
    throw new AppError('VALIDATION_ERROR', '2FA is not enabled', 400)

  const valid = await authenticator.verify({ token: code, secret: user.twoFaSecret })
  if (!valid) throw new AppError('INVALID_OTP', 'Invalid 2FA code', 400)

  const { accessToken, refreshToken } = await createSession(user.id, user.email, user.role, userAgent, ip)
  const fullUser = await db.user.findUnique({ where: { id: user.id }, select: USER_SELECT })
  if (!fullUser) throw new AppError('NOT_FOUND', 'User not found', 404)

  return {
    requiresTwoFa: false,
    accessToken,
    refreshToken,
    user: toSafeUser(fullUser),
  }
}

// ─── Google OAuth ─────────────────────────────────────────────────────────────

export async function loginOrRegisterWithGoogle(
  googleId: string,
  email: string,
  fullName: string,
  userAgent?: string,
  ip?: string,
): Promise<LoginResult> {
  // Find by googleId first, fall back to email (links existing account)
  let user = await db.user.findFirst({
    where: { OR: [{ googleId }, { email }] },
    select: USER_SELECT,
  })

  if (!user) {
    // New user — auto-generate username from their Google name
    const base = fullName.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 15) || 'user'
    let username = base + Math.floor(1000 + Math.random() * 9000)
    const taken = await db.user.findUnique({ where: { username } })
    if (taken) username = base + Math.floor(10000 + Math.random() * 90000)

    const created = await db.user.create({
      data: {
        email,
        fullName,
        username,
        passwordHash: randomBytes(32).toString('hex'),
        googleId,
        isEmailVerified: true,
        referralCode: randomBytes(8).toString('hex'),
      },
      select: USER_SELECT,
    })
    user = created
  } else if (!user.googleId) {
    // Existing email/password user — link their Google account
    const updated = await db.user.update({
      where: { id: user.id },
      data: { googleId, isEmailVerified: true },
      select: USER_SELECT,
    })
    user = updated
  }

  if (user.isSuspended || user.isBanned) {
    const mod = await db.user.findUnique({ where: { id: user.id }, select: { bannedUntil: true, suspendedUntil: true, moderationReason: true } })
    return {
      requiresTwoFa: false,
      restricted: {
        status: user.isBanned ? 'banned' : 'suspended',
        reason: mod?.moderationReason ?? null,
        until: (user.isBanned ? mod?.bannedUntil : mod?.suspendedUntil)?.toISOString() ?? null,
        appealToken: signAppealToken({ userId: user.id, email: user.email }),
      },
    }
  }

  const { accessToken, refreshToken } = await createSession(user.id, user.email, user.role, userAgent, ip)
  return { requiresTwoFa: false, accessToken, refreshToken, user: toSafeUser(user) }
}

// ─── Telegram Mini App ────────────────────────────────────────────────────────

export interface TelegramAuthInput {
  telegramId: number
  firstName: string
  username?: string
  photoUrl?: string
  // Referral code forwarded from the deep link (initData.start_param). When the
  // user is NEW and this is absent, the service falls back to any pending stash
  // recorded by the bot's /start handler (keyed by telegramId).
  referralCode?: string
  userAgent?: string
  ip?: string
}

// Get-or-create an account keyed by Telegram id, then issue a full session.
// Analogous to loginOrRegisterWithGoogle, but identity is proven by the
// caller's HMAC validation of initData (the route validates BEFORE calling
// this), so new accounts are created email-verified and skip the email gate.
export async function loginOrRegisterWithTelegram(
  input: TelegramAuthInput,
): Promise<LoginResult & { isNew: boolean }> {
  const { telegramId, firstName, username, photoUrl, userAgent, ip } = input
  const tgId = BigInt(telegramId)

  const existing = await db.user.findUnique({ where: { telegramId: tgId }, select: USER_SELECT })

  if (existing) {
    // Banned / suspended Telegram users get the restricted appeal payload, same
    // as every other login path.
    if (existing.isSuspended || existing.isBanned) {
      const mod = await db.user.findUnique({
        where: { id: existing.id },
        select: { bannedUntil: true, suspendedUntil: true, moderationReason: true },
      })
      return {
        isNew: false,
        requiresTwoFa: false,
        restricted: {
          status: existing.isBanned ? 'banned' : 'suspended',
          reason: mod?.moderationReason ?? null,
          until: (existing.isBanned ? mod?.bannedUntil : mod?.suspendedUntil)?.toISOString() ?? null,
          appealToken: signAppealToken({ userId: existing.id, email: existing.email }),
        },
      }
    }
    // Refresh the cached Telegram profile fields (username/photo can change).
    await db.user.update({
      where: { id: existing.id },
      data: {
        telegramAuthAt: new Date(),
        ...(username !== undefined ? { telegramUsername: username } : {}),
        ...(photoUrl !== undefined ? { telegramPhotoUrl: photoUrl } : {}),
      },
    })
    const { accessToken, refreshToken } = await createSession(existing.id, existing.email, existing.role, userAgent, ip)
    return { isNew: false, requiresTwoFa: false, accessToken, refreshToken, user: toSafeUser(existing) }
  }

  // ── New account ──
  // Resolve the referral code: explicit (deep-link start_param) first, then the
  // bot's pending stash. The HMAC already proved identity, so attribution is
  // applied immediately at creation (no email-verify wait) — matching the spec.
  let referralCode = input.referralCode
  if (!referralCode) {
    const pending = await db.telegramPendingReferral.findUnique({ where: { telegramId: tgId } })
    referralCode = pending?.referralCode
  }
  let referredById: string | undefined
  if (referralCode) {
    const referrer = await db.user.findUnique({ where: { referralCode }, select: { id: true } })
    if (referrer) referredById = referrer.id // silently ignore an unknown code rather than blocking signup
  }

  // Telegram accounts have no email — synthesize a unique, clearly-non-deliverable
  // address on the reserved .invalid TLD. isEmailVerified=true because Telegram's
  // HMAC is the identity proof; these users are exempt from the email gate.
  const syntheticEmail = `telegram_${telegramId}@users.rupchain.invalid`
  const base = (username ?? firstName).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 15) || 'tg'
  let desiredUsername = `${base}${Math.floor(1000 + Math.random() * 9000)}`
  if (await db.user.findUnique({ where: { username: desiredUsername }, select: { id: true } })) {
    desiredUsername = `${base}${Math.floor(100000 + Math.random() * 900000)}`
  }
  const userReferralCode = generateReferralCode()

  const created = await db.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: syntheticEmail,
        passwordHash: randomBytes(32).toString('hex'), // unusable password — Telegram-only login
        fullName: firstName?.trim() || 'Telegram User',
        username: desiredUsername,
        referralCode: userReferralCode,
        telegramId: tgId,
        ...(username ? { telegramUsername: username } : {}),
        ...(photoUrl ? { telegramPhotoUrl: photoUrl } : {}),
        telegramAuthAt: new Date(),
        isEmailVerified: true,
        ...(referredById ? { referredById } : {}),
        ...(ip ? { registrationIp: ip } : {}),
        termsAcceptedAt: new Date(),
        termsVersion: 'v1.0',
      },
      select: USER_SELECT,
    })

    await tx.tradeStats.create({ data: { userId: user.id } })
    await tx.wallet.create({
      data: { userId: user.id, coin: 'USDT', network: 'TRC20', balance: 0, lockedBalance: 0 },
    })

    // Consume the pending referral stash so it cannot be replayed.
    await tx.telegramPendingReferral.deleteMany({ where: { telegramId: tgId } })

    return user
  })

  const { accessToken, refreshToken } = await createSession(created.id, created.email, created.role, userAgent, ip)
  return { isNew: true, requiresTwoFa: false, accessToken, refreshToken, user: toSafeUser(created) }
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

async function createSession(
  userId: string,
  email: string,
  role: string,
  userAgent?: string,
  ip?: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const refreshToken = randomBytes(32).toString('hex')
  const tokenHash = hashToken(refreshToken)

  await db.session.create({
    data: {
      userId,
      token: tokenHash,
      userAgent: userAgent ?? null,
      ip: ip ?? null,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  })

  const accessToken = signAccessToken({ userId, email, role })
  return { accessToken, refreshToken }
}

export { COOKIE_OPTIONS }
