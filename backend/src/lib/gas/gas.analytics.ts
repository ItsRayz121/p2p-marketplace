/**
 * Treasury analytics — burn rate, runway, profitability, volume timeseries.
 * All derived from existing GasLedgerEntry + GasFeeOrder — no new DB tables.
 */

import type { GasChain } from '@prisma/client'
import { db } from '../prisma'
import { getHotWalletBalance } from './gas.balance'
import { fromDbChain } from './gas.chains'
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
    if (daysRemaining !== null) {
      if (daysRemaining < 3)  status = 'critical'
      else if (daysRemaining < 14) status = 'low'
      else status = 'healthy'
    }

    runways.push({ chain: wallet.chain, nativeSymbol, currentBalanceNative: currentBalance, burnRateNativePerDay: burnRate, daysRemaining, status })
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
  margin: number // 0–1
  orderCount: number
}

export async function getProfitabilityByChain(fromDate?: Date, toDate?: Date): Promise<ChainProfitability[]> {
  const where = {
    createdAt: {
      ...(fromDate ? { gte: fromDate } : {}),
      ...(toDate   ? { lte: toDate }   : {}),
    },
  }

  const rows = await db.gasLedgerEntry.groupBy({
    by: ['chain', 'nativeSymbol', 'entryType'],
    where,
    _sum: { usdAmount: true },
    _count: { id: true },
  })

  const byChain: Record<string, ChainProfitability> = {}

  for (const r of rows) {
    const key = r.chain
    if (!byChain[key]) {
      byChain[key] = {
        chain: r.chain, nativeSymbol: r.nativeSymbol,
        revenueUsd: 0, deliveryCostUsd: 0, refundCostUsd: 0, platformFeeUsd: 0,
        netProfitUsd: 0, margin: 0, orderCount: 0,
      }
    }
    const usd = Number(r._sum.usdAmount ?? 0)
    const p   = byChain[key]!

    if (r.entryType === 'order_payment')   { p.revenueUsd      += usd; p.orderCount += r._count.id }
    if (r.entryType === 'gas_delivery')    { p.deliveryCostUsd += usd }
    if (r.entryType === 'delivery_refund') { p.refundCostUsd   += usd }
    if (r.entryType === 'platform_fee')    { p.platformFeeUsd  += usd }
  }

  for (const p of Object.values(byChain)) {
    p.netProfitUsd = p.revenueUsd - p.deliveryCostUsd - p.refundCostUsd
    p.margin = p.revenueUsd > 0 ? p.netProfitUsd / p.revenueUsd : 0
  }

  return Object.values(byChain)
}

// ── Volume timeseries ─────────────────────────────────────────────────────────

export interface DailyVolume {
  date: string       // YYYY-MM-DD
  orderCount: number
  revenueUsd: number
  deliveryCostUsd: number
}

export async function getVolumeTimeSeries(chain?: GasChain, windowDays = 30): Promise<DailyVolume[]> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)

  const rows = await db.gasLedgerEntry.findMany({
    where: {
      entryType: { in: ['order_payment', 'gas_delivery'] },
      createdAt: { gte: since },
      ...(chain ? { chain } : {}),
    },
    select: { entryType: true, usdAmount: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })

  const byDate: Record<string, DailyVolume> = {}

  for (const r of rows) {
    const date = r.createdAt.toISOString().slice(0, 10)!
    if (!byDate[date]) byDate[date] = { date, orderCount: 0, revenueUsd: 0, deliveryCostUsd: 0 }
    const usd = Number(r.usdAmount ?? 0)
    if (r.entryType === 'order_payment') { byDate[date]!.revenueUsd += usd; byDate[date]!.orderCount++ }
    if (r.entryType === 'gas_delivery')  { byDate[date]!.deliveryCostUsd += usd }
  }

  return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date))
}
