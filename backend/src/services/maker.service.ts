import { db } from '../lib/prisma'
import { AppError } from '../lib/errors'
import { notify } from '../lib/notify'
import { recordAuditLog } from '../lib/audit'
import { createAdminNotif } from './adminNotification.service'
import { autoShareToOwnerChannels } from './channel.service'
import { getMakerStatus, normalizeWhatsapp, MAKER_CONTACT_KEY } from '../lib/makerGate'
import { getNumberConfig, getStringConfig } from './platformFlags.service'

/** Maker applications + the new-ad review queue (stage 2). */

// ─── Maker (user side) ───────────────────────────────────────────────────────

export async function saveWhatsappNumber(userId: string, raw: string) {
  const normalized = normalizeWhatsapp(raw)
  if (!normalized) throw new AppError('VALIDATION_ERROR', 'Enter a valid WhatsApp number with country code, e.g. +923001234567', 400)
  await db.user.update({ where: { id: userId }, data: { whatsappNumber: normalized } })
  return getMakerStatus(userId)
}

export async function applyForMaker(userId: string) {
  const s = await getMakerStatus(userId)
  if (s.makerStatus === 'approved') throw new AppError('CONFLICT', 'You are already an approved maker', 409)
  if (s.makerStatus === 'pending') throw new AppError('CONFLICT', 'Your application is already under review', 409)
  if (!s.canApply) {
    const missing = s.requirements.filter((r) => r.key !== 'approval' && !r.met).map((r) => r.label)
    throw new AppError('REQUIREMENTS_NOT_MET', `Finish these first: ${missing.join('; ')}`, 400)
  }
  const user = await db.user.update({
    where: { id: userId },
    data: { makerStatus: 'pending', makerAppliedAt: new Date(), makerReviewNote: null },
    select: { username: true },
  })
  void createAdminNotif({
    category: 'SYSTEM',
    title: 'New maker application',
    body: `@${user.username} applied to become a maker. Review and contact them before approving.`,
    href: '/admin/makers',
  })
  return getMakerStatus(userId)
}

/**
 * Level 2 KYC is the maker review: when an admin approves a Level 2 submission the
 * user becomes an approved maker too, so there is no separate application to wait
 * for. Restricted accounts are left alone. Returns whether the user was approved.
 */
export async function approveMakerFromKyc(adminId: string, userId: string): Promise<boolean> {
  const u = await db.user.findUnique({
    where: { id: userId },
    select: { makerStatus: true, tradingHold: true, isBanned: true, isSuspended: true },
  })
  if (!u || u.makerStatus === 'approved' || u.tradingHold || u.isBanned || u.isSuspended) return false
  await db.user.update({
    where: { id: userId },
    data: { makerStatus: 'approved', makerApprovedAt: new Date(), makerApprovedBy: adminId, makerReviewNote: null },
  })
  await recordAuditLog(adminId, 'MAKER_APPROVED', 'User', userId, { via: 'level2_kyc' })
  notify(
    userId,
    'maker_review',
    'You are now an approved maker',
    'Your Level 2 verification was approved. You can post ads and CTM listings. Your first few ads are reviewed before they go live.',
    { approved: true },
    undefined,
    '/maker',
  )
  return true
}

// ─── Maker applications (admin) ──────────────────────────────────────────────

export async function listMakerApplications(status: 'pending' | 'approved' | 'rejected') {
  const users = await db.user.findMany({
    where: { makerStatus: status },
    orderBy: status === 'pending' ? { makerAppliedAt: 'asc' } : { makerApprovedAt: 'desc' },
    take: 100,
    select: {
      id: true, username: true, fullName: true, email: true, kycLevel: true, kycStatus: true, createdAt: true,
      telegramUsername: true, whatsappNumber: true, makerAppliedAt: true, makerApprovedAt: true, makerReviewNote: true,
      isTrusted: true, tradingHold: true,
      tradeStats: { select: { totalTrades: true, completedTrades: true, completionRate: true } },
    },
  })
  return users.map((u) => ({
    ...u,
    tradeStats: u.tradeStats ? { ...u.tradeStats, completionRate: u.tradeStats.completionRate.toString() } : null,
  }))
}

export async function decideMaker(adminId: string, userId: string, approve: boolean, note: string | undefined) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, tradingHold: true, isBanned: true, isSuspended: true },
  })
  if (!user) throw new AppError('NOT_FOUND', 'User not found', 404)
  if (approve && (user.tradingHold || user.isBanned || user.isSuspended)) {
    throw new AppError('CONFLICT', 'This account is restricted — lift the restriction before approving it as a maker', 409)
  }
  if (!approve && !note?.trim()) throw new AppError('VALIDATION_ERROR', 'A reason is required when rejecting', 400)

  await db.user.update({
    where: { id: userId },
    data: approve
      ? { makerStatus: 'approved', makerApprovedAt: new Date(), makerApprovedBy: adminId, makerReviewNote: null }
      : { makerStatus: 'rejected', makerReviewNote: note!.trim().slice(0, 500) },
  })
  await recordAuditLog(adminId, approve ? 'MAKER_APPROVED' : 'MAKER_REJECTED', 'User', userId, { note: note ?? null })
  notify(
    userId,
    'maker_review',
    approve ? 'You are now an approved maker' : 'Maker application not approved',
    approve
      ? 'You can post ads and CTM listings. Your first few ads are reviewed before they go live.'
      : `Your application was not approved. ${note!.trim()} You can fix this and apply again.`,
    { approved: approve },
    undefined,
    '/maker',
  )
}

// ─── Ad review queue (admin) ─────────────────────────────────────────────────

const MAKER_SELECT = {
  id: true,
  username: true,
  kycLevel: true,
  tradeStats: { select: { totalTrades: true, completedTrades: true } },
} as const

export async function listPendingAds() {
  const [ads, listings] = await Promise.all([
    db.ad.findMany({
      where: { status: 'pending_review' },
      orderBy: { createdAt: 'asc' },
      take: 100,
      select: {
        id: true, side: true, coin: true, network: true, price: true, minOrder: true, maxOrder: true, totalAmount: true,
        paymentMethods: true, terms: true, tradeWindow: true, createdAt: true,
        user: { select: MAKER_SELECT },
      },
    }),
    db.ctmListing.findMany({
      where: { status: 'pending_review' },
      orderBy: { createdAt: 'asc' },
      take: 100,
      select: {
        id: true, side: true, pricePerUnit: true, minOrderTokens: true, maxOrderTokens: true, totalAmount: true,
        paymentMethods: true, terms: true, createdAt: true,
        token: { select: { symbol: true, name: true, network: true } },
        merchantProfile: { select: { user: { select: MAKER_SELECT } } },
      },
    }),
  ])
  return {
    ads: ads.map((a) => ({
      kind: 'usdt' as const,
      id: a.id,
      side: a.side,
      title: `${a.side === 'sell' ? 'Sell' : 'Buy'} ${a.coin}${a.network ? ` (${a.network})` : ''}`,
      price: a.price.toString(),
      minOrder: a.minOrder.toString(),
      maxOrder: a.maxOrder.toString(),
      totalAmount: a.totalAmount.toString(),
      paymentMethods: a.paymentMethods,
      terms: a.terms,
      tradeWindowMins: a.tradeWindow,
      createdAt: a.createdAt,
      maker: a.user,
    })),
    listings: listings.map((l) => ({
      kind: 'ctm' as const,
      id: l.id,
      side: l.side,
      title: `${l.side === 'sell' ? 'Sell' : 'Buy'} ${l.token.symbol} (${l.token.name})`,
      price: l.pricePerUnit.toString(),
      minOrder: l.minOrderTokens.toString(),
      maxOrder: l.maxOrderTokens.toString(),
      totalAmount: l.totalAmount.toString(),
      paymentMethods: l.paymentMethods,
      terms: l.terms,
      tradeWindowMins: null as number | null,
      createdAt: l.createdAt,
      maker: l.merchantProfile.user,
    })),
  }
}

async function assertOwnerNotRestricted(ownerId: string, what: string): Promise<void> {
  const owner = await db.user.findUnique({ where: { id: ownerId }, select: { tradingHold: true, isBanned: true, isSuspended: true } })
  if (owner?.tradingHold || owner?.isBanned || owner?.isSuspended) {
    throw new AppError('CONFLICT', `The maker is restricted — cannot approve this ${what}`, 409)
  }
}

export async function reviewPendingAd(adminId: string, kind: 'usdt' | 'ctm', id: string, approve: boolean, note: string | undefined) {
  if (!approve && !note?.trim()) throw new AppError('VALIDATION_ERROR', 'A reason is required when rejecting', 400)
  const reviewNote = approve ? null : note!.trim().slice(0, 500)
  const stamp = { reviewNote, reviewedBy: adminId, reviewedAt: new Date() }

  let ownerId: string
  let label: string
  if (kind === 'usdt') {
    const ad = await db.ad.findUnique({ where: { id }, select: { userId: true, status: true, side: true, coin: true } })
    if (!ad) throw new AppError('NOT_FOUND', 'Ad not found', 404)
    if (ad.status !== 'pending_review') throw new AppError('CONFLICT', 'This ad is not waiting for review', 409)
    // A hold applied while the ad waited must win over approval.
    if (approve) await assertOwnerNotRestricted(ad.userId, 'ad')
    await db.ad.update({ where: { id }, data: { status: approve ? 'active' : 'rejected', ...stamp } })
    ownerId = ad.userId
    label = `${ad.side === 'sell' ? 'Sell' : 'Buy'} ${ad.coin}`
    if (approve) void autoShareToOwnerChannels(ownerId, { market: 'usdt', id })
  } else {
    const l = await db.ctmListing.findUnique({
      where: { id },
      select: { status: true, side: true, token: { select: { symbol: true } }, merchantProfile: { select: { userId: true } } },
    })
    if (!l) throw new AppError('NOT_FOUND', 'Listing not found', 404)
    if (l.status !== 'pending_review') throw new AppError('CONFLICT', 'This listing is not waiting for review', 409)
    ownerId = l.merchantProfile.userId
    if (approve) await assertOwnerNotRestricted(ownerId, 'listing')
    await db.ctmListing.update({ where: { id }, data: { status: approve ? 'active' : 'cancelled', ...stamp } })
    label = `${l.side === 'sell' ? 'Sell' : 'Buy'} ${l.token.symbol}`
    if (approve) void autoShareToOwnerChannels(ownerId, { market: 'ctm', id })
  }

  await recordAuditLog(adminId, approve ? 'AD_REVIEW_APPROVED' : 'AD_REVIEW_REJECTED', kind === 'usdt' ? 'Ad' : 'CtmListing', id, { note: note ?? null })
  notify(
    ownerId,
    'ad_review',
    approve ? 'Your listing is live' : 'Your listing was not approved',
    approve ? `Your ${label} listing was approved and is now live.` : `Your ${label} listing was not approved. Reason: ${reviewNote}`,
    { kind, id, approved: approve },
    undefined,
    kind === 'usdt' ? '/my-ads' : '/ctm/my-listings',
  )
}

// ─── Review rules (admin) ────────────────────────────────────────────────────

export interface MakerReviewSettings {
  /** Telegram handle or link applicants are told to contact (e.g. @RupChainSupport). */
  contactTelegram: string
  /** A maker's first N ads/listings wait for approval. 0 = never review by count. */
  reviewFirstN: number
  /** Also review any USDT ad whose max order exceeds this many USDT. 0 = off. */
  reviewAboveUsdt: number
}

export async function getMakerReviewSettings(): Promise<MakerReviewSettings> {
  const [reviewFirstN, reviewAboveUsdt] = await Promise.all([
    getNumberConfig('maker_review_first_n', 3),
    getNumberConfig('maker_review_above_usdt', 0),
  ])
  return { reviewFirstN, reviewAboveUsdt, contactTelegram: await getStringConfig(MAKER_CONTACT_KEY, '') }
}

export async function saveMakerReviewSettings(adminId: string, input: MakerReviewSettings): Promise<MakerReviewSettings> {
  const rows: Array<[string, number]> = [
    ['maker_review_first_n', Math.round(input.reviewFirstN)],
    ['maker_review_above_usdt', input.reviewAboveUsdt],
  ]
  await db.platformConfig.upsert({
    where: { key: MAKER_CONTACT_KEY },
    create: { key: MAKER_CONTACT_KEY, value: input.contactTelegram.trim() },
    update: { value: input.contactTelegram.trim() },
  })
  for (const [key, value] of rows) {
    await db.platformConfig.upsert({
      where: { key },
      create: { key, value: String(value) },
      update: { value: String(value) },
    })
  }
  await recordAuditLog(adminId, 'MAKER_REVIEW_SETTINGS_UPDATED', 'PlatformConfig', 'maker_review', { ...input })
  return getMakerReviewSettings()
}
