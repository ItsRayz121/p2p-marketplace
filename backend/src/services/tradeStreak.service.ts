import { db } from '../lib/prisma'
import { Prisma } from '@prisma/client'

type Tx = Prisma.TransactionClient

// ──────────────────────────────────────────────────────────────────────────────
// MUTUAL TRADE STREAKS
//
// A streak is the COMBINED count of completed trades between an unordered pair of
// users, across every pillar (USDT P2P + CTM). It is the platform's strongest
// trust signal: "you've completed N trades with this person." Each pair maps to a
// single TradeStreak row keyed on the lexicographically smaller id (userAId), so
// the buyer/seller ordering of any individual trade is irrelevant.
//
// incrementTradeStreak runs INSIDE the same db.$transaction that completes a
// trade, so the count can never drift from the trades that produced it.
// ──────────────────────────────────────────────────────────────────────────────

/** Canonicalise a pair of user ids into [smaller, larger]. */
function orderPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a]
}

// Milestone thresholds that earn a celebratory system message in the trade chat.
// After 100 we fire on every multiple of 100 (200, 300, …, 1000, 1100, 1500, …).
const MILESTONES = new Set([1, 5, 10, 25, 50, 75, 100])

export function isStreakMilestone(count: number): boolean {
  if (count <= 0) return false
  if (MILESTONES.has(count)) return true
  return count > 100 && count % 100 === 0
}

export interface StreakIncrementResult {
  count: number
  isMilestone: boolean
}

/**
 * Increment the combined streak for a pair of users by one and return the new
 * count. MUST be called inside a transaction so it commits atomically with the
 * trade that triggered it. Self-trades (a === b, shouldn't happen) are ignored.
 */
export async function incrementTradeStreak(
  tx: Tx,
  userId1: string,
  userId2: string,
): Promise<StreakIncrementResult> {
  if (userId1 === userId2) return { count: 0, isMilestone: false }
  const [userAId, userBId] = orderPair(userId1, userId2)
  const now = new Date()

  const streak = await tx.tradeStreak.upsert({
    where: { userAId_userBId: { userAId, userBId } },
    create: { userAId, userBId, tradeCount: 1, firstTradeAt: now, lastTradeAt: now },
    update: { tradeCount: { increment: 1 }, lastTradeAt: now },
  })

  return { count: streak.tradeCount, isMilestone: isStreakMilestone(streak.tradeCount) }
}

/**
 * Read the current combined streak between two users (no side effects). Returns
 * 0 / nulls when the pair has never completed a trade together.
 */
export async function getTradeStreak(
  userId1: string,
  userId2: string,
): Promise<{ count: number; firstTradeAt: Date | null; lastTradeAt: Date | null }> {
  if (userId1 === userId2) return { count: 0, firstTradeAt: null, lastTradeAt: null }
  const [userAId, userBId] = orderPair(userId1, userId2)
  const streak = await db.tradeStreak.findUnique({
    where: { userAId_userBId: { userAId, userBId } },
    select: { tradeCount: true, firstTradeAt: true, lastTradeAt: true },
  })
  if (!streak) return { count: 0, firstTradeAt: null, lastTradeAt: null }
  return { count: streak.tradeCount, firstTradeAt: streak.firstTradeAt, lastTradeAt: streak.lastTradeAt }
}

/** Ordinal helper for milestone copy — 1st, 2nd, 3rd, 21st … */
export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`
}
