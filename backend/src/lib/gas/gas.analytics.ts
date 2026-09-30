/**
 * Treasury analytics — burn rate, runway, profitability, volume timeseries.
 * All derived from existing GasLedgerEntry + GasFeeOrder — no new DB tables.
 */

import type { GasChain } from '@prisma/client'
import { db } from '../prisma'
import { getHotWalletBalance } from './gas.balance'
import { fromDbChain } from './gas.chains'
import { nativeSymbol as chainNativeSymbol } from './gas.ledger'
import type { GasChainId } from './gas.chains'

// ── Burn rate ─────────────────────────────────────────────────────────────────

export interface ChainBurnRate {
  chain: GasChain
  windowDays: number
  nativePerDay: number
  usdPerDay: number
  nativeSymbol: string
}

export async function getChainBurnRates(windowDays = 7): Promise<ChainBurnRate[]> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)

  const rows = await db.gasLedgerEntry.groupBy({
    by: ['chain', 'nativeSymbol'],
    where: {
      entryType: 'gas_delivery',
      nativeAmount: { lt: 0 },
      createdAt: { gte: since },
    },
    _sum: { nativeAmount: true, usdAmount: true },
  })

  return rows.map((r) => ({
    chain: r.chain,
    nativeSymbol: r.nativeSymbol,
    windowDays,
    nativePerDay: Math.abs(Number(r._sum.nativeAmount ?? 0)) / windowDays,
    usdPerDay:    Number(r._sum.usdAmount ?? 0) / windowDays,
  }))
}

// ── Runway ────────────────────────────────────────────────────────────────────

export interface ChainRunway {
  chain: GasChain
  nativeSymbol: string
  currentBalanceNative: number | null
  burnRateNativePerDay: number
  daysRemaining: number | null
  status: 'healthy' | 'low' | 'critical' | 'no_data'
  /** Why daysRemaining is null: nothing was delivered in the burn window, or the live balance could not be read. */
  reason: 'no_burn' | 'balance_unavailable' | null
}

export async function getChainRunways(): Promise<ChainRunway[]> {
  const burnRates = await getChainBurnRates(7)
  const wallets   = await db.gasHotWallet.findMany({ where: { isActive: true, hdIndex: 0 } })

  const runways: ChainRunway[] = []

  for (const wallet of wallets) {
    const chainId: GasChainId = fromDbChain(wallet.chain)
    const nativeSymbol = burnRates.find((b) => b.chain === wallet.chain)?.nativeSymbol ?? chainId

    let currentBalance: number | null = null
    try {
      currentBalance = await getHotWalletBalance(chainId, wallet.address)
    } catch { /* best-effort */ }

    const burnRate = burnRates.find((b) => b.chain === wallet.chain)?.nativePerDay ?? 0
    const daysRemaining =
      currentBalance !== null && burnRate > 0
        ? currentBalance / burnRate
        : null

    let status: ChainRunway['status'] = 'no_data'
    const reason: ChainRunway['reason'] =
      daysRemaining !== null ? null : currentBalance === null ? 'balance_unavailable' : 'no_burn'
    if (daysRemaining !== null) {
      if (daysRemaining < 3)  status = 'critical'
      else if (daysRemaining < 14) status = 'low'
      else status = 'healthy'
    }

    runways.push({ chain: wallet.chain, nativeSymbol, currentBalanceNative: currentBalance, burnRateNativePerDay: burnRate, daysRemaining, status, reason })
  }

  return runways
}

// ── Profitability ─────────────────────────────────────────────────────────────

export interface ChainProfitability {
  chain: GasChain
  nativeSymbol: string
  revenueUsd: number
  deliveryCostUsd: number
  refundCostUsd: number
  platformFeeUsd: number
  netProfitUsd: number
  /** Net profit / revenue (0–1, negative when losing money). null when there is no revenue to divide by. */
  margin: number | null
  orderCount: number
}

/**
 * Per-chain profitability over delivered orders (by deliveredAt). GasFeeOrder is the
 * source of truth: it covers every payment rail (crypto, PKR, exchange transfer) and
 * platform-funded free grants, whereas the hot-wallet ledger only sees on-chain USDT.
 *   revenue  = what customers paid (USD) for orders that were delivered
 *   cost     = USD value of the gas delivered (incl. manual external deliveries)
 *   refund   = native gas refunded per the ledger in the same window
 * Margin is null (never 0 / NaN / Infinity) when revenue is 0.
 */
export async function getProfitabilityByChain(fromDate?: Date, toDate?: Date): Promise<ChainProfitability[]> {
  const range = {
    ...(fromDate ? { gte: fromDate } : {}),
    ...(toDate   ? { lte: toDate }   : {}),
  }
  const hasRange = fromDate !== undefined || toDate !== undefined

  const [orderRows, refundRows] = await Promise.all([
    db.gasFeeOrder.groupBy({
      by: ['chain'],
      where: { status: 'delivered', ...(hasRange ? { deliveredAt: range } : {}) },
      _sum: { paymentAmount: true, gasAmountUSD: true },
      _count: { _all: true },
    }),
    db.gasLedgerEntry.groupBy({
      by: ['chain', 'entryType'],
      where: { entryType: { in: ['delivery_refund', 'platform_fee'] }, ...(hasRange ? { createdAt: range } : {}) },
      _sum: { usdAmount: true },
    }),
  ])

  const byChain = new Map<GasChain, ChainProfitability>()
  const ensure = (chain: GasChain): ChainProfitability => {
    let p = byChain.get(chain)
    if (!p) {
      p = {
        chain, nativeSymbol: chainNativeSymbol(chain),
        revenueUsd: 0, deliveryCostUsd: 0, refundCostUsd: 0, platformFeeUsd: 0,
        netProfitUsd: 0, margin: null, orderCount: 0,
      }
      byChain.set(chain, p)
    }
    return p
  }

  for (const r of orderRows) {
    const p = ensure(r.chain)
    p.revenueUsd      += Number(r._sum.paymentAmount ?? 0)
    p.deliveryCostUsd += Number(r._sum.gasAmountUSD ?? 0)
    p.orderCount      += r._count._all
  }
  for (const r of refundRows) {
    const p = ensure(r.chain)
    const usd = Number(r._sum.usdAmount ?? 0)
    if (r.entryType === 'delivery_refund') p.refundCostUsd += usd
    if (r.entryType === 'platform_fee')    p.platformFeeUsd += usd
  }

  for (const p of byChain.values()) {
    p.netProfitUsd = p.revenueUsd - p.deliveryCostUsd - p.refundCostUsd
    p.margin = p.revenueUsd > 0 && Number.isFinite(p.netProfitUsd) ? p.netProfitUsd / p.revenueUsd : null
  }

  return [...byChain.values()].sort((x, y) => y.revenueUsd - x.revenueUsd)
}

// ── Volume timeseries ─────────────────────────────────────────────────────────

export interface DailyVolume {
  date: string       // YYYY-MM-DD
  orderCount: number
  revenueUsd: number
  deliveryCostUsd: number
}

/** Delivered orders per UTC day (all payment rails), from GasFeeOrder — same source as profitability. */
export async function getVolumeTimeSeries(chain?: GasChain, windowDays = 30): Promise<DailyVolume[]> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)

  const rows = await db.gasFeeOrder.findMany({
    where: {
      status: 'delivered',
      deliveredAt: { gte: since },
      ...(chain ? { chain } : {}),
    },
    select: { deliveredAt: true, paymentAmount: true, gasAmountUSD: true },
    orderBy: { deliveredAt: 'asc' },
  })

  const byDate: Record<string, DailyVolume> = {}

  for (const r of rows) {
    if (!r.deliveredAt) continue
    const date = r.deliveredAt.toISOString().slice(0, 10)
    const day = (byDate[date] ??= { date, orderCount: 0, revenueUsd: 0, deliveryCostUsd: 0 })
    day.orderCount++
    day.revenueUsd      += Number(r.paymentAmount ?? 0)
    day.deliveryCostUsd += Number(r.gasAmountUSD ?? 0)
  }

  return Object.values(byDate).sort((x, y) => x.date.localeCompare(y.date))
}
