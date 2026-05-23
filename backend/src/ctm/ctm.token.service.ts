import { db } from '../lib/prisma'
import { AppError } from '../lib/errors'
import type { CtmTokenStatus, CtmTokenRiskTier, CtmSettlementType } from '@prisma/client'

export interface ListTokensFilters {
  search?: string
  settlementType?: CtmSettlementType
  riskTier?: CtmTokenRiskTier
  status?: CtmTokenStatus
  page?: number
  limit?: number
  adminView?: boolean
}

export async function listApprovedTokens(filters: ListTokensFilters = {}) {
  const { search, settlementType, riskTier, status, page = 1, limit = 20, adminView = false } = filters
  const skip = (page - 1) * limit

  const where: Record<string, unknown> = adminView ? {} : { status: 'approved', isListingEnabled: true }
  if (search) where.OR = [
    { name: { contains: search, mode: 'insensitive' } },
    { symbol: { contains: search, mode: 'insensitive' } },
  ]
  if (settlementType) where.settlementType = settlementType
  if (riskTier) where.riskTier = riskTier
  if (status && adminView) where.status = status

  const [tokens, total] = await Promise.all([
    db.ctmToken.findMany({
      where,
      skip,
      take: limit,
      orderBy: [{ totalVolumePkr: 'desc' }, { createdAt: 'desc' }],
    }),
    db.ctmToken.count({ where }),
  ])

  return { tokens, total, page, limit, totalPages: Math.ceil(total / limit) }
}

export async function getTokenBySlug(slug: string) {
  const token = await db.ctmToken.findUnique({
    where: { slug },
    include: {
      _count: {
        select: {
          listings: { where: { status: 'active' } },
          requests: { where: { status: 'open' } },
        },
      },
    },
  })
  if (!token) throw new AppError('NOT_FOUND', 'Token not found', 404)
  return token
}

export async function adminCreateToken(adminId: string, data: {
  slug: string
  symbol: string
  name: string
  description: string
  logoUrl?: string
  bannerUrl?: string
  settlementType: CtmSettlementType
  network?: string
  contractAddress?: string
  explorerUrl?: string
  officialWebsite?: string
  officialTwitter?: string
  officialTelegram?: string
  whitePaperUrl?: string
  riskTier?: CtmTokenRiskTier
  riskNotes?: string
  riskLabels?: string[]
  maxListingAmount?: number
  minTradeAmountPkr?: number
}) {
  const existing = await db.ctmToken.findUnique({ where: { slug: data.slug } })
  if (existing) throw new AppError('CONFLICT', 'Token with this slug already exists', 409)

  return db.ctmToken.create({
    data: {
      ...data,
      status: 'approved',
      addedByAdminId: adminId,
    },
  })
}

export async function adminUpdateToken(adminId: string, tokenId: string, data: {
  status?: CtmTokenStatus
  riskTier?: CtmTokenRiskTier
  riskNotes?: string
  riskLabels?: string[]
  isListingEnabled?: boolean
  logoUrl?: string
  maxListingAmount?: number
  minTradeAmountPkr?: number
  description?: string
}) {
  const token = await db.ctmToken.findUnique({ where: { id: tokenId } })
  if (!token) throw new AppError('NOT_FOUND', 'Token not found', 404)

  return db.ctmToken.update({
    where: { id: tokenId },
    data: {
      ...data,
      ...(data.status === 'approved' ? { verifiedByAdminId: adminId, verifiedAt: new Date() } : {}),
    },
  })
}

export async function adminDelistToken(adminId: string, tokenId: string) {
  const token = await db.ctmToken.findUnique({ where: { id: tokenId } })
  if (!token) throw new AppError('NOT_FOUND', 'Token not found', 404)

  await db.$transaction([
    db.ctmToken.update({ where: { id: tokenId }, data: { status: 'delisted', isListingEnabled: false } }),
    db.ctmListing.updateMany({ where: { tokenId, status: 'active' }, data: { status: 'paused' } }),
  ])

  await db.auditLog.create({
    data: { actorId: adminId, action: 'CTM_TOKEN_DELISTED', metadata: { tokenId, tokenName: token.name } },
  }).catch(() => {})
}

export async function submitTokenRequest(userId: string, data: {
  tokenName: string
  tokenSymbol: string
  description: string
  officialWebsite?: string
  evidenceUrl?: string
}) {
  return db.ctmTokenRequest.create({ data: { userId, ...data } })
}

export async function listTokenRequests(filters: { status?: string; page?: number; limit?: number } = {}) {
  const { status, page = 1, limit = 20 } = filters
  const where = status ? { status } : {}
  const skip = (page - 1) * limit
  const [requests, total] = await Promise.all([
    db.ctmTokenRequest.findMany({
      where,
      skip,
      take: limit,
      include: { user: { select: { id: true, username: true, email: true } } },
      orderBy: { createdAt: 'desc' },
    }),
    db.ctmTokenRequest.count({ where }),
  ])
  return { requests, total, page, limit }
}

export async function approveTokenRequest(adminId: string, requestId: string, tokenData: Parameters<typeof adminCreateToken>[1]) {
  const request = await db.ctmTokenRequest.findUnique({ where: { id: requestId } })
  if (!request) throw new AppError('NOT_FOUND', 'Token request not found', 404)
  if (request.status !== 'pending') throw new AppError('CONFLICT', 'Request is not pending', 409)

  const token = await adminCreateToken(adminId, tokenData)

  await db.ctmTokenRequest.update({
    where: { id: requestId },
    data: { status: 'approved', reviewedBy: adminId, reviewedAt: new Date(), tokenId: token.id },
  })

  return token
}

export async function rejectTokenRequest(adminId: string, requestId: string, adminNote: string) {
  const request = await db.ctmTokenRequest.findUnique({ where: { id: requestId } })
  if (!request) throw new AppError('NOT_FOUND', 'Token request not found', 404)
  if (request.status !== 'pending') throw new AppError('CONFLICT', 'Request is not pending', 409)

  return db.ctmTokenRequest.update({
    where: { id: requestId },
    data: { status: 'rejected', reviewedBy: adminId, reviewedAt: new Date(), adminNote },
  })
}
