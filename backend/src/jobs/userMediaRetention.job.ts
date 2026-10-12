import { Prisma } from '@prisma/client'
import { db } from '../lib/prisma'
import { logger } from '../lib/logger'
import { deleteCloudinaryAsset } from '../lib/cloudinary'

// Monthly clean sweep of USER-uploaded media in Cloudinary, so the free plan
// never fills up. For every surface below the Cloudinary asset is destroyed FIRST
// and the database reference is cleared only if the delete did not hard-error —
// so the DB and Cloudinary can never drift apart, and a failed delete is simply
// retried on the next daily run.
//
// NEVER touched here (admin-uploaded / compliance, on purpose):
//   KYC documents, avatars, blog images, task / token / gas logos, and the
//   `giveaway-image` folder (shared with admin task logos and thumbnails).
//
// Covered here:
//   - DM photos + voice notes            (ChatThreadMessage)
//   - Support-chat attachments           (SupportMessage)
//   - Task proof screenshots             (PlatformTaskRevision, once reviewed)
//   - Appeal evidence                    (Appeal, once decided)
//   - Dispute evidence                   (DisputeMessage / CtmDisputeMessage, once resolved)
//   - Token-request evidence             (CtmTokenRequest, once decided)
// Payment proofs + trade-chat images are handled by mediaRetention.job.ts and
// channel media by channelRetention.job.ts (both unchanged in behaviour).
//
// ON by default; window (days) is `user_media_retention_days` in Platform Config.

const DEFAULT_RETENTION_DAYS = 30
const BATCH = 200 // bounded work per surface per run; a bigger backlog drains over successive days

async function getDays(): Promise<number> {
  const row = await db.platformConfig.upsert({
    where: { key: 'user_media_retention_days' },
    update: {},
    create: { key: 'user_media_retention_days', value: String(DEFAULT_RETENTION_DAYS) },
  })
  const n = Number.parseInt(row.value, 10)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS
}

const isVoice = (url: string) => url.includes('/video/upload/')

/** Destroy one asset; true when it is safe to clear the DB reference. */
async function purge(url: string | null | undefined): Promise<{ clear: boolean; deleted: boolean }> {
  if (!url) return { clear: true, deleted: false }
  const r = await deleteCloudinaryAsset(url)
  return { clear: r !== 'error', deleted: r === 'deleted' }
}

export async function runUserMediaRetention(): Promise<{ deleted: number; days: number }> {
  const days = await getDays()
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  let deleted = 0
  let scanned = 0

  // Phase 1 — reads only, so purging one surface can't change another's eligibility set.
  const [dmMsgs, supportMsgs, taskRevs, appeals, disputeMsgs, ctmDisputeMsgs, tokenReqs] = await Promise.all([
    db.chatThreadMessage.findMany({
      where: { createdAt: { lt: cutoff }, attachmentUrl: { not: null } },
      select: { id: true, body: true, attachmentUrl: true },
      take: BATCH,
    }),
    db.supportMessage.findMany({
      where: { createdAt: { lt: cutoff }, attachmentUrl: { not: null } },
      select: { id: true, body: true, attachmentUrl: true },
      take: BATCH,
    }),
    db.platformTaskRevision.findMany({
      where: { submittedAt: { lt: cutoff }, decision: { not: null }, attachments: { not: Prisma.DbNull } },
      select: { id: true, attachments: true },
      take: BATCH,
    }),
    db.appeal.findMany({
      where: { createdAt: { lt: cutoff }, status: { in: ['approved', 'rejected'] }, NOT: { evidenceUrls: { isEmpty: true } } },
      select: { id: true, evidenceUrls: true },
      take: BATCH,
    }),
    db.disputeMessage.findMany({
      where: { evidenceUrl: { not: null }, dispute: { status: 'resolved', resolvedAt: { lt: cutoff } } },
      select: { id: true, evidenceUrl: true },
      take: BATCH,
    }),
    db.ctmDisputeMessage.findMany({
      where: { evidenceUrl: { not: null }, dispute: { status: 'resolved', resolvedAt: { lt: cutoff } } },
      select: { id: true, evidenceUrl: true },
      take: BATCH,
    }),
    db.ctmTokenRequest.findMany({
      where: { createdAt: { lt: cutoff }, status: { not: 'pending' }, evidenceUrl: { not: null } },
      select: { id: true, evidenceUrl: true },
      take: BATCH,
    }),
  ])

  // Phase 2 — purge.
  for (const m of dmMsgs) {
    scanned++
    const url = m.attachmentUrl!
    const r = await purge(url)
    if (!r.clear) continue
    await db.chatThreadMessage.update({
      where: { id: m.id },
      data: { attachmentUrl: null, ...(m.body.trim() ? {} : { body: isVoice(url) ? '🎤 Voice message expired' : '📷 Photo expired' }) },
    })
    if (r.deleted) deleted++
  }

  for (const m of supportMsgs) {
    scanned++
    const r = await purge(m.attachmentUrl)
    if (!r.clear) continue
    await db.supportMessage.update({
      where: { id: m.id },
      data: { attachmentUrl: null, ...(m.body.trim() ? {} : { body: 'Attachment expired' }) },
    })
    if (r.deleted) deleted++
  }

  for (const rev of taskRevs) {
    scanned++
    const files = Array.isArray(rev.attachments) ? (rev.attachments as unknown as Array<{ url?: string }>) : []
    let ok = true
    for (const f of files) {
      const r = await purge(f?.url)
      if (!r.clear) ok = false
      else if (r.deleted) deleted++
    }
    // Any failed delete keeps the whole list so the next run retries it.
    if (ok) await db.platformTaskRevision.update({ where: { id: rev.id }, data: { attachments: Prisma.DbNull } })
  }

  for (const a of appeals) {
    scanned++
    let ok = true
    for (const url of a.evidenceUrls) {
      const r = await purge(url)
      if (!r.clear) ok = false
      else if (r.deleted) deleted++
    }
    if (ok) await db.appeal.update({ where: { id: a.id }, data: { evidenceUrls: [] } })
  }

  for (const m of disputeMsgs) {
    scanned++
    const r = await purge(m.evidenceUrl)
    if (!r.clear) continue
    await db.disputeMessage.update({ where: { id: m.id }, data: { evidenceUrl: null } })
    if (r.deleted) deleted++
  }

  for (const m of ctmDisputeMsgs) {
    scanned++
    const r = await purge(m.evidenceUrl)
    if (!r.clear) continue
    await db.ctmDisputeMessage.update({ where: { id: m.id }, data: { evidenceUrl: null } })
    if (r.deleted) deleted++
  }

  for (const t of tokenReqs) {
    scanned++
    const r = await purge(t.evidenceUrl)
    if (!r.clear) continue
    await db.ctmTokenRequest.update({ where: { id: t.id }, data: { evidenceUrl: null } })
    if (r.deleted) deleted++
  }

  if (scanned > 0) logger.info({ deleted, scanned, retentionDays: days }, 'User-media retention sweep: purged old user uploads')
  return { deleted, days }
}
