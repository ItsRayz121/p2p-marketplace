import { db } from '../lib/prisma'
import { logger } from '../lib/logger'
import { deleteCloudinaryAsset } from '../lib/cloudinary'

// DM voice notes are small (≈100–250 KB each) but unbounded in number, and a
// voice clip has no dispute value once the conversation has moved on. This
// daily sweep deletes the Cloudinary audio for DM voice notes older than the
// retention window and leaves a short placeholder in the bubble so the thread
// doesn't show a blank message. Channel voice notes need no job of their own —
// channelRetention.job.ts already deletes every attachment at month rollover.
//
// Voice notes are recognised by their Cloudinary resource type: images live
// under /image/upload/, audio under /video/upload/.

const DEFAULT_RETENTION_DAYS = 30
const BATCH = 300

async function getDays(): Promise<number> {
  const row = await db.platformConfig.upsert({
    where: { key: 'voice_note_retention_days' },
    update: {},
    create: { key: 'voice_note_retention_days', value: String(DEFAULT_RETENTION_DAYS) },
  })
  const n = Number.parseInt(row.value, 10)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS
}

export async function runVoiceRetention(): Promise<{ deleted: number; days: number }> {
  const days = await getDays()
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  const old = await db.chatThreadMessage.findMany({
    where: { createdAt: { lt: cutoff }, attachmentUrl: { contains: '/video/upload/' } },
    select: { id: true, body: true, attachmentUrl: true },
    take: BATCH,
  })

  let deleted = 0
  for (const m of old) {
    const result = await deleteCloudinaryAsset(m.attachmentUrl)
    if (result === 'error') continue // keep the URL so the next run retries
    await db.chatThreadMessage.update({
      where: { id: m.id },
      data: { attachmentUrl: null, ...(m.body.trim() ? {} : { body: '🎤 Voice message expired' }) },
    })
    if (result === 'deleted') deleted++
  }

  if (old.length > 0) logger.info({ deleted, scanned: old.length, retentionDays: days }, 'Voice-retention sweep: purged old DM voice notes')
  return { deleted, days }
}
