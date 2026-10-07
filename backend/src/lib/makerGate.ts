import { db } from './prisma'
import { AppError } from './errors'
import { FLAGS, isFlagEnabled, getNumberConfig } from '../services/platformFlags.service'

/**
 * Maker gate (stage 2).
 *
 * Posting an ad or CTM listing needs more than a basic account: Level 2 KYC, a
 * username, a linked Telegram, a WhatsApp number and an admin's approval. A new
 * maker's first few ads then wait in a review queue before going live.
 *
 * EVERYTHING here is behind the maker_gate_enabled flag. With the flag OFF every
 * function is a no-op, so deploying this changes nothing until it is switched on.
 * Existing makers were auto-approved by the migration, and trusted accounts skip
 * the whole gate (they are never exempt from a trading hold — see tradingHold.ts).
 */

export interface MakerRequirement {
  key: 'kyc' | 'username' | 'telegram' | 'whatsapp' | 'approval'
  label: string
  met: boolean
}

export interface MakerStatusView {
  gateEnabled: boolean
  /** True when the user may post right now (gate off, trusted, or all requirements met). */
  eligible: boolean
  trusted: boolean
  makerStatus: 'none' | 'pending' | 'approved' | 'rejected'
  reviewNote: string | null
  whatsappNumber: string | null
  requirements: MakerRequirement[]
  /** All prerequisites except admin approval are met, so the user can apply. */
  canApply: boolean
  reviewFirstN: number
}

const DEFAULT_REVIEW_FIRST_N = 3

export async function isMakerGateOn(): Promise<boolean> {
  return isFlagEnabled(FLAGS.MAKER_GATE, false)
}

export async function getMakerStatus(userId: string): Promise<MakerStatusView> {
  const [gateEnabled, reviewFirstN, u] = await Promise.all([
    isMakerGateOn(),
    getNumberConfig('maker_review_first_n', DEFAULT_REVIEW_FIRST_N),
    db.user.findUnique({
      where: { id: userId },
      select: {
        kycStatus: true, kycLevel: true, username: true, telegramId: true, whatsappNumber: true,
        makerStatus: true, makerReviewNote: true, isTrusted: true,
      },
    }),
  ])
  if (!u) throw new AppError('NOT_FOUND', 'User not found', 404)

  const makerStatus = (['none', 'pending', 'approved', 'rejected'] as const).find((s) => s === u.makerStatus) ?? 'none'
  const requirements: MakerRequirement[] = [
    { key: 'kyc', label: 'Identity verified (Level 2 KYC)', met: u.kycStatus === 'approved' && u.kycLevel === 'enhanced' },
    { key: 'username', label: 'Username set', met: !!u.username },
    { key: 'telegram', label: 'Telegram account linked', met: u.telegramId !== null },
    { key: 'whatsapp', label: 'WhatsApp number added', met: !!u.whatsappNumber },
    { key: 'approval', label: 'Approved by RupChain', met: makerStatus === 'approved' },
  ]
  const prerequisitesMet = requirements.filter((r) => r.key !== 'approval').every((r) => r.met)
  const eligible = !gateEnabled || u.isTrusted || requirements.every((r) => r.met)

  return {
    gateEnabled,
    eligible,
    trusted: u.isTrusted,
    makerStatus,
    reviewNote: u.makerReviewNote,
    whatsappNumber: u.whatsappNumber,
    requirements,
    canApply: prerequisitesMet && (makerStatus === 'none' || makerStatus === 'rejected'),
    reviewFirstN,
  }
}

/** Throws MAKER_NOT_APPROVED when the gate is on and the user is not yet allowed to post. */
export async function assertMakerEligible(userId: string): Promise<void> {
  if (!(await isMakerGateOn())) return
  const s = await getMakerStatus(userId)
  if (s.eligible) return
  const missing = s.requirements.filter((r) => !r.met).map((r) => r.label)
  throw new AppError(
    'MAKER_NOT_APPROVED',
    `To post ads you first need to become a maker. Still needed: ${missing.join('; ')}. Open "Become a maker" to finish.`,
    403,
  )
}

/**
 * Whether a brand-new ad/listing goes live straight away or waits for review.
 * Trusted accounts and gate-off are always 'active'. Otherwise a maker's first
 * `maker_review_first_n` ads are reviewed, as is any ad above the optional
 * `maker_review_above_usdt` size.
 */
export async function decideInitialStatus(
  userId: string,
  sizeUsdt: number | null,
): Promise<'active' | 'pending_review'> {
  if (!(await isMakerGateOn())) return 'active'
  const u = await db.user.findUnique({ where: { id: userId }, select: { isTrusted: true } })
  if (u?.isTrusted) return 'active'

  const [firstN, aboveUsdt] = await Promise.all([
    getNumberConfig('maker_review_first_n', DEFAULT_REVIEW_FIRST_N),
    getNumberConfig('maker_review_above_usdt', 0),
  ])
  if (aboveUsdt > 0 && sizeUsdt !== null && sizeUsdt > aboveUsdt) return 'pending_review'

  // History = ads that genuinely went live: approved by an admin, or created before the
  // maker was approved (which is how grandfathered makers' old ads count). Ads the
  // maker created and then closed or deleted while they were still pending never
  // count, otherwise create-then-close three times would skip review for good.
  const maker = await db.user.findUnique({ where: { id: userId }, select: { makerApprovedAt: true } })
  const wentLive = maker?.makerApprovedAt
    ? { OR: [{ reviewedBy: { not: null } }, { createdAt: { lte: maker.makerApprovedAt } }] }
    : { reviewedBy: { not: null } }
  const [ads, listings] = await Promise.all([
    db.ad.count({ where: { userId, status: { notIn: ['pending_review', 'rejected'] }, ...wentLive } }),
    db.ctmListing.count({
      where: {
        merchantProfile: { userId },
        // 'cancelled' with a reviewNote is an admin rejection, not a live listing.
        NOT: [{ status: 'pending_review' }, { status: 'cancelled', reviewNote: { not: null } }],
        ...wentLive,
      },
    }),
  ])
  return ads + listings < firstN ? 'pending_review' : 'active'
}

/** Normalise a phone number to +digits (7–15 digits), or null when it is not plausible. */
export function normalizeWhatsapp(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, '')
  const plus = digits.startsWith('+') ? '+' : ''
  const body = digits.replace(/\+/g, '')
  if (body.length < 7 || body.length > 15) return null
  return `${plus || '+'}${body}`
}
