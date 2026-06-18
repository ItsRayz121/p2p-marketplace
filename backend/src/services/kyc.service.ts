// KYC verification provider decision (2026-06):
// There is no genuinely free + practical third-party KYC/identity provider for
// Pakistani CNIC verification (Onfido, Sumsub, Persona, etc. are all paid; NADRA
// Verisys is gated/commercial). We therefore keep manual admin review — Level 1
// (CNIC front/back + simple selfie) and Level 2 (social links + verification
// video) are reviewed in the admin KYC queue. Revisit if a free provider appears.
import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { AppError } from '../lib/errors'
import { hashCnic } from '../lib/hash'
import { sendKycEmail } from './email.service'
import { assertCloudinaryUrl } from '../lib/upload'
import { FLAGS, isFlagEnabled } from './platformFlags.service'

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
    cnicNumber?: string
    legalName?: string
    frontUrl?: string
    backUrl?: string
    selfieUrl?: string
    videoUrl?: string
    socialLinks?: Array<{ platform: string; url: string }>
  },
) {
  const nonCustodial = await isFlagEnabled(FLAGS.NONCUSTODIAL_P2P)
  const legalName = data.legalName?.trim()
  // Enhanced (Level 2) reuses the already-approved Level 1 identity documents so
  // users don't re-upload their CNIC/selfie. Pull them from the prior approved
  // submission rather than asking again.
  let { frontUrl, backUrl, selfieUrl } = data
  let cnicHash: string

  if (data.tier === 'enhanced') {
    const approvedBasic = await db.kycSubmission.findFirst({
      where: { userId, status: 'approved' },
      orderBy: { createdAt: 'desc' },
    })
    if (!approvedBasic) {
      throw new AppError('KYC_LEVEL1_REQUIRED', 'Complete Level 1 verification before upgrading to Level 2', 400)
    }
    // Reuse approved Level 1 documents and CNIC hash.
    frontUrl = approvedBasic.frontUrl
    backUrl = approvedBasic.backUrl
    selfieUrl = approvedBasic.selfieUrl
    cnicHash = approvedBasic.cnicNumberHash
  } else {
    if (!data.cnicNumber || !frontUrl || !backUrl || !selfieUrl) {
      throw new AppError('VALIDATION_ERROR', 'Basic KYC requires your CNIC number and front, back, and selfie photos', 400)
    }
    // Non-custodial trust depends on the CNIC name being the canonical identity,
    // so require it at submission once the mode is enabled.
    if (nonCustodial && !legalName) {
      throw new AppError('VALIDATION_ERROR', 'Enter your full name exactly as printed on your CNIC', 400)
    }
    // Require at least one social profile (Facebook/Instagram preferred) even at
    // Level 1 — it is the real-time traceability anchor for non-custodial trust.
    if (nonCustodial && (data.socialLinks?.filter((l) => l.url.trim()).length ?? 0) < 1) {
      throw new AppError('VALIDATION_ERROR', 'Add at least one social profile (Facebook or Instagram preferred)', 400)
    }
    cnicHash = hashCnic(data.cnicNumber)
  }

  assertCloudinaryUrl(frontUrl, 'frontUrl')
  assertCloudinaryUrl(backUrl, 'backUrl')
  assertCloudinaryUrl(selfieUrl, 'selfieUrl')
  if (data.videoUrl) assertCloudinaryUrl(data.videoUrl, 'videoUrl')

  // Rate limit: max 3 submissions per 24h
  const rateLimitKey = `kyc_submit:${userId}`
  const count = await redis.incr(rateLimitKey)
  if (count === 1) await redis.expire(rateLimitKey, 86400)
  if (count > 3) {
    throw new AppError('RATE_LIMIT', 'Too many KYC submissions. Try again tomorrow.', 429)
  }

  // Prevent CNIC reuse across approved users (basic only — enhanced reuses the
  // user's own already-validated CNIC hash).
  if (data.tier === 'basic') {
    const existingApproved = await db.kycSubmission.findFirst({
      where: { cnicNumberHash: cnicHash, status: 'approved', userId: { not: userId } },
    })
    if (existingApproved) {
      throw new AppError('CNIC_DUPLICATE', 'This CNIC is already registered with another account', 400)
    }
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
      frontUrl,
      backUrl,
      selfieUrl,
      videoUrl: data.videoUrl ?? null,
      cnicNumberHash: cnicHash,
      legalName: legalName ?? null,
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
