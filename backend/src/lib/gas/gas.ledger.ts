/**
 * Internal accounting ledger — append-only record of every financial movement
 * through the gas wallet infrastructure.
 *
 * Rules:
 *   - Rows are NEVER updated. Write a corrective entry if something needs fixing.
 *   - nativeAmount is positive for inflows to the hot wallet, negative for outflows.
 *   - Every delivery, refund, refill, and drain must produce a ledger entry.
 */

import type { GasChain, GasLedgerEntryType, Prisma } from '@prisma/client'
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
  const where: Prisma.GasLedgerEntryWhereInput = {}
  if (chain) where.chain = toDbChain(chain)

  const entries = await db.gasLedgerEntry.findMany({
    where,
    select: { chain: true, entryType: true, nativeAmount: true, usdAmount: true },
  })

  const byChain: Record<string, ChainLedgerSummary> = {}

  for (const e of entries) {
    if (!byChain[e.chain]) {
      byChain[e.chain] = {
        chain: e.chain,
        totalInflowNative: 0, totalOutflowNative: 0, netNative: 0,
        totalInflowUsd: 0,    totalOutflowUsd: 0,    netUsd: 0,
        orderPaymentsUsd: 0,  deliveriesNative: 0,
        refundsUsd: 0,        refillsNative: 0,
      }
    }
    const s   = byChain[e.chain]!
    const nat = Number(e.nativeAmount)
    const usd = Number(e.usdAmount)

    if (nat >= 0) { s.totalInflowNative  += nat; s.totalInflowUsd  += usd }
    else          { s.totalOutflowNative += Math.abs(nat); s.totalOutflowUsd += usd }

    s.netNative = s.totalInflowNative  - s.totalOutflowNative
    s.netUsd    = s.totalInflowUsd     - s.totalOutflowUsd

    if (e.entryType === 'order_payment')          s.orderPaymentsUsd  += usd
    if (e.entryType === 'gas_delivery')           s.deliveriesNative  += Math.abs(nat)
    if (e.entryType === 'delivery_refund')        s.refundsUsd        += usd
    if (e.entryType === 'refill_hot_from_treasury') s.refillsNative   += nat
  }

  return Object.values(byChain)
}
