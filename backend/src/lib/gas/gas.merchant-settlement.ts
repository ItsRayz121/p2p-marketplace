/**
 * Merchant settlement — aggregates gas orders per merchant API key into
 * periodic settlement records and optionally auto-pays via treasury.
 */

import { db } from '../prisma'
import { logger } from '../logger'

// ── Settlement computation ────────────────────────────────────────────────────

export async function computeSettlement(
  merchantId: string,
  periodStart: Date,
  periodEnd: Date,
) {
  const merchant = await db.gasMerchantAccount.findUnique({
    where: { id: merchantId },
    select: { commissionRate: true, apiKeyId: true },
  })
  if (!merchant) throw new Error(`Merchant ${merchantId} not found`)

  const orders = await db.gasFeeOrder.findMany({
    where: {
      merchantApiKeyId: merchant.apiKeyId,
      status: 'delivered',
      deliveredAt: { gte: periodStart, lte: periodEnd },
    },
    select: { paymentAmount: true },
  })

  const grossRevenueUsd  = orders.reduce((s, o) => s + Number(o.paymentAmount), 0)
  const commissionRate   = Number(merchant.commissionRate)
  const merchantShareUsd = grossRevenueUsd * commissionRate
  const platformFeeUsd   = grossRevenueUsd - merchantShareUsd

  return {
    orderCount: orders.length,
    grossRevenueUsd,
    platformFeeUsd,
    merchantShareUsd,
  }
}

export async function createSettlementRecord(merchantId: string, periodStart: Date, periodEnd: Date) {
  const computed = await computeSettlement(merchantId, periodStart, periodEnd)

  if (computed.orderCount === 0) return null // nothing to settle

  return db.gasMerchantSettlement.create({
    data: {
      merchantId,
      periodStart,
      periodEnd,
      orderCount:       computed.orderCount,
      grossRevenueUsd:  computed.grossRevenueUsd,
      platformFeeUsd:   computed.platformFeeUsd,
      merchantShareUsd: computed.merchantShareUsd,
      status: 'pending',
    },
  })
}

// ── Approval & payout ─────────────────────────────────────────────────────────

export async function approveSettlement(id: string, adminId: string, adminNote?: string) {
  const settlement = await db.gasMerchantSettlement.findUnique({ where: { id } })
  if (!settlement) throw new Error('Settlement not found')
  if (settlement.status !== 'pending') throw new Error('Settlement is not pending')

  const updated = await db.gasMerchantSettlement.update({
    where: { id },
    data: { status: 'approved', adminNote: adminNote ?? null },
  })

  logger.info({ settlementId: id, adminId, merchantShareUsd: settlement.merchantShareUsd }, 'Merchant settlement approved')
  return updated
}

// ── Admin CRUD helpers ────────────────────────────────────────────────────────

export async function listMerchantAccounts(page = 1, limit = 20) {
  const skip = (page - 1) * limit
  const [accounts, total] = await Promise.all([
    db.gasMerchantAccount.findMany({
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: { _count: { select: { settlements: true } } },
    }),
    db.gasMerchantAccount.count(),
  ])
  return { merchants: accounts, total, page, limit }
}

export async function getMerchantAccount(id: string) {
  return db.gasMerchantAccount.findUnique({
    where: { id },
    include: { settlements: { orderBy: { createdAt: 'desc' }, take: 20 } },
  })
}

export async function createMerchantAccount(data: {
  name: string
  apiKeyId: string
  commissionRate?: number
  settlementCycle?: string
  payoutAddress?: string
}) {
  return db.gasMerchantAccount.create({
    data: {
      name:            data.name,
      apiKeyId:        data.apiKeyId,
      commissionRate:  data.commissionRate ?? 0,
      settlementCycle: data.settlementCycle ?? 'weekly',
      payoutAddress:   data.payoutAddress ?? null,
    },
  })
}

export async function updateMerchantAccount(
  id: string,
  data: Partial<{ name: string; commissionRate: number; settlementCycle: string; payoutAddress: string | null; isActive: boolean }>,
) {
  return db.gasMerchantAccount.update({ where: { id }, data })
}

export async function listMerchantSettlements(merchantId: string, page = 1, limit = 20) {
  const skip = (page - 1) * limit
  const [settlements, total] = await Promise.all([
    db.gasMerchantSettlement.findMany({
      where: { merchantId },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    db.gasMerchantSettlement.count({ where: { merchantId } }),
  ])
  return { settlements, total, page, limit }
}

// ── Periodic settlement processor (called by BullMQ job) ─────────────────────

export async function processSettlementCycles() {
  const merchants = await db.gasMerchantAccount.findMany({ where: { isActive: true } })
  const now = new Date()
  let created = 0

  for (const merchant of merchants) {
    try {
      const periodEnd = new Date(now)
      let periodStart: Date

      if (merchant.settlementCycle === 'daily') {
        periodStart = new Date(now)
        periodStart.setDate(periodStart.getDate() - 1)
      } else if (merchant.settlementCycle === 'monthly') {
        periodStart = new Date(now)
        periodStart.setMonth(periodStart.getMonth() - 1)
      } else {
        // weekly (default)
        periodStart = new Date(now)
        periodStart.setDate(periodStart.getDate() - 7)
      }

      // Skip if a settlement already exists for this period
      const existing = await db.gasMerchantSettlement.findFirst({
        where: { merchantId: merchant.id, periodEnd: { gte: periodStart } },
      })
      if (existing) continue

      const record = await createSettlementRecord(merchant.id, periodStart, periodEnd)
      if (record) created++
    } catch (err) {
      logger.error({ err, merchantId: merchant.id }, 'Failed to process settlement for merchant')
    }
  }

  logger.info({ created }, 'Merchant settlement cycle complete')
  return created
}
