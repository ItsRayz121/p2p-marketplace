/**
 * Risk / fraud scoring for gas fee orders.
 *
 * Signals:
 *   HIGH_DEST_FREQUENCY   — same toAddress in >5 orders across different IPs in 1 hour
 *   GUEST_LIMIT_CYCLING   — guest IP hitting exactly $10/day limit multiple times
 *   KNOWN_EXCHANGE_WALLET — toAddress matches a known exchange hot wallet
 *   SUSPICIOUS_VELOCITY   — >3 orders to the same dest from the same IP in 1 hour
 *
 * flagIfRisky() is fire-and-forget (called after order creation, doesn't block response).
 */

import { db } from '../prisma'
import { redis } from '../redis'
import { logger } from '../logger'
import type { GasFeeOrder } from '@prisma/client'

// ── Known exchange deposit address prefixes (first 10 chars) ──────────────────
// These are publicly known Binance/OKX/Bybit TRON/EVM deposit router prefixes.
// Extend this list as more are identified.
const KNOWN_EXCHANGE_PREFIXES = new Set([
  'TKzxdSv', // Binance TRON deposit cluster
  'TVj7RNo', // Binance TRON 2
  '0x3f5ce5', // Binance EVM hot wallet
  '0xbe0eb5', // Binance EVM cold wallet prefix
  '0x6cc5f6', // OKX EVM
  '0x236aa5', // Bybit EVM
])

function matchesExchangeWallet(address: string): boolean {
  const prefix = address.slice(0, 10).toLowerCase()
  for (const known of KNOWN_EXCHANGE_PREFIXES) {
    if (prefix.startsWith(known.toLowerCase())) return true
  }
  return false
}

// ── Redis key helpers ─────────────────────────────────────────────────────────

function todayDate() {
  return new Date().toISOString().slice(0, 10)
}

function thisHour() {
  const d = new Date()
  return `${d.toISOString().slice(0, 13)}`
}

// ── Score calculator ──────────────────────────────────────────────────────────

export async function scoreOrder(
  order: Pick<GasFeeOrder, 'id' | 'toAddress' | 'ipAddress' | 'gasAmountUSD'>,
  ip: string,
): Promise<{ score: number; reasons: string[] }> {
  const reasons: string[] = []
  let score = 0

  // Signal 1: Known exchange hot wallet destination
  if (matchesExchangeWallet(order.toAddress)) {
    reasons.push('KNOWN_EXCHANGE_WALLET')
    score += 40
  }

  // Signal 2: High destination frequency (> 5 unique IPs → same address in 1h)
  const destIpKey = `gas_risk:dest_ips:${order.toAddress}:${thisHour()}`
  await redis.pfadd(destIpKey, ip) // HyperLogLog for cardinality
  await redis.expire(destIpKey, 3600)
  const uniqueIpCount = await redis.pfcount(destIpKey)
  if (uniqueIpCount > 5) {
    reasons.push('HIGH_DEST_FREQUENCY')
    score += 30
  }

  // Signal 3: Same IP → same destination more than 3 times in 1h
  const ipDestKey = `gas_risk:ip_dest:${ip}:${order.toAddress}:${thisHour()}`
  const ipDestCount = await redis.incr(ipDestKey)
  await redis.expire(ipDestKey, 3600)
  if (ipDestCount > 3) {
    reasons.push('SUSPICIOUS_VELOCITY')
    score += 25
  }

  // Signal 4: Guest cycling at exactly $10/day (spending limit) from multiple IPs
  const guestSpendKey = `guest_spend:${ip}:${todayDate()}`
  const guestSpend = parseFloat((await redis.get(guestSpendKey)) ?? '0')
  if (!order.ipAddress && guestSpend >= 9.5) {
    // Guest near daily cap — check if same destination hit from this IP before
    const prevHitKey = `gas_risk:guest_cap_dest:${order.toAddress}:${todayDate()}`
    const prevHit = await redis.incr(prevHitKey)
    await redis.expire(prevHitKey, 86400)
    if (prevHit > 2) {
      reasons.push('GUEST_LIMIT_CYCLING')
      score += 20
    }
  }

  return { score: Math.min(score, 100), reasons }
}

// ── Flag if risky ─────────────────────────────────────────────────────────────

export async function flagIfRisky(
  order: Pick<GasFeeOrder, 'id' | 'toAddress' | 'ipAddress' | 'gasAmountUSD'>,
  ip: string,
): Promise<void> {
  try {
    const { score, reasons } = await scoreOrder(order, ip)

    // Update riskScore on the order row
    await db.gasFeeOrder.update({
      where: { id: order.id },
      data: { riskScore: score },
    })

    if (score >= 60 && reasons.length > 0) {
      await db.gasFlaggedOrder.upsert({
        where: { orderId: order.id },
        create: {
          orderId:   order.id,
          reasons:   JSON.stringify(reasons),
          riskScore: score,
          status:    'pending_review',
        },
        update: {
          reasons:   JSON.stringify(reasons),
          riskScore: score,
        },
      })
      logger.warn({ orderId: order.id, score, reasons }, 'Gas order flagged for review')
    }
  } catch (err) {
    logger.error({ err, orderId: order.id }, 'gas.risk: flagIfRisky failed (non-fatal)')
  }
}

// ── Admin helpers ─────────────────────────────────────────────────────────────

export async function listFlaggedOrders(status?: string, page = 1, limit = 20) {
  const skip = (page - 1) * limit
  const where = status ? { status } : {}

  const [flagged, total] = await Promise.all([
    db.gasFlaggedOrder.findMany({
      where,
      orderBy: [{ riskScore: 'desc' }, { createdAt: 'desc' }],
      skip,
      take: limit,
      include: {
        order: {
          select: {
            orderRef: true, chain: true, status: true, toAddress: true,
            gasAmountUSD: true, paymentAmount: true, createdAt: true, ipAddress: true,
          },
        },
      },
    }),
    db.gasFlaggedOrder.count({ where }),
  ])

  return { flagged, total, page, limit }
}

export async function reviewFlaggedOrder(
  id: string,
  status: 'reviewed_ok' | 'reviewed_blocked',
  reviewedBy: string,
  adminNote?: string,
) {
  const existing = await db.gasFlaggedOrder.findUnique({ where: { id }, select: { status: true } })
  if (!existing) throw new Error('Flagged order not found')
  if (existing.status !== 'pending_review') {
    throw new Error(`Order is already ${existing.status} — cannot re-review`)
  }
  return db.gasFlaggedOrder.update({
    where: { id },
    data: { status, reviewedBy, reviewedAt: new Date(), adminNote: adminNote ?? null },
  })
}
