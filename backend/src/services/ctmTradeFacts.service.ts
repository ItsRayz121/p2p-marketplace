import { db } from '../lib/prisma'
import type { CtmTradeFacts } from '../lib/portfolio/ctmImport'

/**
 * Read-only helpers that turn CTM trade rows into the facts the portfolio's settlement rules need.
 * Shared by the trade import and by platform price marks, so a trade is "proven" by exactly one rule.
 * Nothing here writes anything.
 */
const AUDIT_CHUNK = 100

/** Prisma select for everything `factsFromTrade` reads. */
export const TRADE_FACTS_SELECT = {
  id: true, tradeRef: true, displayRef: true, buyerId: true, sellerId: true, status: true, settlementType: true,
  completedAt: true, createdAt: true, tokenId: true, tokenAmount: true, fiatAmount: true, paymentCurrency: true, usdtAmount: true,
  dispute: { select: { id: true } },
  messages: { where: { isSystem: true, message: { startsWith: 'Trade auto-completed' } }, select: { id: true }, take: 1 },
  proofs: { where: { proofType: 'txhash', txVerificationStatus: 'verified' }, select: { id: true }, take: 1 },
} as const

/** Trade references an administrator force-completed (recorded in the audit log by reference). */
export async function forcedReleaseRefs(tradeRefs: string[]): Promise<Set<string>> {
  const forced = new Set<string>()
  for (let i = 0; i < tradeRefs.length; i += AUDIT_CHUNK) {
    const chunk = tradeRefs.slice(i, i + AUDIT_CHUNK)
    const rows = await db.auditLog.findMany({
      where: { action: 'CTM_ADMIN_FORCE_RELEASE', OR: chunk.map((r) => ({ metadata: { path: ['tradeRef'], equals: r } })) },
      select: { metadata: true },
    })
    for (const r of rows) {
      const ref = (r.metadata as { tradeRef?: unknown } | null)?.tradeRef
      if (typeof ref === 'string') forced.add(ref)
    }
  }
  return forced
}

interface TradeForFacts {
  id: string; tradeRef: string; displayRef: string | null; buyerId: string; sellerId: string; status: string
  settlementType: CtmTradeFacts['settlementType']; completedAt: Date | null; createdAt?: Date | null; tokenId: string
  tokenAmount: { toFixed(): string }; fiatAmount: { toFixed(): string }; paymentCurrency: string
  usdtAmount: { toFixed(): string } | null
  dispute: { id: string } | null; messages: unknown[]; proofs: unknown[]
}

/** Facts for one trade from the point of view of `userId` (the buyer is a fine choice when only the price matters). */
export function factsFromTrade(t: TradeForFacts, userId: string, forced: Set<string>): CtmTradeFacts {
  return {
    id: t.id,
    displayRef: t.displayRef,
    userId,
    buyerId: t.buyerId,
    sellerId: t.sellerId,
    status: t.status,
    settlementType: t.settlementType,
    completedAt: t.completedAt,
    createdAt: t.createdAt ?? null,
    tokenId: t.tokenId,
    tokenAmount: t.tokenAmount.toFixed(),
    fiatAmount: t.fiatAmount.toFixed(),
    paymentCurrency: t.paymentCurrency,
    usdtAmount: t.usdtAmount ? t.usdtAmount.toFixed() : null,
    hasDispute: Boolean(t.dispute),
    adminForceCompleted: forced.has(t.tradeRef),
    autoCompleted: t.messages.length > 0,
    verifiedTokenProof: t.proofs.length > 0,
  }
}
