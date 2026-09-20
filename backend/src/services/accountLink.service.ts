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
import { computeModerationStatus, recordModerationAction } from '../lib/moderation'
import type { TradeStatus, CtmTradeStatus, InstantBuyStatus, PrismaClient, Prisma } from '@prisma/client'

// Accepted by every eligibility helper below so they can run either against
// the live `db` (previews, the initial pre-transaction read) or against the
// `tx` handed to a $transaction callback (the final re-check immediately
// before mutating, which narrows the TOCTOU window between "admin looked at
// the preview" and "admin clicked confirm" to the width of the transaction).
type DbClient = PrismaClient | Prisma.TransactionClient
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

// Shared by isEstablishedAccount below and the admin merge/erase eligibility
// checks further down — one definition of "has money sitting in a wallet".
async function hasWalletBalance(client: DbClient, userId: string): Promise<boolean> {
  const wallets = await client.wallet.findMany({ where: { userId }, select: { balance: true, lockedBalance: true } })
  return wallets.some((w) => w.balance.toNumber() > 0 || w.lockedBalance.toNumber() > 0)
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

  return hasWalletBalance(db, userId)
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

// ─── Admin override: resolve a same-identity conflict (ADMIN-ONLY) ────────────
//
// The routine linking paths above NEVER merge two established accounts — that
// invariant stays. This is a separate, deliberate escape hatch: when a real
// user genuinely owns both colliding accounts (e.g. they traded on the website
// years ago, then separately opened the Telegram Mini App) and files a support
// request, an admin can pick which one survives. The other is fully retired —
// its login identity is freed (same freed_/synthetic-email pattern already
// used to absorb an empty stub) so it can never log in again, but every trade,
// KYC, wallet and rating row it has stays in the database untouched, for
// audit, disputes and compliance lookups. Nothing here ever deletes a row.
//
// Hard-blocked, no override possible: banned/suspended accounts, an account
// already retired/erased, or either side having an unresolved dispute or a
// trade in progress — closes the obvious ban-evasion / mid-trade-disappearance
// paths. A non-zero wallet balance is only a warning (see previewAccountMerge)
// since funds may be legitimately idle; the caller must set
// acknowledgeFundsRisk to proceed past it.

const ACTIVE_TRADE_STATUSES = [
  'payment_pending', 'payment_uploaded', 'payment_confirmed', 'crypto_sent', 'disputed',
] as unknown as TradeStatus[]
const ACTIVE_CTM_TRADE_STATUSES = [
  'awaiting_payment', 'payment_uploaded', 'payment_confirmed', 'seller_transferring', 'proof_submitted', 'buyer_confirming', 'disputed',
] as unknown as CtmTradeStatus[]
// InstantBuyOrder is single-user (no counterparty), but "admin_review" means
// money has already been paid in and is awaiting an admin to credit it — the
// user must still be reachable for that to resolve cleanly.
const ACTIVE_INSTANT_BUY_STATUSES = [
  'payment_pending', 'payment_uploaded', 'admin_review',
] as unknown as InstantBuyStatus[]

async function hasUnresolvedDispute(client: DbClient, userId: string): Promise<boolean> {
  const [p2p, ctm] = await Promise.all([
    client.dispute.count({
      where: { status: { not: 'resolved' }, trade: { OR: [{ buyerId: userId }, { sellerId: userId }] } },
    }),
    client.ctmDispute.count({
      where: { status: { not: 'resolved' }, trade: { OR: [{ buyerId: userId }, { sellerId: userId }] } },
    }),
  ])
  return p2p > 0 || ctm > 0
}

async function hasActiveTrade(client: DbClient, userId: string): Promise<boolean> {
  const [p2p, ctm, instantBuy] = await Promise.all([
    client.trade.count({ where: { status: { in: ACTIVE_TRADE_STATUSES }, OR: [{ buyerId: userId }, { sellerId: userId }] } }),
    client.ctmTrade.count({ where: { status: { in: ACTIVE_CTM_TRADE_STATUSES }, OR: [{ buyerId: userId }, { sellerId: userId }] } }),
    client.instantBuyOrder.count({ where: { userId, status: { in: ACTIVE_INSTANT_BUY_STATUSES } } }),
  ])
  return p2p > 0 || ctm > 0 || instantBuy > 0
}

// A retired/erased account can't respond if a new taker opens a trade against
// a listing it left live — same "disappears mid-trade" risk as an active
// trade, just one step earlier. Paused/completed/expired listings can't take
// new takers, so only 'active' matters here.
async function hasActiveListing(client: DbClient, userId: string): Promise<boolean> {
  const [ads, ctmListings] = await Promise.all([
    client.ad.count({ where: { userId, status: 'active' } }),
    client.ctmListing.count({ where: { status: 'active', merchantProfile: { userId } } }),
  ])
  return ads > 0 || ctmListings > 0
}

const MERGE_USER_SELECT = {
  id: true,
  username: true,
  fullName: true,
  email: true,
  telegramId: true,
  telegramUsername: true,
  telegramPhotoUrl: true,
  telegramAuthAt: true,
  isEmailVerified: true,
  isBanned: true,
  isSuspended: true,
  bannedUntil: true,
  suspendedUntil: true,
  underReview: true,
  mergedIntoId: true,
  historyMaskedAt: true,
  identityErasedAt: true,
} as const

type MergeCandidate = NonNullable<Awaited<ReturnType<typeof loadMergeCandidate>>>

async function loadMergeCandidate(client: DbClient, userId: string) {
  return client.user.findUnique({ where: { id: userId }, select: MERGE_USER_SELECT })
}

/** Blocks that apply to EITHER side of a merge or a standalone identity erase — never overridable by an admin. */
async function assertEligibleForIdentityAction(client: DbClient, user: MergeCandidate): Promise<void> {
  if (user.isBanned || user.isSuspended) {
    throw new AppError('CONFLICT', `${user.username} is banned or suspended — resolve that first`, 409)
  }
  if (user.mergedIntoId || user.historyMaskedAt) {
    throw new AppError('CONFLICT', `${user.username} was already retired into another account`, 409)
  }
  if (user.identityErasedAt) {
    throw new AppError('CONFLICT', `${user.username}'s identity was already erased`, 409)
  }
  if (await hasUnresolvedDispute(client, user.id)) {
    throw new AppError('CONFLICT', `${user.username} has an unresolved dispute — resolve it first`, 409)
  }
  if (await hasActiveTrade(client, user.id)) {
    throw new AppError('CONFLICT', `${user.username} has a trade in progress — wait for it to finish first`, 409)
  }
  if (await hasActiveListing(client, user.id)) {
    throw new AppError('CONFLICT', `${user.username} has a live ad/listing — pause or remove it first so a new taker can't open a trade against it`, 409)
  }
}

export interface MergeConflictPreview {
  survivor: { id: string; username: string; fullName: string; email: string; telegramId: string | null }
  other: { id: string; username: string; fullName: string; email: string; telegramId: string | null }
  willTransferEmail: boolean
  willTransferTelegram: boolean
  eligible: boolean
  blockedReason: string | null
  otherHasWalletBalance: boolean
}

// Admin-facing dry run: shows what a merge would do and why it might be
// blocked, before the admin commits to it.
export async function previewAccountMerge(survivorId: string, otherId: string): Promise<MergeConflictPreview> {
  if (survivorId === otherId) throw new AppError('VALIDATION_ERROR', 'Pick two different accounts', 400)

  const [survivor, other] = await Promise.all([loadMergeCandidate(db, survivorId), loadMergeCandidate(db, otherId)])
  if (!survivor || !other) throw new AppError('NOT_FOUND', 'Account not found', 404)

  const willTransferEmail = isSyntheticEmail(survivor.email) && !isSyntheticEmail(other.email)
  const willTransferTelegram = survivor.telegramId == null && other.telegramId != null

  let blockedReason: string | null = null
  let eligible = true
  if (!willTransferEmail && !willTransferTelegram) {
    eligible = false
    blockedReason = "These accounts don't collide on an identity — nothing to transfer. Use identity-erase instead if the goal is just to free up the other account."
  } else {
    try {
      await Promise.all([assertEligibleForIdentityAction(db, survivor), assertEligibleForIdentityAction(db, other)])
    } catch (err) {
      eligible = false
      blockedReason = err instanceof AppError ? err.message : 'Not eligible'
    }
  }

  return {
    survivor: { id: survivor.id, username: survivor.username, fullName: survivor.fullName, email: survivor.email, telegramId: survivor.telegramId?.toString() ?? null },
    other: { id: other.id, username: other.username, fullName: other.fullName, email: other.email, telegramId: other.telegramId?.toString() ?? null },
    willTransferEmail,
    willTransferTelegram,
    eligible,
    blockedReason,
    otherHasWalletBalance: await hasWalletBalance(db, otherId),
  }
}

export interface AdminMergeResult { survivorId: string; retiredId: string }

export async function adminMergeAccounts(input: {
  survivorId: string
  otherId: string
  adminId: string
  reason: string
  acknowledgeFundsRisk?: boolean
}): Promise<AdminMergeResult> {
  const { survivorId, otherId, adminId } = input
  const reason = input.reason.trim()
  if (reason.length < 10) {
    throw new AppError('VALIDATION_ERROR', 'A reason of at least 10 characters is required', 400)
  }
  if (survivorId === otherId) throw new AppError('VALIDATION_ERROR', 'Pick two different accounts', 400)

  const [survivor, other] = await Promise.all([loadMergeCandidate(db, survivorId), loadMergeCandidate(db, otherId)])
  if (!survivor || !other) throw new AppError('NOT_FOUND', 'Account not found', 404)

  await Promise.all([assertEligibleForIdentityAction(db, survivor), assertEligibleForIdentityAction(db, other)])

  const transferEmailNow = isSyntheticEmail(survivor.email) && !isSyntheticEmail(other.email)
  const transferTelegramNow = survivor.telegramId == null && other.telegramId != null
  if (!transferEmailNow && !transferTelegramNow) {
    throw new AppError(
      'VALIDATION_ERROR',
      "These accounts don't actually collide on an identity — nothing to transfer. Use identity-erase instead if the goal is just to free up the other account.",
      400,
    )
  }

  if (!input.acknowledgeFundsRisk && (await hasWalletBalance(db, otherId))) {
    throw new AppError(
      'CONFLICT',
      'The retired account has a non-zero wallet balance that will become inaccessible after masking. Confirm with acknowledgeFundsRisk to proceed.',
      409,
    )
  }

  // Computed once, outside the transaction, but only USED inside it against
  // freshly re-read rows — never against the `other` snapshot above, which
  // could be stale by the time the transaction runs.
  const unusablePasswordHash = await hashPassword(randomBytes(32).toString('hex'))

  const { transferEmail, transferTelegram } = await db.$transaction(async (tx) => {
    // Re-read + re-check eligibility AND recompute what actually needs
    // transferring against these fresh rows — closes the window where the
    // `other`/`survivor` snapshot read above went stale (e.g. `other`
    // unlinked/relinked Telegram) between the read and this write.
    const [survivorNow, otherNow] = await Promise.all([loadMergeCandidate(tx, survivorId), loadMergeCandidate(tx, otherId)])
    if (!survivorNow || !otherNow) throw new AppError('NOT_FOUND', 'Account not found', 404)
    await Promise.all([assertEligibleForIdentityAction(tx, survivorNow), assertEligibleForIdentityAction(tx, otherNow)])

    const transferEmail = isSyntheticEmail(survivorNow.email) && !isSyntheticEmail(otherNow.email)
    const transferTelegram = survivorNow.telegramId == null && otherNow.telegramId != null
    if (!transferEmail && !transferTelegram) {
      throw new AppError(
        'CONFLICT',
        "These accounts no longer collide on an identity (something changed since the preview) — nothing to transfer. Re-run the preview.",
        409,
      )
    }

    // Free `other`'s identity fields FIRST — unique constraints on email and
    // telegramId are checked per-statement, so the survivor's update (which
    // may claim these exact values) must run after they're vacated. Password
    // and 2FA are invalidated too — email alone isn't enough to guarantee the
    // retired account "can never log in again" if some future path doesn't
    // gate on isEmailVerified.
    await tx.user.update({
      where: { id: otherId },
      data: {
        mergedIntoId: survivorId,
        historyMaskedAt: new Date(),
        telegramId: null,
        telegramUsername: null,
        telegramPhotoUrl: null,
        telegramAuthAt: null,
        email: `merged_${otherId}@${SYNTHETIC_EMAIL_DOMAIN}`,
        isEmailVerified: false,
        passwordHash: unusablePasswordHash,
        twoFaEnabled: false,
        twoFaSecret: null,
      },
    })
    await tx.session.updateMany({ where: { userId: otherId, revokedAt: null }, data: { revokedAt: new Date() } })

    await tx.user.update({
      where: { id: survivorId },
      data: {
        ...(transferEmail ? { email: otherNow.email, isEmailVerified: otherNow.isEmailVerified } : {}),
        ...(transferTelegram
          ? {
              telegramId: otherNow.telegramId,
              telegramUsername: otherNow.telegramUsername,
              telegramPhotoUrl: otherNow.telegramPhotoUrl,
              telegramAuthAt: otherNow.telegramAuthAt,
            }
          : {}),
      },
    })

    return { transferEmail, transferTelegram }
  })

  await recordModerationAction({
    targetUserId: otherId,
    moderatorId: adminId,
    action: 'account_merge_retired',
    reason: `Retired into ${survivor.username} (${survivorId}). ${reason}`,
    previousStatus: computeModerationStatus(other),
    newStatus: computeModerationStatus(other),
  })
  await recordModerationAction({
    targetUserId: survivorId,
    moderatorId: adminId,
    action: 'account_merge_survivor',
    reason: `Absorbed ${other.username}'s ${transferEmail ? 'email' : ''}${transferEmail && transferTelegram ? ' + ' : ''}${transferTelegram ? 'Telegram' : ''} identity (${otherId}). ${reason}`,
    previousStatus: computeModerationStatus(survivor),
    newStatus: computeModerationStatus(survivor),
  })

  logger.info({ survivorId, retiredId: otherId, adminId, transferEmail, transferTelegram }, 'Admin resolved identity conflict by merging accounts')
  return { survivorId, retiredId: otherId }
}

// ─── Admin override: erase an account's login identity (ADMIN-ONLY) ───────────
//
// Standalone counterpart to the merge above — no designated survivor. At the
// account owner's request (via support), an admin wipes this account's
// email/Telegram identity so those identifiers are free to be claimed by a
// different or brand-new account. Trade/KYC/wallet rows are preserved for
// compliance; only the login identity is wiped, and the password is replaced
// with an unusable random hash so the account can never be signed into again.
export async function adminEraseIdentity(input: {
  userId: string
  adminId: string
  reason: string
  acknowledgeFundsRisk?: boolean
}): Promise<void> {
  const { userId, adminId } = input
  const reason = input.reason.trim()
  if (reason.length < 10) {
    throw new AppError('VALIDATION_ERROR', 'A reason of at least 10 characters is required', 400)
  }

  const user = await loadMergeCandidate(db, userId)
  if (!user) throw new AppError('NOT_FOUND', 'Account not found', 404)
  await assertEligibleForIdentityAction(db, user)

  if (!input.acknowledgeFundsRisk && (await hasWalletBalance(db, userId))) {
    throw new AppError(
      'CONFLICT',
      'This account has a non-zero wallet balance that will become inaccessible once its identity is erased. Confirm with acknowledgeFundsRisk to proceed.',
      409,
    )
  }

  const unusablePasswordHash = await hashPassword(randomBytes(32).toString('hex'))

  await db.$transaction(async (tx) => {
    const userNow = await loadMergeCandidate(tx, userId)
    if (!userNow) throw new AppError('NOT_FOUND', 'Account not found', 404)
    await assertEligibleForIdentityAction(tx, userNow)

    await tx.user.update({
      where: { id: userId },
      data: {
        identityErasedAt: new Date(),
        telegramId: null,
        telegramUsername: null,
        telegramPhotoUrl: null,
        telegramAuthAt: null,
        email: `erased_${userId}@${SYNTHETIC_EMAIL_DOMAIN}`,
        isEmailVerified: false,
        passwordHash: unusablePasswordHash,
        twoFaEnabled: false,
        twoFaSecret: null,
      },
    })
    await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } })
  })

  await recordModerationAction({
    targetUserId: userId,
    moderatorId: adminId,
    action: 'identity_erased',
    reason,
    previousStatus: computeModerationStatus(user),
    newStatus: computeModerationStatus(user),
  })

  logger.info({ userId, adminId }, 'Admin erased account login identity at user request')
}
