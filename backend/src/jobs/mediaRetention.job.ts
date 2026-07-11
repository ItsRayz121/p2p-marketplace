import { db } from '../lib/prisma'
import { logger } from '../lib/logger'
import { deleteCloudinaryAsset } from '../lib/cloudinary'

// Trade media (payment proofs + trade-chat images) is only useful while a trade
// is live or could still be disputed. Once a trade has been SETTLED for long
// enough, its images are dead weight in Cloudinary storage. This job purges them
// on a rolling basis. KYC is never touched (compliance) and support-chat media is
// out of scope — only trade-scoped media is purged.
//
// SAFETY: only terminal trades are eligible, and NEVER `disputed` (an open
// dispute). We anchor on `updatedAt`, which stops changing once a trade is
// terminal, so it is a faithful "settled at" timestamp. The whole job is gated
// OFF by default (`media_retention_enabled`) so nothing is deleted until an admin
// consciously enables it.

const TERMINAL_USDT = ['crypto_released', 'cancelled', 'dispute_resolved'] as const
const TERMINAL_CTM = ['completed', 'cancelled', 'dispute_resolved', 'expired'] as const

const DEFAULT_RETENTION_DAYS = 30
const BATCH = 400 // bounded work per daily run; drains over successive runs

// Read (and surface, so it shows in Admin → Config) the retention settings.
async function getConfig(): Promise<{ enabled: boolean; days: number }> {
  const [enabledRow, daysRow] = await Promise.all([
    db.platformConfig.upsert({
      where: { key: 'media_retention_enabled' },
      update: {},
      create: { key: 'media_retention_enabled', value: 'false' },
    }),
    db.platformConfig.upsert({
      where: { key: 'media_retention_days' },
      update: {},
      create: { key: 'media_retention_days', value: String(DEFAULT_RETENTION_DAYS) },
    }),
  ])
  const days = Number.parseInt(daysRow.value, 10)
  return {
    enabled: enabledRow.value.trim().toLowerCase() === 'true',
    days: Number.isFinite(days) && days > 0 ? days : DEFAULT_RETENTION_DAYS,
  }
}

// Delete an asset then null the field only if the delete didn't hard-error, so a
// transient Cloudinary failure is retried on the next run (URL stays put).
async function purgeAndClear(url: string | null, clear: () => Promise<unknown>): Promise<boolean> {
  if (!url) return false
  const result = await deleteCloudinaryAsset(url)
  if (result === 'error') return false // leave URL in place → retried next run
  await clear()
  return result === 'deleted'
}

export async function runMediaRetention(): Promise<{ deleted: number; scanned: number } | null> {
  const { enabled, days } = await getConfig()
  if (!enabled) return null

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  let deleted = 0
  let scanned = 0

  // ── USDT trade payment / delivery proofs ─────────────────────────────────
  const usdtTrades = await db.trade.findMany({
    where: {
      status: { in: [...TERMINAL_USDT] },
      updatedAt: { lt: cutoff },
      OR: [{ paymentProofUrl: { not: null } }, { sellerDeliveryProofUrl: { not: null } }],
    },
    select: { id: true, paymentProofUrl: true, sellerDeliveryProofUrl: true },
    take: BATCH,
  })
  for (const t of usdtTrades) {
    scanned++
    if (await purgeAndClear(t.paymentProofUrl, () => db.trade.update({ where: { id: t.id }, data: { paymentProofUrl: null } }))) deleted++
    if (await purgeAndClear(t.sellerDeliveryProofUrl, () => db.trade.update({ where: { id: t.id }, data: { sellerDeliveryProofUrl: null } }))) deleted++
  }

  // ── USDT trade-chat images ───────────────────────────────────────────────
  const usdtMsgs = await db.tradeMessage.findMany({
    where: {
      attachmentUrl: { not: null },
      trade: { status: { in: [...TERMINAL_USDT] }, updatedAt: { lt: cutoff } },
    },
    select: { id: true, attachmentUrl: true },
    take: BATCH,
  })
  for (const m of usdtMsgs) {
    scanned++
    if (await purgeAndClear(m.attachmentUrl, () => db.tradeMessage.update({ where: { id: m.id }, data: { attachmentUrl: null } }))) deleted++
  }

  // ── CTM trade payment proofs ─────────────────────────────────────────────
  const ctmTrades = await db.ctmTrade.findMany({
    where: { status: { in: [...TERMINAL_CTM] }, updatedAt: { lt: cutoff }, paymentProofUrl: { not: null } },
    select: { id: true, paymentProofUrl: true },
    take: BATCH,
  })
  for (const t of ctmTrades) {
    scanned++
    if (await purgeAndClear(t.paymentProofUrl, () => db.ctmTrade.update({ where: { id: t.id }, data: { paymentProofUrl: null } }))) deleted++
  }

  // ── CTM structured proofs (CtmTradeProof.fileUrl) ────────────────────────
  const ctmProofs = await db.ctmTradeProof.findMany({
    where: {
      fileUrl: { not: null },
      trade: { status: { in: [...TERMINAL_CTM] }, updatedAt: { lt: cutoff } },
    },
    select: { id: true, fileUrl: true },
    take: BATCH,
  })
  for (const p of ctmProofs) {
    scanned++
    if (await purgeAndClear(p.fileUrl, () => db.ctmTradeProof.update({ where: { id: p.id }, data: { fileUrl: null } }))) deleted++
  }

  // ── CTM trade-chat images ────────────────────────────────────────────────
  const ctmMsgs = await db.ctmTradeMessage.findMany({
    where: {
      attachmentUrl: { not: null },
      trade: { status: { in: [...TERMINAL_CTM] }, updatedAt: { lt: cutoff } },
    },
    select: { id: true, attachmentUrl: true },
    take: BATCH,
  })
  for (const m of ctmMsgs) {
    scanned++
    if (await purgeAndClear(m.attachmentUrl, () => db.ctmTradeMessage.update({ where: { id: m.id }, data: { attachmentUrl: null } }))) deleted++
  }

  if (scanned > 0) {
    logger.info({ deleted, scanned, retentionDays: days }, 'Media-retention sweep: purged old trade media')
  }
  return { deleted, scanned }
}
