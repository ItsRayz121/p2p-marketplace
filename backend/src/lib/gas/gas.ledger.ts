/**
 * Internal accounting ledger — append-only record of every financial movement
 * through the gas wallet infrastructure.
 *
 * Rules:
 *   - Rows are NEVER updated. Write a corrective entry if something needs fixing.
 *   - nativeAmount is positive for inflows to the hot wallet, negative for outflows.
 *   - Every delivery, refund, refill, and drain must produce a ledger entry.
 */

import type { GasChain, GasLedgerEntryType } from '@prisma/client'
import { Prisma } from '@prisma/client'
import { db } from '../prisma'
import { logger } from '../logger'
import type { GasChainId } from './gas.chains'
import { toDbChain } from './gas.chains'
import { getNativeUsdPrice } from './gas.balance'

// ── Chain → native symbol mapping ─────────────────────────────────────────────

const NATIVE_SYMBOL: Record<string, string> = {
  TRON: 'TRX', BSC: 'BNB', ETH: 'ETH', ETHEREUM: 'ETH',
  BASE: 'ETH', ARB: 'ETH', OP: 'ETH', MATIC: 'POL',
  AVAX: 'AVAX', SOL: 'SOL', TON: 'TON', SUI: 'SUI',
}

export function nativeSymbol(chain: GasChainId | string): string {
  return NATIVE_SYMBOL[chain.toUpperCase()] ?? chain
}

// ── Append helpers ─────────────────────────────────────────────────────────────

export interface LedgerEntryInput {
  entryType: GasLedgerEntryType
  chain: GasChainId
  /** Positive = into hot wallet; negative = out of hot wallet */
  nativeAmount: number
  usdAmount?: number           // if omitted, derived from live price
  /** ERC20/TRC20 token symbol (e.g. "USDT"). Null for native-only entries. */
  tokenSymbol?: string
  /** Human-decimal token amount matching tokenSymbol. */
  tokenAmount?: number
  txHash?: string
  fromAddress?: string
  toAddress?: string
  /** Idempotency key. If set and a row with this key already exists, the call
   *  is silently skipped and returns null. Use for webhook and poller entries. */
  sourceKey?: string
  relatedOrderId?: string
  relatedRefillId?: string
  notes?: string
}

export async function appendLedgerEntry(input: LedgerEntryInput) {
  const dbChain = toDbChain(input.chain)
  const symbol  = nativeSymbol(input.chain)

  let usdAmount = input.usdAmount
  if (usdAmount === undefined) {
    const price = await getNativeUsdPrice(input.chain).catch(() => 0)
    usdAmount = Math.abs(input.nativeAmount) * price
  }

  try {
    return await db.gasLedgerEntry.create({
      data: {
        entryType:       input.entryType,
        chain:           dbChain,
        nativeAmount:    input.nativeAmount,
        nativeSymbol:    symbol,
        tokenSymbol:     input.tokenSymbol     ?? null,
        tokenAmount:     input.tokenAmount     ?? null,
        usdAmount,
        txHash:          input.txHash          ?? null,
        fromAddress:     input.fromAddress     ?? null,
        toAddress:       input.toAddress       ?? null,
        sourceKey:       input.sourceKey       ?? null,
        relatedOrderId:  input.relatedOrderId  ?? null,
        relatedRefillId: input.relatedRefillId ?? null,
        notes:           input.notes           ?? null,
      },
    })
  } catch (err) {
    // P2002 = unique constraint violation — sourceKey already exists, skip silently
    if ((err as { code?: string }).code === 'P2002' && input.sourceKey) {
      logger.info(
        { sourceKey: input.sourceKey, chain: input.chain, entryType: input.entryType },
        'Ledger entry skipped — duplicate sourceKey (already recorded)',
      )
      return null
    }
    throw err
  }
}

// ── Query helpers ──────────────────────────────────────────────────────────────

export interface LedgerFilter {
  chain?: GasChainId
  entryType?: GasLedgerEntryType
  relatedOrderId?: string
  relatedRefillId?: string
  fromDate?: Date
  toDate?: Date
  page?: number
  limit?: number
}

export async function getLedgerEntries(filter: LedgerFilter = {}) {
  const limit = Math.min(filter.limit ?? 50, 200)
  const skip  = ((filter.page ?? 1) - 1) * limit

  const where: Prisma.GasLedgerEntryWhereInput = {}
  if (filter.chain)           where.chain          = toDbChain(filter.chain)
  if (filter.entryType)       where.entryType      = filter.entryType
  if (filter.relatedOrderId)  where.relatedOrderId = filter.relatedOrderId
  if (filter.relatedRefillId) where.relatedRefillId = filter.relatedRefillId
  if (filter.fromDate || filter.toDate) {
    where.createdAt = {}
    if (filter.fromDate) where.createdAt.gte = filter.fromDate
    if (filter.toDate)   where.createdAt.lte = filter.toDate
  }

  const [entries, total] = await Promise.all([
    db.gasLedgerEntry.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
    db.gasLedgerEntry.count({ where }),
  ])

  return { entries, total, page: filter.page ?? 1, limit }
}

export interface ChainLedgerSummary {
  chain: GasChain
  totalInflowNative: number
  totalOutflowNative: number
  netNative: number
  totalInflowUsd: number
  totalOutflowUsd: number
  netUsd: number
  orderPaymentsUsd: number
  deliveriesNative: number
  refundsUsd: number
  refillsNative: number
}

export async function getLedgerSummary(chain?: GasChainId): Promise<ChainLedgerSummary[]> {
  // Aggregate in SQL (GROUP BY) instead of loading every ledger row into memory.
  // The old approach was an unbounded findMany + JS reduce — fine at thousands of
  // rows, a memory/latency hazard at millions.
  const whereSql = chain
    ? Prisma.sql`WHERE "chain" = ${toDbChain(chain)}::"GasChain"`
    : Prisma.empty

  const rows = await db.$queryRaw<Array<{
    chain: GasChain
    inflow_native: number | null
    outflow_native: number | null
    inflow_usd: number | null
    outflow_usd: number | null
    order_payments_usd: number | null
    deliveries_native: number | null
    refunds_usd: number | null
    refills_native: number | null
  }>>(Prisma.sql`
    SELECT
      "chain",
      SUM(CASE WHEN "nativeAmount" >= 0 THEN "nativeAmount" ELSE 0 END)::float8                       AS inflow_native,
      SUM(CASE WHEN "nativeAmount" <  0 THEN ABS("nativeAmount") ELSE 0 END)::float8                  AS outflow_native,
      SUM(CASE WHEN "nativeAmount" >= 0 THEN "usdAmount" ELSE 0 END)::float8                          AS inflow_usd,
      SUM(CASE WHEN "nativeAmount" <  0 THEN "usdAmount" ELSE 0 END)::float8                          AS outflow_usd,
      SUM(CASE WHEN "entryType" = 'order_payment' THEN "usdAmount" ELSE 0 END)::float8                AS order_payments_usd,
      SUM(CASE WHEN "entryType" = 'gas_delivery' THEN ABS("nativeAmount") ELSE 0 END)::float8         AS deliveries_native,
      SUM(CASE WHEN "entryType" = 'delivery_refund' THEN "usdAmount" ELSE 0 END)::float8              AS refunds_usd,
      SUM(CASE WHEN "entryType" = 'refill_hot_from_treasury' THEN "nativeAmount" ELSE 0 END)::float8  AS refills_native
    FROM "GasLedgerEntry"
    ${whereSql}
    GROUP BY "chain"
  `)

  return rows.map((r) => {
    const inflowNative = r.inflow_native ?? 0
    const outflowNative = r.outflow_native ?? 0
    const inflowUsd = r.inflow_usd ?? 0
    const outflowUsd = r.outflow_usd ?? 0
    return {
      chain: r.chain,
      totalInflowNative: inflowNative,
      totalOutflowNative: outflowNative,
      netNative: inflowNative - outflowNative,
      totalInflowUsd: inflowUsd,
      totalOutflowUsd: outflowUsd,
      netUsd: inflowUsd - outflowUsd,
      orderPaymentsUsd: r.order_payments_usd ?? 0,
      deliveriesNative: r.deliveries_native ?? 0,
      refundsUsd: r.refunds_usd ?? 0,
      refillsNative: r.refills_native ?? 0,
    }
  })
}
