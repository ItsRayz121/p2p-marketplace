// Account linking — connect ONE Telegram identity and ONE real email to a
// single account so the same user is reachable from both the website and the
// Telegram Mini App.
//
// Design (see project memory "Account Linking"):
//   • Strictly 1 email + 1 Telegram per account (enforced by @unique columns).
//   • NEVER merge two accounts that both have history. Collision handling is
//     HISTORY-based, not existence-based: opening the Mini App auto-creates an
//     empty stub account, so we absorb empty stubs but block established ones.
//
// ⚠️ This module must NEVER break the Telegram→website auto-auth login, which is
// keyed on User.telegramId in auth.service.loginOrRegisterWithTelegram. We only
// ever reassign a telegramId away from an account inside the empty-stub absorb
// path, never from an account with real history.
import { randomBytes } from 'node:crypto'
import { db } from '../lib/prisma'
import { AppError } from '../lib/errors'
import { generateOtp, hashOtp, verifyOtp, hashToken, hashPassword, verifyPassword } from '../lib/hash'
import { sendOtpEmail } from './email.service'
import { logger } from '../lib/logger'
import { env } from '../lib/env'
import {
  getMe,
  isSyntheticEmail,
  SYNTHETIC_EMAIL_DOMAIN,
  type SafeUser,
} from './auth.service'

const OTP_TTL_MS = 10 * 60 * 1000 // email OTP — 10 min, matches the rest of auth
const LINK_TOKEN_TTL_MS = 15 * 60 * 1000 // telegram deep-link token — 15 min

// Bind an email OTP to its target address so a code mailed to address A can
// never be replayed to verify a different address B (the DB row carries no
// email column, so the binding lives in the hash).
function emailOtpPayload(code: string, email: string): string {
  return `${code}::${email.trim().toLowerCase()}`
}

// "Established" = a real human with a footprint we must never silently absorb.
// Cheap, decisive signals only: a real email, any KYC, any trade, or any wallet
// value. An empty Mini-App stub has none of these.
export async function isEstablishedAccount(userId: string): Promise<boolean> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { email: true, kycLevel: true, kycStatus: true },
  })
  if (!user) return false
  if (!isSyntheticEmail(user.email)) return true
  if (user.kycLevel !== 'none' || user.kycStatus !== 'none') return true

  const tradeCount = await db.trade.count({
    where: { OR: [{ buyerId: userId }, { sellerId: userId }] },
  })
  if (tradeCount > 0) return true

  const wallets = await db.wallet.findMany({
    where: { userId },
    select: { balance: true, lockedBalance: true },
  })
  for (const w of wallets) {
    if (w.balance.toNumber() > 0 || w.lockedBalance.toNumber() > 0) return true
  }
  return false
}

// ─── Email linking (Telegram user adds a real email / any user changes email) ──

export async function startEmailLink(userId: string, rawEmail: string): Promise<void> {
  const email = rawEmail.trim().toLowerCase()

  const me = await db.user.findUnique({ where: { id: userId }, select: { email: true } })
  if (!me) throw new AppError('NOT_FOUND', 'User not found', 404)
  if (email === me.email.toLowerCase()) {
    throw new AppError('VALIDATION_ERROR', 'This is already your email address', 400)
  }
  if (isSyntheticEmail(email)) {
    throw new AppError('VALIDATION_ERROR', 'Please enter a valid email address', 400)
  }

  // Collision: a real email belongs to exactly one account. We never merge, so
  // if anyone else already uses it, refuse — they keep both accounts separately.
  const taken = await db.user.findUnique({ where: { email }, select: { id: true } })
  if (taken && taken.id !== userId) {
    throw new AppError(
      'CONFLICT',
      'That email already belongs to another RupChain account. The two accounts can’t be linked — please use them separately or contact support.',
      409,
    )
  }

  const code = generateOtp()
  const codeHash = await hashOtp(emailOtpPayload(code, email))

  await db.otpCode.create({
    data: {
      userId,
      type: 'email_link',
      codeHash,
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
    },
  })

  sendOtpEmail(email, code, 'verify').catch((err) =>
    logger.error({ err, email }, 'Failed to send email-link OTP'),
  )
}

export async function verifyEmailLink(
  userId: string,
  rawEmail: string,
  code: string,
  newPassword?: string,
): Promise<SafeUser> {
  const email = rawEmail.trim().toLowerCase()

  const otp = await db.otpCode.findFirst({
    where: { userId, type: 'email_link', usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  })
  if (!otp) throw new AppError('INVALID_OTP', 'Invalid or expired verification code', 400)

  const valid = await verifyOtp(emailOtpPayload(code, email), otp.codeHash)
  if (!valid) throw new AppError('INVALID_OTP', 'Invalid or expired verification code', 400)

  // Re-check the collision at commit time to close the request→verify race.
  const taken = await db.user.findUnique({ where: { email }, select: { id: true } })
  if (taken && taken.id !== userId) {
    throw new AppError(
      'CONFLICT',
      'That email already belongs to another RupChain account. The two accounts can’t be linked.',
      409,
    )
  }

  let passwordHash: string | undefined
  if (newPassword !== undefined) {
    if (newPassword.length < 8) {
      throw new AppError('VALIDATION_ERROR', 'Password must be at least 8 characters', 400)
    }
    passwordHash = await hashPassword(newPassword)
  }

  await db.$transaction([
    db.otpCode.update({ where: { id: otp.id }, data: { usedAt: new Date() } }),
    db.user.update({
      where: { id: userId },
      data: {
        email,
        isEmailVerified: true, // ownership just proven by OTP
        ...(passwordHash ? { passwordHash } : {}),
      },
    }),
  ])

  return getMe(userId)
}

// ─── Telegram linking (website user attaches a Telegram identity) ──────────────

// Step 1 (website): mint a single-use, short-lived token and return a bot
// deep link. The user taps it; Telegram delivers `/start link_<token>` to the
// bot webhook, where step 2 (linkTelegramViaToken) runs. This path never
// touches Mini App auto-auth.
export async function createTelegramLinkToken(
  userId: string,
): Promise<{ token: string; deepLink: string | null; expiresAt: Date }> {
  const me = await db.user.findUnique({
    where: { id: userId },
    select: { telegramId: true },
  })
  if (!me) throw new AppError('NOT_FOUND', 'User not found', 404)
  if (me.telegramId != null) {
    throw new AppError('CONFLICT', 'A Telegram account is already linked', 409)
  }

  const token = randomBytes(24).toString('base64url') // URL/deep-link safe
  const expiresAt = new Date(Date.now() + LINK_TOKEN_TTL_MS)

  // Reuse OtpCode as the single-use token store; codeHash holds the FAST
  // deterministic HMAC (queryable by the bot) — not the bcrypt OTP hash.
  await db.otpCode.create({
    data: { userId, type: 'telegram_link', codeHash: hashToken(token), expiresAt },
  })

  const bot = env.TELEGRAM_BOT_USERNAME?.replace(/^@/, '')
  const deepLink = bot ? `https://t.me/${bot}?start=link_${token}` : null
  return { token, deepLink, expiresAt }
}

export type TelegramLinkOutcome =
  | { ok: true }
  | { ok: false; reason: 'expired' | 'already_linked_self' | 'telegram_in_use' | 'restricted' }

// Step 2 (bot webhook): resolve the token, then attach the Telegram identity to
// the target account — absorbing an EMPTY stub or BLOCKING an established one.
export async function linkTelegramViaToken(input: {
  token: string
  telegramId: number
  username?: string
  photoUrl?: string
}): Promise<TelegramLinkOutcome> {
  const tgId = BigInt(input.telegramId)

  const otp = await db.otpCode.findFirst({
    where: {
      type: 'telegram_link',
      codeHash: hashToken(input.token),
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  })
  if (!otp) return { ok: false, reason: 'expired' }

  const targetUserId = otp.userId
  const target = await db.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, telegramId: true, isBanned: true, isSuspended: true },
  })
  if (!target) {
    await db.otpCode.update({ where: { id: otp.id }, data: { usedAt: new Date() } })
    return { ok: false, reason: 'expired' }
  }
  if (target.isBanned || target.isSuspended) {
    await db.otpCode.update({ where: { id: otp.id }, data: { usedAt: new Date() } })
    return { ok: false, reason: 'restricted' }
  }
  if (target.telegramId != null) {
    await db.otpCode.update({ where: { id: otp.id }, data: { usedAt: new Date() } })
    // Already has a Telegram (possibly this same one already attached).
    return target.telegramId === tgId ? { ok: true } : { ok: false, reason: 'already_linked_self' }
  }

  // Who currently owns this Telegram id, if anyone?
  const existing = await db.user.findUnique({ where: { telegramId: tgId }, select: { id: true } })

  if (existing && existing.id !== targetUserId) {
    if (await isEstablishedAccount(existing.id)) {
      // Two real accounts → never merge. Block; the user keeps both separately.
      await db.otpCode.update({ where: { id: otp.id }, data: { usedAt: new Date() } })
      return { ok: false, reason: 'telegram_in_use' }
    }
    // Empty Mini-App stub → safe to absorb. We do NOT delete it (Wallet/Trade
    // FKs are onDelete:Restrict, so a delete is fragile); instead we free its
    // telegramId and neutralise its synthetic email so it becomes an inert
    // orphan that can no longer log in and cannot collide on re-signup.
    await db.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: existing.id },
        data: {
          telegramId: null,
          telegramUsername: null,
          telegramPhotoUrl: null,
          telegramAuthAt: null,
          email: `freed_${existing.id}@${SYNTHETIC_EMAIL_DOMAIN}`,
        },
      })
      await tx.user.update({
        where: { id: targetUserId },
        data: {
          telegramId: tgId,
          telegramAuthAt: new Date(),
          ...(input.username ? { telegramUsername: input.username } : {}),
          ...(input.photoUrl ? { telegramPhotoUrl: input.photoUrl } : {}),
        },
      })
      await tx.otpCode.update({ where: { id: otp.id }, data: { usedAt: new Date() } })
    })
    logger.info({ targetUserId, absorbedStub: existing.id }, 'Absorbed empty Telegram stub during link')
    return { ok: true }
  }

  // No existing owner → straight attach.
  await db.$transaction([
    db.user.update({
      where: { id: targetUserId },
      data: {
        telegramId: tgId,
        telegramAuthAt: new Date(),
        ...(input.username ? { telegramUsername: input.username } : {}),
        ...(input.photoUrl ? { telegramPhotoUrl: input.photoUrl } : {}),
      },
    }),
    db.otpCode.update({ where: { id: otp.id }, data: { usedAt: new Date() } }),
  ])
  return { ok: true }
}

// ─── Telegram unlink (fix a wrong Telegram → disconnect, then re-link) ──────────
//
// Strictly reversible counterpart to linking. Clearing telegramId is safe for
// auto-auth: the freed Telegram, on next Mini-App open, no longer matches any
// account and simply spawns a fresh stub — it can NEVER re-enter this account.
//
// Guardrails (both required):
//   • Anti-lockout: refuse if Telegram is the account's ONLY way in (a synthetic
//     email or no password). The user must add + verify a real email with a
//     password first, or they'd be locked out of their own account.
//   • Step-up: the current password must be re-entered — disconnecting a login
//     method is security-sensitive.
export async function unlinkTelegram(userId: string, password: string): Promise<SafeUser> {
  const me = await db.user.findUnique({
    where: { id: userId },
    select: { telegramId: true, email: true, passwordHash: true },
  })
  if (!me) throw new AppError('NOT_FOUND', 'User not found', 404)
  if (me.telegramId == null) {
    throw new AppError('VALIDATION_ERROR', 'No Telegram account is linked', 400)
  }

  // Anti-lockout: an alternative credential (real email + password) must exist.
  if (isSyntheticEmail(me.email) || !me.passwordHash) {
    throw new AppError(
      'TELEGRAM_ONLY_ACCOUNT',
      'Add and verify an email address with a password before disconnecting Telegram — otherwise you would be locked out of your account.',
      400,
    )
  }

  // Step-up: confirm ownership with the current password.
  const ok = await verifyPassword(password, me.passwordHash)
  if (!ok) throw new AppError('INVALID_PASSWORD', 'Incorrect password', 400)

  await db.user.update({
    where: { id: userId },
    data: {
      telegramId: null,
      telegramUsername: null,
      telegramPhotoUrl: null,
      telegramAuthAt: null,
    },
  })
  logger.info({ userId }, 'Telegram disconnected by user')

  return getMe(userId)
}
