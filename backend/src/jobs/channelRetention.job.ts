import { db } from '../lib/prisma'
import { logger } from '../lib/logger'
import { deleteCloudinaryAsset } from '../lib/cloudinary'

// Channel broadcasts are a rolling public feed, not dispute/compliance evidence
// (unlike trade chat — see mediaRetention.job.ts), so their history resets on a
// CALENDAR boundary rather than a rolling day-count: everything from BEFORE the
// start of the current month (UTC) is purged — row + any attached image — so
// each channel's history vanishes at the start of every month while the
// current month's ongoing conversation is left alone. ON by default (unlike
// the money-media job, which stays OFF until an admin opts in) since there's
// no dispute-evidence risk here.

const BATCH = 500 // bounded work per daily run; drains over successive days if
                   // a month's backlog is bigger than one batch

async function getConfig(): Promise<{ enabled: boolean }> {
  const enabledRow = await db.platformConfig.upsert({
    where: { key: 'channels_message_retention_enabled' },
    update: {},
    create: { key: 'channels_message_retention_enabled', value: 'true' },
  })
  return { enabled: enabledRow.value.trim().toLowerCase() === 'true' }
}

/** Midnight UTC on the 1st of the current calendar month. */
function startOfCurrentMonthUtc(): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}

export async function runChannelRetention(
  opts: { force?: boolean } = {},
): Promise<{ deleted: number; cutoff: string } | null> {
  const { enabled } = await getConfig()
  if (!enabled && !opts.force) return null

  const cutoff = startOfCurrentMonthUtc()

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
    const ok = await db.channelMessage.delete({ where: { id: m.id } }).then(() => true).catch(() => false)
    if (ok) deleted++
  }

  if (deleted > 0) {
    logger.info({ deleted, cutoff: cutoff.toISOString() }, "Channel-retention sweep: purged prior months' broadcasts")
  }

  await db.platformConfig.upsert({
    where: { key: 'channels_message_retention_last_run' },
    update: { value: JSON.stringify({ at: new Date().toISOString(), deleted, cutoff: cutoff.toISOString(), forced: !!opts.force }) },
    create: { key: 'channels_message_retention_last_run', value: JSON.stringify({ at: new Date().toISOString(), deleted, cutoff: cutoff.toISOString(), forced: !!opts.force }) },
  }).catch(() => {})

  return { deleted, cutoff: cutoff.toISOString() }
}
