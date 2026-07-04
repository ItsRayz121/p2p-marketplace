/**
 * Self-service affiliate program — Phase 5, built ON TOP of gas referrals.
 *
 * Model: any user can APPLY to become an affiliate (submitting their social profiles).
 * A super-admin approves and sets three caps on the GasAffiliate profile:
 *   - maxMarginPct       : the total slice of the platform margin the affiliate may
 *                          allocate across a single link (buyer discount + commission).
 *   - minUserDiscountPct : a floor on the buyer-facing discount of every link.
 *   - maxLinks           : how many referral codes (links) the affiliate may own.
 *
 * Per link the affiliate then chooses the split:
 *   userDiscountPct (buyer auto-discount) + referralPct (their commission) <= maxMarginPct.
 *
 * MARGIN-ONLY INVARIANT (same as promo/referral): every payout here is drawn from the
 * platform margin of a gas order, never the base gas cost. A bound buyer's auto-discount
 * is floored at the margin; the affiliate's commission is capped at the margin actually
 * kept after all discounts (see accrueReferralForDelivery). Inert unless the flag
 * gas_affiliate_enabled is ON — with it OFF, no application/approval/auto-discount runs
 * and referral codes behave exactly as before.
 */
import { db } from '../prisma'
import { AppError } from '../errors'
import { logger } from '../logger'
import { notify } from '../notify'
import { createAdminNotif } from '../../services/adminNotification.service'
import { isFlagEnabled, FLAGS, getNumberConfig } from '../../services/platformFlags.service'
import {
  generateUniqueCode, normalizeAndAssertVanityCode, getReferralSummary, getOrCreateOwnCode,
  USER_DISCOUNT_CONFIG, DEFAULT_USER_DISCOUNT, type ReferralSummary,
} from './gas.referral'
import type { Prisma } from '@prisma/client'

function round2(n: number): number { return Math.round(n * 100) / 100 }

// Self-service custom links (open to every user, not just approved affiliates). A user may
// hold up to `max` named links, each giving the standard friend-discount + commission split.
// Deleting one starts a cooldown before a replacement slot opens, so links can't be churned.
const CUSTOM_LINK_MAX_CONFIG  = 'gas_custom_link_max'
const DEFAULT_CUSTOM_LINK_MAX = 2
const COOLDOWN_DAYS_CONFIG    = 'gas_custom_link_cooldown_days'
const DEFAULT_COOLDOWN_DAYS   = 30
const COMMISSION_PCT_CONFIG   = 'gas_referral_default_pct'
const DEFAULT_COMMISSION_PCT  = 5
const DAY_MS = 86_400_000

export type AffiliateStatus = 'none' | 'pending' | 'approved' | 'rejected'

export interface AffiliateLink {
  id: string
  code: string
  label: string | null
  userDiscountPct: number
  commissionPct: number
  isActive: boolean
  referredCount: number
}

export interface CustomLinkPolicy {
  maxLinks: number              // how many custom links this user may hold
  used: number                  // active (non-deleted) custom links they currently have
  canCreate: boolean            // under the cap AND not in cooldown
  cooldownUntil: string | null  // ISO — when the next create slot opens (null if not blocked by cooldown)
  userDiscountPct: number       // standard friend discount baked into a self-service link
  commissionPct: number         // standard commission baked into a self-service link
  isAffiliate: boolean          // approved affiliates choose their own split instead
}

export interface AffiliateOverview {
  enabled: boolean
  status: AffiliateStatus
  applicantNote: string | null
  rejectionReason: string | null
  caps: { maxMarginPct: number; minUserDiscountPct: number; maxLinks: number } | null
  links: AffiliateLink[]
  customLinkPolicy: CustomLinkPolicy
  earnings: ReferralSummary
}

/**
 * The user's CUSTOM links: every referral code they own except the base (oldest) code,
 * excluding soft-deleted ones. The base code backs the user's primary share link and is
 * never listed/deletable here. Returned oldest-first.
 */
async function listCustomCodes(userId: string) {
  const codes = await db.gasReferralCode.findMany({
    where: { ownerId: userId, deletedAt: null },
    orderBy: { createdAt: 'asc' },
  })
  return codes.slice(1) // drop the base (oldest) code
}

/**
 * Block a user from giving two of their OWN active links the same nickname/label
 * (case-insensitive). The label is purely cosmetic, but duplicates make the link list
 * ambiguous ("which CWF is which?"), so we reject them at write time. No-op for a blank
 * label. Soft-deleted links are ignored — a freed nickname can be reused.
 */
async function assertLabelNotDuplicated(userId: string, label: string | null, excludeCodeId?: string): Promise<void> {
  const trimmed = label?.trim()
  if (!trimmed) return
  const clash = await db.gasReferralCode.findFirst({
    where: {
      ownerId: userId,
      deletedAt: null,
      label: { equals: trimmed, mode: 'insensitive' },
      ...(excludeCodeId ? { id: { not: excludeCodeId } } : {}),
    },
    select: { id: true },
  })
  if (clash) throw new AppError('LABEL_TAKEN', `You already have a link nicknamed "${trimmed}". Pick a different name.`, 409)
}

/** Ensure a split is legal for the affiliate's admin-granted caps. Throws on violation. */
function assertSplit(
  caps: { maxMarginPct: number; minUserDiscountPct: number },
  userDiscountPct: number,
  commissionPct: number,
): void {
  if (!Number.isFinite(userDiscountPct) || !Number.isFinite(commissionPct) || userDiscountPct < 0 || commissionPct < 0) {
    throw new AppError('AFFILIATE_SPLIT_INVALID', 'Discount and commission must be non-negative numbers.', 400)
  }
  if (userDiscountPct < caps.minUserDiscountPct) {
    throw new AppError('AFFILIATE_MIN_DISCOUNT', `The buyer discount must be at least ${caps.minUserDiscountPct}%.`, 400)
  }
  if (round2(userDiscountPct + commissionPct) > caps.maxMarginPct) {
    throw new AppError('AFFILIATE_SPLIT_EXCEEDS_CAP', `Buyer discount + your commission cannot exceed your ${caps.maxMarginPct}% margin allowance.`, 400)
  }
}

/** Submit (or re-submit while pending/rejected) an affiliate application. */
export async function applyForAffiliate(
  userId: string,
  socials: Prisma.InputJsonValue,
  applicantNote: string | null,
): Promise<{ status: AffiliateStatus }> {
  if (!(await isFlagEnabled(FLAGS.GAS_AFFILIATE))) {
    throw new AppError('AFFILIATE_DISABLED', 'The affiliate program is not available right now.', 400)
  }
  const existing = await db.gasAffiliate.findUnique({ where: { userId }, select: { status: true } })
  if (existing?.status === 'approved') {
    throw new AppError('AFFILIATE_ALREADY_APPROVED', 'You are already an approved affiliate.', 400)
  }
  const row = await db.gasAffiliate.upsert({
    where: { userId },
    create: { userId, socials, applicantNote, status: 'pending' },
    update: { socials, applicantNote, status: 'pending', rejectionReason: null },
  })
  logger.info({ userId }, 'gas affiliate application submitted')

  // Notify staff (bell + web push + Telegram DM) so applications aren't missed.
  // Affiliate approval is an admin/super-admin task, so no sub-admin roles.
  const applicant = await db.user.findUnique({ where: { id: userId }, select: { username: true, email: true } })
  const who = applicant?.username ?? applicant?.email ?? userId
  void createAdminNotif({
    category: 'SYSTEM',
    title:    'New Affiliate Application',
    body:     `${who} applied to become an affiliate${applicantNote ? `: "${applicantNote.slice(0, 140)}"` : '.'} Review their socials and approve or reject.`,
    href:     '/admin/gas/affiliates',
    roles:    ['admin', 'super_admin'],
    telegram: true,
  })

  return { status: row.status as AffiliateStatus }
}

/** User-facing overview: profile status + caps, the user's custom links + policy, earnings. */
export async function getAffiliateOverview(userId: string): Promise<AffiliateOverview> {
  const enabled = await isFlagEnabled(FLAGS.GAS_AFFILIATE)
  const earnings = await getReferralSummary(userId)
  const profile = await db.gasAffiliate.findUnique({ where: { userId } })
  const status: AffiliateStatus = (profile?.status as AffiliateStatus) ?? 'none'
  const isAffiliate = status === 'approved'

  // Custom links (everyone, not just approved affiliates) — base code excluded.
  const customCodes = await listCustomCodes(userId)
  const counts = await db.gasReferral.groupBy({ by: ['codeId'], where: { codeId: { in: customCodes.map((c) => c.id) } }, _count: { _all: true } })
  const countMap = new Map(counts.map((c) => [c.codeId, c._count._all]))
  const links: AffiliateLink[] = customCodes.map((c) => ({
    id: c.id,
    code: c.code,
    label: c.label,
    userDiscountPct: c.userDiscountPct,
    commissionPct: c.referralPct,
    isActive: c.isActive,
    referredCount: countMap.get(c.id) ?? 0,
  }))

  const [stdMax, cooldownDays, stdDiscount, stdCommission, lastDeleted] = await Promise.all([
    getNumberConfig(CUSTOM_LINK_MAX_CONFIG, DEFAULT_CUSTOM_LINK_MAX),
    getNumberConfig(COOLDOWN_DAYS_CONFIG, DEFAULT_COOLDOWN_DAYS),
    getNumberConfig(USER_DISCOUNT_CONFIG, DEFAULT_USER_DISCOUNT),
    getNumberConfig(COMMISSION_PCT_CONFIG, DEFAULT_COMMISSION_PCT),
    db.gasReferralCode.findFirst({ where: { ownerId: userId, deletedAt: { not: null } }, orderBy: { deletedAt: 'desc' }, select: { deletedAt: true } }),
  ])
  // Approved affiliates use their admin maxLinks and have no churn cooldown.
  const maxLinks = isAffiliate && profile ? profile.maxLinks : stdMax
  const cooldownAt = !isAffiliate && lastDeleted?.deletedAt ? new Date(lastDeleted.deletedAt.getTime() + cooldownDays * DAY_MS) : null
  const cooldownActive = !!cooldownAt && cooldownAt > new Date()
  const canCreate = links.length < maxLinks && !cooldownActive

  return {
    enabled,
    status,
    applicantNote: profile?.applicantNote ?? null,
    rejectionReason: profile?.rejectionReason ?? null,
    caps: isAffiliate && profile
      ? { maxMarginPct: profile.maxMarginPct, minUserDiscountPct: profile.minUserDiscountPct, maxLinks: profile.maxLinks }
      : null,
    links,
    customLinkPolicy: {
      maxLinks,
      used: links.length,
      canCreate,
      cooldownUntil: cooldownActive && cooldownAt ? cooldownAt.toISOString() : null,
      userDiscountPct: stdDiscount,
      commissionPct: stdCommission,
      isAffiliate,
    },
    earnings,
  }
}

async function requireApprovedAffiliate(userId: string) {
  if (!(await isFlagEnabled(FLAGS.GAS_AFFILIATE))) {
    throw new AppError('AFFILIATE_DISABLED', 'The affiliate program is not available right now.', 400)
  }
  const aff = await db.gasAffiliate.findUnique({ where: { userId } })
  if (!aff || aff.status !== 'approved') {
    throw new AppError('AFFILIATE_NOT_APPROVED', 'You are not an approved affiliate.', 403)
  }
  return aff
}

/** Create a new affiliate link with a chosen split (respecting caps + maxLinks). The
 * affiliate may pick a vanity code (their own name) or let one be auto-generated. */
export async function createAffiliateLink(
  userId: string,
  args: { label: string | null; userDiscountPct: number; commissionPct: number; code?: string | null },
): Promise<AffiliateLink> {
  const aff = await requireApprovedAffiliate(userId)
  assertSplit(aff, args.userDiscountPct, args.commissionPct)
  await assertLabelNotDuplicated(userId, args.label)
  await getOrCreateOwnCode(userId) // ensure the base code exists so "custom" is well-defined
  const customs = await listCustomCodes(userId)
  if (customs.length >= aff.maxLinks) {
    throw new AppError('AFFILIATE_MAX_LINKS', `You can have at most ${aff.maxLinks} affiliate links.`, 400)
  }
  const code = args.code?.trim() ? await normalizeAndAssertVanityCode(args.code) : await generateUniqueCode()
  const created = await createCodeRow(userId, code, args.commissionPct, args.userDiscountPct, args.label)
  logger.info({ userId, codeId: created.id }, 'gas affiliate link created')
  return { id: created.id, code: created.code, label: created.label, userDiscountPct: created.userDiscountPct, commissionPct: created.referralPct, isActive: created.isActive, referredCount: 0 }
}

/** Insert a referral code row, mapping a unique-collision (a vanity code claimed in a race)
 * to a friendly CODE_TAKEN instead of a 500. */
async function createCodeRow(ownerId: string, code: string, referralPct: number, userDiscountPct: number, label: string | null) {
  try {
    return await db.gasReferralCode.create({
      data: { code, ownerId, referralPct, userDiscountPct, label: label?.trim().slice(0, 60) || null },
    })
  } catch (e) {
    if ((e as { code?: string })?.code === 'P2002') {
      throw new AppError('CODE_TAKEN', 'That code was just taken — try another.', 409)
    }
    throw e
  }
}

/** Update an existing affiliate link's split/label/active state (ownership enforced). */
export async function updateAffiliateLink(
  userId: string,
  codeId: string,
  args: { label?: string | null | undefined; userDiscountPct?: number | undefined; commissionPct?: number | undefined; isActive?: boolean | undefined },
): Promise<AffiliateLink> {
  const aff = await requireApprovedAffiliate(userId)
  const code = await db.gasReferralCode.findUnique({ where: { id: codeId } })
  if (!code || code.ownerId !== userId) throw new AppError('NOT_FOUND', 'Affiliate link not found.', 404)

  const nextDiscount = args.userDiscountPct ?? code.userDiscountPct
  const nextCommission = args.commissionPct ?? code.referralPct
  assertSplit(aff, nextDiscount, nextCommission)
  if (args.label !== undefined) await assertLabelNotDuplicated(userId, args.label, codeId)

  const updated = await db.gasReferralCode.update({
    where: { id: codeId },
    data: {
      referralPct: nextCommission,
      userDiscountPct: nextDiscount,
      ...(args.label !== undefined ? { label: args.label } : {}),
      ...(args.isActive !== undefined ? { isActive: args.isActive } : {}),
    },
  })
  const referredCount = await db.gasReferral.count({ where: { codeId } })
  return { id: updated.id, code: updated.code, label: updated.label, userDiscountPct: updated.userDiscountPct, commissionPct: updated.referralPct, isActive: updated.isActive, referredCount }
}

// ── Self-service custom links (every user, no affiliate approval needed) ──────────

/**
 * Named custom links are an approved-affiliate feature only. Regular users keep their
 * primary referral code + dual (Telegram/Website) share links but no longer mint extra
 * named links; approved affiliates create links via createAffiliateLink (chosen split).
 * This self-service entry point is retired and always rejects — kept so the route and
 * any old clients fail with a clear message rather than 404.
 */
export async function createOwnCustomLink(userId: string, _label: string | null, _rawCode?: string | null): Promise<AffiliateLink> {
  if (!(await isFlagEnabled(FLAGS.GAS_AFFILIATE))) {
    throw new AppError('AFFILIATE_DISABLED', 'Custom referral links are not available right now.', 400)
  }
  const aff = await db.gasAffiliate.findUnique({ where: { userId }, select: { status: true } })
  if (aff?.status === 'approved') {
    throw new AppError('AFFILIATE_USE_SPLIT', 'Approved affiliates create links with a custom split.', 400)
  }
  throw new AppError('AFFILIATE_NOT_APPROVED', 'Named custom links are available to approved affiliates. Apply to become an affiliate to create them.', 403)
}

/**
 * Soft-delete one of the caller's custom links. The base (primary) code can never be
 * deleted. A deleted link still attributes its past + future signups to the owner (old
 * shared links never break) and existing bindings keep earning — it just frees a slot
 * (after the cooldown) and stops giving new buyers a discount.
 */
export async function deleteOwnCustomLink(userId: string, codeId: string): Promise<{ deleted: true }> {
  if (!(await isFlagEnabled(FLAGS.GAS_AFFILIATE))) {
    throw new AppError('AFFILIATE_DISABLED', 'Custom referral links are not available right now.', 400)
  }
  const code = await db.gasReferralCode.findUnique({ where: { id: codeId }, select: { id: true, ownerId: true, deletedAt: true } })
  if (!code || code.ownerId !== userId || code.deletedAt) throw new AppError('NOT_FOUND', 'Custom link not found.', 404)

  const base = await db.gasReferralCode.findFirst({ where: { ownerId: userId, deletedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true } })
  if (base?.id === codeId) throw new AppError('CUSTOM_LINK_BASE', 'You cannot delete your primary referral link.', 400)

  await db.gasReferralCode.update({ where: { id: codeId }, data: { deletedAt: new Date() } })
  logger.info({ userId, codeId }, 'self-service custom link deleted')
  return { deleted: true }
}

export interface AffiliateQuote {
  discountUsdt: number
  discountPct: number
  referrerLabel: string
}

/**
 * Resolves the buyer's order-time affiliate auto-discount AND the referrer's display name.
 * Used both for the checkout preview (the affiliate analogue of previewPromo) and, at order
 * creation, to compute + snapshot the discount. When the flag is ON and the buyer is bound
 * to an APPROVED affiliate's active link with a positive userDiscountPct, returns the
 * margin-only discount (floored at the margin → never below base cost) plus the referrer
 * label. Read-only; returns null when there is nothing to show (flag off / unbound / 0%).
 */
export async function getAffiliateQuote(buyerUserId: string, marginUsdt: number): Promise<AffiliateQuote | null> {
  if (!(await isFlagEnabled(FLAGS.GAS_AFFILIATE))) return null
  if (!(marginUsdt > 0)) return null

  const binding = await db.gasReferral.findUnique({
    where: { referredId: buyerUserId },
    include: { code: { include: { owner: { select: { username: true } } } } },
  })
  // A soft-deleted link keeps paying the owner commission but stops discounting the buyer.
  if (!binding || !binding.code.isActive || binding.code.deletedAt) return null
  if (binding.referrerId === buyerUserId) return null
  if (!(binding.code.userDiscountPct > 0)) return null

  // Open to everyone: any active link with a buyer discount applies it (standard 5% for
  // self-service links, higher for approved affiliates). The discount % was validated
  // against the owner's caps at write time, and is floored at the margin below.
  const discountPct = binding.code.userDiscountPct
  const raw = round2((discountPct / 100) * marginUsdt)
  const discountUsdt = Math.max(0, Math.min(raw, round2(marginUsdt)))
  if (discountUsdt <= 0) return null

  const referrerLabel = binding.code.owner?.username || binding.code.label || 'your referral link'
  return { discountUsdt, discountPct, referrerLabel }
}

// ── Admin ────────────────────────────────────────────────────────────────────

export interface AdminAffiliateRow {
  userId: string
  email: string | null
  username: string | null
  referralCode: string | null
  status: AffiliateStatus
  socials: unknown
  applicantNote: string | null
  rejectionReason: string | null
  maxMarginPct: number
  minUserDiscountPct: number
  maxLinks: number
  linkCount: number
  reviewedAt: Date | null
  createdAt: Date
}

/** List all affiliate profiles (applications + approved), newest first. */
export async function adminListAffiliates(): Promise<AdminAffiliateRow[]> {
  const rows = await db.gasAffiliate.findMany({
    orderBy: { createdAt: 'desc' },
    include: { user: { select: { email: true, username: true, referralCode: true } } },
  })
  const counts = await db.gasReferralCode.groupBy({ by: ['ownerId'], _count: { _all: true } })
  const countMap = new Map(counts.map((c) => [c.ownerId, c._count._all]))
  return rows.map((r) => ({
    userId: r.userId,
    email: r.user?.email ?? null,
    username: r.user?.username ?? null,
    referralCode: r.user?.referralCode ?? null,
    status: r.status as AffiliateStatus,
    socials: r.socials,
    applicantNote: r.applicantNote,
    rejectionReason: r.rejectionReason,
    maxMarginPct: r.maxMarginPct,
    minUserDiscountPct: r.minUserDiscountPct,
    maxLinks: r.maxLinks,
    linkCount: countMap.get(r.userId) ?? 0,
    reviewedAt: r.reviewedAt,
    createdAt: r.createdAt,
  }))
}

/**
 * Approve or reject an application. On approval the admin sets the caps; the affiliate's
 * existing referral codes keep working and they can create more links up to maxLinks.
 */
export async function adminReviewAffiliate(
  adminId: string,
  userId: string,
  args: {
    decision: 'approve' | 'reject'
    maxMarginPct?: number | undefined
    minUserDiscountPct?: number | undefined
    maxLinks?: number | undefined
    rejectionReason?: string | null | undefined
  },
): Promise<{ status: AffiliateStatus }> {
  const existing = await db.gasAffiliate.findUnique({ where: { userId } })
  if (!existing) throw new AppError('NOT_FOUND', 'Affiliate application not found.', 404)

  if (args.decision === 'reject') {
    const row = await db.gasAffiliate.update({
      where: { userId },
      data: { status: 'rejected', rejectionReason: args.rejectionReason ?? null, reviewedById: adminId, reviewedAt: new Date() },
    })
    notify(
      userId,
      'affiliate',
      'Affiliate application update',
      args.rejectionReason
        ? `Your affiliate application wasn't approved this time: ${args.rejectionReason}`
        : `Your affiliate application wasn't approved this time. You can update your details and re-apply.`,
      { status: 'rejected' },
      undefined,
      '/referral',
    )
    return { status: row.status as AffiliateStatus }
  }

  // Approve — validate caps then persist.
  const maxMarginPct = args.maxMarginPct ?? existing.maxMarginPct
  const minUserDiscountPct = args.minUserDiscountPct ?? existing.minUserDiscountPct
  const maxLinks = args.maxLinks ?? existing.maxLinks
  if (maxMarginPct < 0 || maxMarginPct > 100) throw new AppError('VALIDATION_ERROR', 'maxMarginPct must be between 0 and 100.', 400)
  if (minUserDiscountPct < 0 || minUserDiscountPct > maxMarginPct) throw new AppError('VALIDATION_ERROR', 'minUserDiscountPct must be between 0 and maxMarginPct.', 400)
  if (maxLinks < 1 || maxLinks > 50) throw new AppError('VALIDATION_ERROR', 'maxLinks must be between 1 and 50.', 400)

  const wasApproved = existing.status === 'approved'
  const row = await db.gasAffiliate.update({
    where: { userId },
    data: { status: 'approved', maxMarginPct, minUserDiscountPct, maxLinks, rejectionReason: null, reviewedById: adminId, reviewedAt: new Date() },
  })
  logger.info({ userId, adminId, maxMarginPct, minUserDiscountPct, maxLinks }, 'gas affiliate approved')
  // Notify the user only on the first approval (not when an admin merely tweaks caps later).
  // This is a positive, user-initiated milestone → also DM on Telegram.
  if (!wasApproved) {
    notify(
      userId,
      'affiliate',
      "You're an approved affiliate 🎉",
      `You've been accepted into the affiliate program. You can now create custom referral links and set your own audience discount and commission split (up to a ${maxMarginPct}% margin allowance). Open the Referral page to create your first link.`,
      { status: 'approved', maxMarginPct, minUserDiscountPct, maxLinks },
      undefined,
      '/referral',
      { telegram: true },
    )
  }
  return { status: row.status as AffiliateStatus }
}
