import { db } from '../lib/prisma'
import { logger } from '../lib/logger'
import { deleteCloudinaryAsset } from '../lib/cloudinary'

// Channel broadcasts are a rolling public feed, not dispute/compliance evidence
// (unlike trade chat — see mediaRetention.job.ts) — so once a broadcast is old
// enough, the whole message (row + any attached image) is purged outright to
// keep Cloudinary storage bounded as channels accumulate history. ON by default
// (unlike the money-media job, which stays OFF until an admin opts in) since
// there's no dispute-evidence risk here.

const DEFAULT_RETENTION_DAYS = 20
const BATCH = 500 // bounded work per daily run; drains over successive runs

async function getConfig(): Promise<{ enabled: boolean; days: number }> {
  const [enabledRow, daysRow] = await Promise.all([
    db.platformConfig.upsert({
      where: { key: 'channels_message_retention_enabled' },
      update: {},
      create: { key: 'channels_message_retention_enabled', value: 'true' },
    }),
    db.platformConfig.upsert({
      where: { key: 'channels_message_retention_days' },
      update: {},
      create: { key: 'channels_message_retention_days', value: String(DEFAULT_RETENTION_DAYS) },
    }),
  ])
  const days = Number.parseInt(daysRow.value, 10)
  return {
    enabled: enabledRow.value.trim().toLowerCase() === 'true',
    days: Number.isFinite(days) && days > 0 ? days : DEFAULT_RETENTION_DAYS,
  }
}

export async function runChannelRetention(
  opts: { force?: boolean } = {},
): Promise<{ deleted: number; days: number } | null> {
  const { enabled, days } = await getConfig()
  if (!enabled && !opts.force) return null

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  const old = await db.channelMessage.findMany({
    where: { createdAt: { lt: cutoff } },
    select: { id: true, attachmentUrl: true },
    take: BATCH,
  })

  let deleted = 0
  for (const m of old) {
    // Best-effort: an orphaned Cloudinary asset is a minor cost leak, not worth
    // blocking the row purge over — never retry-hold a message just because its
    // image failed to delete.
    if (m.attachmentUrl) await deleteCloudinaryAsset(m.attachmentUrl).catch(() => {})
    await db.channelMessage.delete({ where: { id: m.id } }).catch(() => {})
    deleted++
  }

  if (deleted > 0) {
    logger.info({ deleted, retentionDays: days }, 'Channel-retention sweep: purged old broadcasts')
  }

  await db.platformConfig.upsert({
    where: { key: 'channels_message_retention_last_run' },
    update: { value: JSON.stringify({ at: new Date().toISOString(), deleted, days, forced: !!opts.force }) },
    create: { key: 'channels_message_retention_last_run', value: JSON.stringify({ at: new Date().toISOString(), deleted, days, forced: !!opts.force }) },
  }).catch(() => {})

  return { deleted, days }
}
