import { randomBytes } from 'node:crypto'
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
import { signAccessToken, signPreAuthToken, verifyPreAuthToken } from '../lib/jwt'
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
  createdAt: Date
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
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
    createdAt: Date
    tradeStats: {
      totalTrades: number
      completedTrades: number
      completionRate: { toNumber: () => number }
      avgRating: { toNumber: () => number }
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
    createdAt: user.createdAt,
    tradeStats: user.tradeStats
      ? {
          totalTrades: user.tradeStats.totalTrades,
          completedTrades: user.tradeStats.completedTrades,
          completionRate: user.tradeStats.completionRate.toNumber(),
          avgRating: user.tradeStats.avgRating.toNumber(),
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
  twoFaEnabled: true,
  referralCode: true,
  createdAt: true,
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
  const { email, password, fullName, referralCode, intendedRole } = input

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
      twoFaEnabled: true,
      twoFaSecret: true,
    },
  })

  if (!user) throw new AppError('INVALID_CREDENTIALS', 'Invalid email or password', 401)

  const passwordValid = await verifyPassword(password, user.passwordHash)
  if (!passwordValid) throw new AppError('INVALID_CREDENTIALS', 'Invalid email or password', 401)

  if (!user.isEmailVerified)
    throw new AppError('EMAIL_NOT_VERIFIED', 'Please verify your email before logging in', 403)
  if (user.isBanned) throw new AppError('ACCOUNT_BANNED', 'Your account has been banned', 403)
  if (user.isSuspended)
    throw new AppError('ACCOUNT_SUSPENDED', 'Your account has been suspended', 403)

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
  const otpauthUrl = authenticator.keyuri(user.email, 'PakSwap', secret)
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
