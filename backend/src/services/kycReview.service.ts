import type { Prisma } from '@prisma/client'
import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { AppError, Errors } from '../lib/errors'
import { notify } from '../lib/notify'
import { assertCloudinaryUrl } from '../lib/upload'
import { normalizeWhatsapp, normalizeCommunityUrl } from '../lib/makerGate'
import {
  ITEM_LABEL, approvalBlock, currentItems, isFlagged, itemsOf, settleStatus,
  type ItemDecision, type KycItem, type KycPart, type SubmissionShape,
} from '../lib/kycItems'
import { sendKycEmail } from './email.service'
import { createAdminNotif } from './adminNotification.service'
import { getPublicConfig } from './marketplace.service'
import { FLAGS, isFlagEnabled } from './platformFlags.service'
import { approveMakerFromKyc } from './maker.service'
import { mergeVerifiedFromKyc } from './socialLinks.service'

/**
 * Document-level KYC review. Basic (identity) and Enhanced (ad posting) are decided separately, and an
 * applicant who has one part wrong only has to fix that part. Approved items are never reset.
 * Decisions are append-only rows (KycItemReview), so the history of every document is kept.
 */

export interface Reviewer { id: string; ip?: string | undefined; userAgent?: string | undefined }

async function audit(r: Reviewer, action: string, submissionId: string, details: Record<string, unknown>) {
  await db.auditLog.create({
    data: {
      actorId: r.id, action, targetType: 'KycSubmission', targetId: submissionId, metadata: details as Prisma.InputJsonValue,
      ipAddress: r.ip ?? null, userAgent: r.userAgent ? r.userAgent.slice(0, 500) : null,
    },
  })
}

async function loadSubmission(id: string) {
  const s = await db.kycSubmission.findUnique({ where: { id }, include: { user: { select: { email: true, kycLevel: true } } } })
  if (!s) throw Errors.NOT_FOUND('KYC submission')
  return s
}

const shapeOf = (s: Awaited<ReturnType<typeof loadSubmission>>): SubmissionShape => ({
  tier: s.tier, idType: s.idType, backUrl: s.backUrl, legalName: s.legalName, socialLinks: s.socialLinks,
  whatsappNumber: s.whatsappNumber, communityLinks: s.communityLinks, referenceUrl: s.referenceUrl,
})

/** The review state of a submission: its parts, and each item's latest decision. */
export async function reviewState(id: string) {
  const s = await loadSubmission(id)
  const events = await db.kycItemReview.findMany({ where: { submissionId: id }, orderBy: { createdAt: 'asc' }, select: { item: true, status: true, reason: true, createdAt: true } })
  const stateOf = (part: KycPart) => (part === 'basic' ? s.basicState : s.enhancedState)
  // Items of a part that was approved before (or without line-by-line decisions) read as approved.
  const items = currentItems(itemsOf(shapeOf(s)), events).map((i) => (i.status === 'pending' && stateOf(i.part) === 'approved' ? { ...i, status: 'approved' as const } : i))
  return { submission: s, items, parts: { basicState: s.basicState, enhancedState: s.enhancedState } }
}

/** Record what the reviewer decided about ONE document or answer. Saved at once, so it is never lost. */
export async function recordItemDecision(id: string, item: string, decision: ItemDecision, reason: string | undefined, by: Reviewer) {
  const { submission, items } = await reviewState(id)
  if (submission.status !== 'pending') throw new AppError('INVALID_STATUS', 'This submission is already closed.', 400)
  const found = items.find((i) => i.item === item)
  if (!found) throw new AppError('VALIDATION_ERROR', 'That item is not part of this submission.', 400)
  const partState = found.part === 'basic' ? submission.basicState : submission.enhancedState
  if (partState === 'approved' || partState === 'rejected') {
    throw new AppError('INVALID_STATUS', `${found.part === 'basic' ? 'Basic' : 'Enhanced'} is already decided.`, 400)
  }
  const why = (reason ?? '').trim().slice(0, 300)
  if (decision !== 'approved' && !why) throw new AppError('VALIDATION_ERROR', 'Say what is wrong, so the applicant knows what to send again.', 400)
  await db.kycItemReview.create({ data: { submissionId: id, item, status: decision, reason: decision === 'approved' ? null : why, actorId: by.id } })
  await audit(by, 'KYC_ITEM_REVIEWED', id, { item, decision, reason: why || null })
  return (await reviewState(id)).items
}

function describeFlagged(items: Array<{ item: KycItem; reason: string | null }>): string {
  return items.map((i) => `${ITEM_LABEL[i.item]}${i.reason ? `: ${i.reason}` : ''}`).join('; ')
}

/** Tell the applicant which items to send again. Parts with nothing flagged keep waiting for review. */
export async function requestChanges(id: string, by: Reviewer) {
  const { submission, items } = await reviewState(id)
  if (submission.status !== 'pending') throw new AppError('INVALID_STATUS', 'This submission is already closed.', 400)
  const flagged = items.filter((i) => isFlagged(i.status))
  if (flagged.length === 0) throw new AppError('VALIDATION_ERROR', 'Mark at least one item that needs to be sent again.', 400)
  const parts = new Set<KycPart>(flagged.map((i) => i.part))
  const data: Prisma.KycSubmissionUpdateManyMutationInput = {}
  if (parts.has('basic') && submission.basicState === 'pending') data.basicState = 'changes_requested'
  if (parts.has('enhanced') && submission.enhancedState === 'pending') data.enhancedState = 'changes_requested'
  if (Object.keys(data).length > 0) await db.kycSubmission.updateMany({ where: { id, status: 'pending' }, data })
  await audit(by, 'KYC_CHANGES_REQUESTED', id, { items: flagged.map((i) => ({ item: i.item, status: i.status, reason: i.reason })) })
  const text = describeFlagged(flagged)
  await sendKycEmail('changes_requested', submission.user.email, { reason: text }).catch(() => {})
  notify(submission.userId, 'kyc', 'KYC: changes needed', `Please send these again: ${text}. Everything else you sent is fine and was kept.`, { items: flagged.map((i) => i.item) })
  return (await reviewState(id)).items
}

/** Approve Basic (identity) or Enhanced (ad posting) on its own. */
export async function approvePart(id: string, part: KycPart, by: Reviewer, opts: { silent?: boolean } = {}) {
  const { submission, items, parts } = await reviewState(id)
  if (submission.status !== 'pending') throw new AppError('INVALID_STATUS', 'This submission is already closed.', 400)
  const block = approvalBlock(part, parts, items)
  if (block) throw new AppError('INVALID_STATUS', block, 400)

  if (part === 'basic' && submission.cnicNumberHash) {
    // Never approve an ID that is already verified on a DIFFERENT account.
    const conflict = await db.kycSubmission.findFirst({
      where: { cnicNumberHash: submission.cnicNumberHash, status: 'approved', userId: { not: submission.userId } },
      include: { user: { select: { username: true, email: true } } },
    })
    if (conflict) {
      const who = conflict.user?.username || conflict.user?.email || conflict.userId
      throw new AppError('CNIC_DUPLICATE', `This CNIC is already verified on another account (${who}). Reject this submission instead of approving it.`, 409)
    }
  }

  const cfg = await getPublicConfig()
  const nonCustodial = await isFlagEnabled(FLAGS.NONCUSTODIAL_P2P)
  const stateKey = part === 'basic' ? 'basicState' : 'enhancedState'
  const next = { ...parts, [stateKey]: 'approved' }
  const finalStatus = settleStatus(next)

  await db.$transaction(async (tx) => {
    // Compare-and-set: a double click or a second reviewer cannot approve the same part twice.
    const claimed = await tx.kycSubmission.updateMany({
      where: { id, status: 'pending', [stateKey]: { in: ['pending', 'changes_requested'] } },
      data: { [stateKey]: 'approved', status: finalStatus, ...(finalStatus === 'approved' ? { reviewedAt: new Date(), reviewedBy: by.id } : {}) },
    })
    if (claimed.count === 0) throw new AppError('CONFLICT', 'This was already decided by someone else.', 409)
    const open = items.filter((i) => i.part === part && i.status !== 'approved')
    if (open.length > 0) {
      await tx.kycItemReview.createMany({ data: open.map((i) => ({ submissionId: id, item: i.item, status: 'approved', actorId: by.id })) })
    }
    if (part === 'basic') {
      const alreadyEnhanced = submission.user.kycLevel === 'enhanced'
      const lockName = nonCustodial && !!submission.legalName?.trim()
      await tx.user.update({
        where: { id: submission.userId },
        data: {
          kycStatus: 'approved',
          ...(alreadyEnhanced ? {} : { kycLevel: 'basic', dailyBuyLimit: cfg.kycLimitBasicDaily, dailySellLimit: cfg.kycLimitBasicDaily }),
          ...(lockName ? { fullName: submission.legalName!.trim(), legalNameLockedAt: new Date() } : {}),
        },
      })
    } else {
      await tx.user.update({
        where: { id: submission.userId },
        data: { kycStatus: 'approved', kycLevel: 'enhanced', dailyBuyLimit: cfg.kycLimitEnhancedDaily, dailySellLimit: cfg.kycLimitEnhancedDaily },
      })
    }
  })

  if (part === 'basic') {
    // Promote the submission's social links to the user's permanent VERIFIED set (best effort).
    try {
      const submitted = Array.isArray(submission.socialLinks)
        ? (submission.socialLinks as Array<{ platform?: unknown; url?: unknown }>)
            .filter((l) => typeof l?.platform === 'string' && typeof l?.url === 'string')
            .map((l) => ({ platform: l.platform as string, url: l.url as string }))
        : []
      await mergeVerifiedFromKyc(submission.userId, submitted)
    } catch { /* social sync must not fail approval */ }
  } else {
    // Level 2 doubles as the maker review: approving it approves the user as a maker.
    try { await approveMakerFromKyc(by.id, submission.userId) } catch { /* never blocks KYC approval */ }
  }

  await audit(by, part === 'basic' ? 'KYC_BASIC_APPROVED' : 'KYC_ENHANCED_APPROVED', id, { userId: submission.userId, level: part })
  if (!opts.silent) {
    const label = part === 'basic' ? 'Basic' : 'Enhanced'
    await sendKycEmail('approved', submission.user.email, { level: part === 'basic' ? 'basic' : 'enhanced' }).catch(() => {})
    const rest = part === 'basic' && next.enhancedState !== 'not_requested' && next.enhancedState !== 'approved'
      ? ' Your Enhanced (ad posting) request is still being reviewed.'
      : ''
    notify(submission.userId, 'kyc', `KYC ${label} approved`, `Your ${label} verification is approved.${rest}`, { tier: part })
  }
  return { status: finalStatus, parts: next }
}

/** Reject one part, or everything. Rejecting Enhanced never touches an approved Basic. */
export async function rejectPart(id: string, part: KycPart | 'all', reason: string, by: Reviewer) {
  const why = reason.trim().slice(0, 500)
  if (!why) throw new AppError('VALIDATION_ERROR', 'A reason is required.', 400)
  const s = await loadSubmission(id)
  if (s.status !== 'pending') throw new AppError('INVALID_STATUS', 'This submission is already closed.', 400)

  const target: KycPart = part === 'all' ? (s.basicState === 'approved' ? 'enhanced' : 'basic') : part
  if (target === 'enhanced' && s.enhancedState === 'not_requested') throw new AppError('INVALID_STATUS', 'The applicant did not apply for Enhanced.', 400)
  if (target === 'basic' && s.basicState === 'approved') throw new AppError('INVALID_STATUS', 'Basic is already approved. Reject Enhanced instead.', 400)

  // Rejecting identity also ends Enhanced, which cannot stand without it.
  const next = {
    basicState: target === 'basic' ? 'rejected' : s.basicState,
    enhancedState: target === 'basic' ? (s.enhancedState === 'not_requested' ? 'not_requested' : 'rejected') : 'rejected',
  }
  const status = settleStatus(next)
  const claimed = await db.kycSubmission.updateMany({
    where: { id, status: 'pending' },
    data: { ...next, status, rejectionReason: why, ...(status !== 'pending' ? { reviewedAt: new Date(), reviewedBy: by.id } : {}) },
  })
  if (claimed.count === 0) throw new AppError('CONFLICT', 'This was already decided by someone else.', 409)
  // An approved Basic keeps the user's verified status; only a rejected identity flips it.
  if (target === 'basic') {
    await db.user.update({ where: { id: s.userId }, data: { kycStatus: 'rejected', socialLinksPublic: false } })
  } else if (s.basicState === 'approved') {
    // Submitting the Enhanced request had set the status to pending; the verified identity stands.
    await db.user.update({ where: { id: s.userId }, data: { kycStatus: 'approved' } })
  }
  await audit(by, 'KYC_REJECTED', id, { reason: why, part: target })
  await sendKycEmail('rejected', s.user.email, { reason: why }).catch(() => {})
  notify(s.userId, 'kyc', target === 'basic' ? 'KYC Rejected' : 'KYC Enhanced not approved', `${target === 'basic' ? 'Your KYC submission was rejected' : 'Your Enhanced request was not approved'}. Reason: ${why}`, { rejectionReason: why })
  return { status, parts: next }
}

// ── The applicant sends back only what was flagged ───────────────────────────────────────────────

export interface ResubmitFields {
  frontUrl?: string
  backUrl?: string
  selfieUrl?: string
  legalName?: string
  socialLinks?: Array<{ platform: string; url: string }>
  whatsappNumber?: string
  communityLinks?: Array<{ url: string }>
  referenceUrl?: string
}

const FIELD_ITEM: Record<keyof ResubmitFields, KycItem> = {
  frontUrl: 'id_front', backUrl: 'id_back', selfieUrl: 'selfie', legalName: 'legal_name', socialLinks: 'social',
  whatsappNumber: 'whatsapp', communityLinks: 'community', referenceUrl: 'reference',
}

export async function resubmitItems(userId: string, submissionId: string, fields: ResubmitFields) {
  const { submission, items } = await reviewState(submissionId)
  if (submission.userId !== userId) throw Errors.NOT_FOUND('KYC submission')
  if (submission.status !== 'pending') throw new AppError('INVALID_STATUS', 'This submission is closed. Start a new one.', 400)

  const entries = (Object.keys(fields) as Array<keyof ResubmitFields>).filter((k) => fields[k] !== undefined)
  if (entries.length === 0) throw new AppError('VALIDATION_ERROR', 'Send at least one of the items that need changes.', 400)
  for (const k of entries) {
    const cur = items.find((i) => i.item === FIELD_ITEM[k])
    if (!cur || !isFlagged(cur.status)) {
      throw new AppError('VALIDATION_ERROR', `${ITEM_LABEL[FIELD_ITEM[k]]} was not sent back, so it cannot be changed.`, 400)
    }
  }

  const rate = `kyc_resubmit:${userId}`
  const n = await redis.incr(rate)
  if (n === 1) await redis.expire(rate, 86400)
  if (n > 10) throw new AppError('RATE_LIMIT', 'Too many changes today. Try again tomorrow.', 429)

  // Validate every value like a fresh submission would.
  const data: Prisma.KycSubmissionUpdateInput = {}
  const previous: Partial<Record<KycItem, string | null>> = {}
  if (fields.frontUrl !== undefined) { assertCloudinaryUrl(fields.frontUrl, 'frontUrl'); data.frontUrl = fields.frontUrl; previous.id_front = submission.frontUrl }
  if (fields.backUrl !== undefined) { assertCloudinaryUrl(fields.backUrl, 'backUrl'); data.backUrl = fields.backUrl; previous.id_back = submission.backUrl }
  if (fields.selfieUrl !== undefined) { assertCloudinaryUrl(fields.selfieUrl, 'selfieUrl'); data.selfieUrl = fields.selfieUrl; previous.selfie = submission.selfieUrl }
  if (fields.legalName !== undefined) {
    const name = fields.legalName.trim()
    if (name.length < 3 || name.length > 100) throw new AppError('VALIDATION_ERROR', 'Enter your full name as printed on your ID or passport', 400)
    data.legalName = name; previous.legal_name = submission.legalName
  }
  if (fields.socialLinks !== undefined) {
    const links = fields.socialLinks.filter((l) => l.url.trim())
    if (links.length < 1) throw new AppError('VALIDATION_ERROR', 'Add at least one social profile', 400)
    data.socialLinks = links; previous.social = JSON.stringify(submission.socialLinks)
  }
  let whatsapp: string | null = null
  if (fields.whatsappNumber !== undefined) {
    whatsapp = normalizeWhatsapp(fields.whatsappNumber)
    if (!whatsapp) throw new AppError('VALIDATION_ERROR', 'Enter your WhatsApp number with country code, e.g. +923001234567', 400)
    data.whatsappNumber = whatsapp; previous.whatsapp = submission.whatsappNumber
  }
  if (fields.communityLinks !== undefined) {
    const links = fields.communityLinks.map((l) => normalizeCommunityUrl(l.url)).filter((x): x is string => !!x).map((url) => ({ url }))
    if (links.length < 1) throw new AppError('VALIDATION_ERROR', 'Add the link to your WhatsApp or Telegram group or channel (https://chat.whatsapp.com/..., https://t.me/...)', 400)
    data.communityLinks = links; previous.community = JSON.stringify(submission.communityLinks)
  }
  if (fields.referenceUrl !== undefined) {
    const ref = fields.referenceUrl.trim()
    try { if (new URL(ref).protocol !== 'https:') throw new Error('x') } catch { throw new AppError('VALIDATION_ERROR', 'The trusted reference must be a link starting with https://', 400) }
    data.referenceUrl = ref.slice(0, 500); previous.reference = submission.referenceUrl
  }

  const sentItems = entries.map((k) => FIELD_ITEM[k])
  const nextStates = { basicState: submission.basicState, enhancedState: submission.enhancedState }
  const stillFlagged = (part: KycPart) => items.some((i) => i.part === part && isFlagged(i.status) && !sentItems.includes(i.item))
  if (submission.basicState === 'changes_requested' && !stillFlagged('basic')) nextStates.basicState = 'pending'
  if (submission.enhancedState === 'changes_requested' && !stillFlagged('enhanced')) nextStates.enhancedState = 'pending'

  await db.$transaction(async (tx) => {
    const claimed = await tx.kycSubmission.updateMany({ where: { id: submissionId, userId, status: 'pending' }, data: { ...(data as Prisma.KycSubmissionUpdateManyMutationInput), ...nextStates } })
    if (claimed.count === 0) throw new AppError('CONFLICT', 'This submission changed. Reload and try again.', 409)
    await tx.kycItemReview.createMany({ data: sentItems.map((item) => ({ submissionId, item, status: 'resubmitted', previousValue: previous[item] ?? null, actorId: userId })) })
    if (whatsapp) await tx.user.update({ where: { id: userId }, data: { whatsappNumber: whatsapp } })
  })

  void createAdminNotif({
    category: 'KYC', title: 'KYC changes resubmitted',
    body: `A user sent back: ${sentItems.map((i) => ITEM_LABEL[i]).join(', ')}. Submission ID: ${submissionId}`,
    href: '/admin/kyc', metadata: { userId, submissionId, items: sentItems },
  })
  return (await reviewState(submissionId))
}


