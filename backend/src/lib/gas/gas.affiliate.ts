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
import { isFlagEnabled, FLAGS } from '../../services/platformFlags.service'
import { generateUniqueCode, getReferralSummary, type ReferralSummary } from './gas.referral'
import type { Prisma } from '@prisma/client'

function round2(n: number): number { return Math.round(n * 100) / 100 }

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

export interface AffiliateOverview {
  enabled: boolean
  status: AffiliateStatus
  applicantNote: string | null
  rejectionReason: string | null
  caps: { maxMarginPct: number; minUserDiscountPct: number; maxLinks: number } | null
  links: AffiliateLink[]
  earnings: ReferralSummary
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
  return { status: row.status as AffiliateStatus }
}

/** User-facing overview: profile status + caps, all of the user's links, and earnings. */
export async function getAffiliateOverview(userId: string): Promise<AffiliateOverview> {
  const enabled = await isFlagEnabled(FLAGS.GAS_AFFILIATE)
  const earnings = await getReferralSummary(userId)
  const profile = await db.gasAffiliate.findUnique({ where: { userId } })
  const status: AffiliateStatus = (profile?.status as AffiliateStatus) ?? 'none'

  let links: AffiliateLink[] = []
  if (status === 'approved') {
    const codes = await db.gasReferralCode.findMany({ where: { ownerId: userId }, orderBy: { createdAt: 'asc' } })
    const counts = await db.gasReferral.groupBy({ by: ['codeId'], where: { codeId: { in: codes.map((c) => c.id) } }, _count: { _all: true } })
    const countMap = new Map(counts.map((c) => [c.codeId, c._count._all]))
    links = codes.map((c) => ({
      id: c.id,
      code: c.code,
      label: c.label,
      userDiscountPct: c.userDiscountPct,
      commissionPct: c.referralPct,
      isActive: c.isActive,
      referredCount: countMap.get(c.id) ?? 0,
    }))
  }

  return {
    enabled,
    status,
    applicantNote: profile?.applicantNote ?? null,
    rejectionReason: profile?.rejectionReason ?? null,
    caps: profile && status === 'approved'
      ? { maxMarginPct: profile.maxMarginPct, minUserDiscountPct: profile.minUserDiscountPct, maxLinks: profile.maxLinks }
      : null,
    links,
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

/** Create a new affiliate link with a chosen split (respecting caps + maxLinks). */
export async function createAffiliateLink(
  userId: string,
  args: { label: string | null; userDiscountPct: number; commissionPct: number },
): Promise<AffiliateLink> {
  const aff = await requireApprovedAffiliate(userId)
  assertSplit(aff, args.userDiscountPct, args.commissionPct)
  const count = await db.gasReferralCode.count({ where: { ownerId: userId } })
  if (count >= aff.maxLinks) {
    throw new AppError('AFFILIATE_MAX_LINKS', `You can have at most ${aff.maxLinks} affiliate links.`, 400)
  }
  const code = await generateUniqueCode()
  const created = await db.gasReferralCode.create({
    data: { code, ownerId: userId, referralPct: args.commissionPct, userDiscountPct: args.userDiscountPct, label: args.label },
  })
  logger.info({ userId, codeId: created.id }, 'gas affiliate link created')
  return { id: created.id, code: created.code, label: created.label, userDiscountPct: created.userDiscountPct, commissionPct: created.referralPct, isActive: created.isActive, referredCount: 0 }
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
  if (!binding || !binding.code.isActive) return null
  if (binding.referrerId === buyerUserId) return null
  if (!(binding.code.userDiscountPct > 0)) return null

  const aff = await db.gasAffiliate.findUnique({ where: { userId: binding.referrerId }, select: { status: true } })
  if (!aff || aff.status !== 'approved') return null

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
    include: { user: { select: { email: true } } },
  })
  const counts = await db.gasReferralCode.groupBy({ by: ['ownerId'], _count: { _all: true } })
  const countMap = new Map(counts.map((c) => [c.ownerId, c._count._all]))
  return rows.map((r) => ({
    userId: r.userId,
    email: r.user?.email ?? null,
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
    return { status: row.status as AffiliateStatus }
  }

  // Approve — validate caps then persist.
  const maxMarginPct = args.maxMarginPct ?? existing.maxMarginPct
  const minUserDiscountPct = args.minUserDiscountPct ?? existing.minUserDiscountPct
  const maxLinks = args.maxLinks ?? existing.maxLinks
  if (maxMarginPct < 0 || maxMarginPct > 100) throw new AppError('VALIDATION_ERROR', 'maxMarginPct must be between 0 and 100.', 400)
  if (minUserDiscountPct < 0 || minUserDiscountPct > maxMarginPct) throw new AppError('VALIDATION_ERROR', 'minUserDiscountPct must be between 0 and maxMarginPct.', 400)
  if (maxLinks < 1 || maxLinks > 50) throw new AppError('VALIDATION_ERROR', 'maxLinks must be between 1 and 50.', 400)

  const row = await db.gasAffiliate.update({
    where: { userId },
    data: { status: 'approved', maxMarginPct, minUserDiscountPct, maxLinks, rejectionReason: null, reviewedById: adminId, reviewedAt: new Date() },
  })
  logger.info({ userId, adminId, maxMarginPct, minUserDiscountPct, maxLinks }, 'gas affiliate approved')
  return { status: row.status as AffiliateStatus }
}
