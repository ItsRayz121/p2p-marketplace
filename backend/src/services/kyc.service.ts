import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { AppError } from '../lib/errors'
import { hashCnic } from '../lib/hash'
import { sendKycEmail } from './email.service'
import { assertCloudinaryUrl } from '../lib/upload'

export async function getKycStatus(userId: string) {
  const [user, submission] = await Promise.all([
    db.user.findUnique({
      where: { id: userId },
      select: { kycStatus: true, kycLevel: true },
    }),
    db.kycSubmission.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    }),
  ])
  return { status: user?.kycStatus, level: user?.kycLevel, latestSubmission: submission }
}

export async function submitKyc(
  userId: string,
  data: {
    tier: 'basic' | 'enhanced'
    cnicNumber: string
    frontUrl: string
    backUrl: string
    selfieUrl: string
    socialLinks?: Array<{ platform: string; url: string }>
  },
) {
  assertCloudinaryUrl(data.frontUrl, 'frontUrl')
  assertCloudinaryUrl(data.backUrl, 'backUrl')
  assertCloudinaryUrl(data.selfieUrl, 'selfieUrl')

  // Rate limit: max 3 submissions per 24h
  const rateLimitKey = `kyc_submit:${userId}`
  const count = await redis.incr(rateLimitKey)
  if (count === 1) await redis.expire(rateLimitKey, 86400)
  if (count > 3) {
    throw new AppError('RATE_LIMIT', 'Too many KYC submissions. Try again tomorrow.', 429)
  }

  // Hash CNIC — never store plaintext
  const cnicHash = hashCnic(data.cnicNumber)

  // Prevent CNIC reuse across approved users
  const existingApproved = await db.kycSubmission.findFirst({
    where: { cnicNumberHash: cnicHash, status: 'approved', userId: { not: userId } },
  })
  if (existingApproved) {
    throw new AppError('CNIC_DUPLICATE', 'This CNIC is already registered with another account', 400)
  }

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { email: true },
  })

  const submission = await db.kycSubmission.create({
    data: {
      userId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tier: data.tier as any,
      status: 'pending',
      frontUrl: data.frontUrl,
      backUrl: data.backUrl,
      selfieUrl: data.selfieUrl,
      cnicNumberHash: cnicHash,
      socialLinks: data.socialLinks ?? [],
    },
  })

  // Update user kycStatus to pending
  await db.user.update({
    where: { id: userId },
    data: { kycStatus: 'pending' },
  })

  if (user?.email) {
    await sendKycEmail('submitted', user.email).catch(() => {
      // Non-blocking: log failure silently
    })
  }

  return submission
}

export async function getUserSubmissions(userId: string) {
  return db.kycSubmission.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      tier: true,
      status: true,
      rejectionReason: true,
      createdAt: true,
      reviewedAt: true,
    },
  })
}
