/**
 * Airdrop admin / TGE conversion scaffolding (Phase 5).
 *
 * This is the "everything ready to press the button" layer — season lifecycle,
 * setting a season's token pool, and computing each user's SHARE-OF-POOL token
 * allocation (points ÷ season total × pool). It deliberately does NOT deploy a
 * token, touch any chain, or move value — the on-chain TGE + DEX listing is a
 * separate, money-and-legal step done manually when the project is ready. The
 * allocation table + CSV export here is what feeds that step.
 */
import { db } from '../lib/prisma'
import { Prisma } from '@prisma/client'
import { AppError } from '../lib/errors'

export interface SeasonSummary {
  id: string
  index: number
  name: string
  status: string
  tokenPool: string | null
  participants: number
  totalPoints: number
  startedAt: Date
  endedAt: Date | null
}

async function seasonTotals(seasonId: string): Promise<{ participants: number; totalPoints: number }> {
  // Only positive balances count toward the share pool.
  const agg = await db.airdropAccount.aggregate({
    where: { seasonId, totalPoints: { gt: 0 } },
    _sum: { totalPoints: true },
    _count: { _all: true },
  })
  return { participants: agg._count._all, totalPoints: Number(agg._sum.totalPoints ?? 0) }
}

export async function listSeasons(): Promise<SeasonSummary[]> {
  const seasons = await db.airdropSeason.findMany({ orderBy: { index: 'desc' } })
  const out: SeasonSummary[] = []
  for (const s of seasons) {
    const { participants, totalPoints } = await seasonTotals(s.id)
    out.push({
      id: s.id,
      index: s.index,
      name: s.name,
      status: s.status,
      tokenPool: s.tokenPool ? s.tokenPool.toString() : null,
      participants,
      totalPoints,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
    })
  }
  return out
}

/** Create a new season. Closes any currently-active season so only one is active
 *  (earning always targets the highest-index active season). */
export async function createSeason(name: string): Promise<SeasonSummary> {
  const label = name.trim() || 'New Season'
  return db.$transaction(async (tx) => {
    const max = await tx.airdropSeason.aggregate({ _max: { index: true } })
    const nextIndex = (max._max.index ?? 0) + 1
    await tx.airdropSeason.updateMany({ where: { status: 'active' }, data: { status: 'closed', endedAt: new Date() } })
    const s = await tx.airdropSeason.create({ data: { index: nextIndex, name: label, status: 'active' } })
    return {
      id: s.id, index: s.index, name: s.name, status: s.status,
      tokenPool: null, participants: 0, totalPoints: 0, startedAt: s.startedAt, endedAt: s.endedAt,
    }
  })
}

export async function setSeasonTokenPool(seasonId: string, tokenPool: number): Promise<void> {
  if (!Number.isFinite(tokenPool) || tokenPool < 0) throw new AppError('VALIDATION_ERROR', 'Token pool must be a non-negative number.', 400)
  const s = await db.airdropSeason.findUnique({ where: { id: seasonId }, select: { id: true } })
  if (!s) throw new AppError('NOT_FOUND', 'Season not found.', 404)
  await db.airdropSeason.update({ where: { id: seasonId }, data: { tokenPool: new Prisma.Decimal(tokenPool) } })
}

export async function closeSeason(seasonId: string): Promise<void> {
  const s = await db.airdropSeason.findUnique({ where: { id: seasonId }, select: { status: true } })
  if (!s) throw new AppError('NOT_FOUND', 'Season not found.', 404)
  if (s.status === 'closed') return
  await db.airdropSeason.update({ where: { id: seasonId }, data: { status: 'closed', endedAt: new Date() } })
}

export interface Allocation {
  userId: string
  username: string
  email: string
  points: number
  sharePct: number
  tokenAllocation: number | null
}

/**
 * Compute each user's token allocation for a season: sharePct = points ÷ season
 * total, tokenAllocation = sharePct × pool (null until a pool is set). This is the
 * exact table you'd hand to the TGE distribution step.
 */
function toAllocation(userId: string, totalPointsForUser: number, seasonTotal: number, pool: number | null, u?: { username: string; email: string }): Allocation {
  const sharePct = seasonTotal > 0 ? (totalPointsForUser / seasonTotal) * 100 : 0
  const tokenAllocation = pool != null && seasonTotal > 0 ? (totalPointsForUser / seasonTotal) * pool : null
  return {
    userId,
    username: u?.username ?? '(unknown)',
    email: u?.email ?? '',
    points: totalPointsForUser,
    sharePct: Math.round(sharePct * 1e6) / 1e6,
    tokenAllocation: tokenAllocation != null ? Math.round(tokenAllocation * 1e8) / 1e8 : null,
  }
}

/**
 * UI-facing allocation preview: the top `limit` earners plus a `truncated` flag so
 * the admin knows the table is partial (the CSV export is always complete). Shares
 * are always computed against the FULL season total, so a row's % is correct even
 * when the list is truncated.
 */
export async function computeAllocations(seasonId: string, limit = 1000): Promise<{ season: SeasonSummary; totalPoints: number; pool: number | null; allocations: Allocation[]; truncated: boolean }> {
  const season = await db.airdropSeason.findUnique({ where: { id: seasonId } })
  if (!season) throw new AppError('NOT_FOUND', 'Season not found.', 404)
  const { participants, totalPoints } = await seasonTotals(seasonId)
  const pool = season.tokenPool ? Number(season.tokenPool) : null
  const take = Math.min(Math.max(limit, 1), 5000)

  const accounts = await db.airdropAccount.findMany({
    where: { seasonId, totalPoints: { gt: 0 } },
    orderBy: { totalPoints: 'desc' },
    take,
    select: { userId: true, totalPoints: true },
  })
  const users = await db.user.findMany({
    where: { id: { in: accounts.map((a) => a.userId) } },
    select: { id: true, username: true, email: true },
  })
  const uMap = new Map(users.map((u) => [u.id, u]))
  const allocations = accounts.map((a) => toAllocation(a.userId, Number(a.totalPoints), totalPoints, pool, uMap.get(a.userId)))

  const summary: SeasonSummary = {
    id: season.id, index: season.index, name: season.name, status: season.status,
    tokenPool: season.tokenPool ? season.tokenPool.toString() : null,
    participants, totalPoints, startedAt: season.startedAt, endedAt: season.endedAt,
  }
  return { season: summary, totalPoints, pool, allocations, truncated: participants > accounts.length }
}

/**
 * COMPLETE CSV of the allocation table for the manual TGE distribution — pages
 * through EVERY participant in batches (never truncated), computing each share
 * against the full season total. This is the artifact you actually distribute from.
 */
export async function exportAllocationsCsv(seasonId: string): Promise<string> {
  const season = await db.airdropSeason.findUnique({ where: { id: seasonId } })
  if (!season) throw new AppError('NOT_FOUND', 'Season not found.', 404)
  const { totalPoints } = await seasonTotals(seasonId)
  const pool = season.tokenPool ? Number(season.tokenPool) : null

  const header = 'userId,username,email,points,sharePct,tokenAllocation'
  const escape = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  const lines = [header]

  const BATCH = 5000
  let cursor: string | undefined
  for (;;) {
    const batch = await db.airdropAccount.findMany({
      where: { seasonId, totalPoints: { gt: 0 } },
      orderBy: { id: 'asc' },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: { id: true, userId: true, totalPoints: true },
    })
    if (batch.length === 0) break
    const users = await db.user.findMany({
      where: { id: { in: batch.map((b) => b.userId) } },
      select: { id: true, username: true, email: true },
    })
    const uMap = new Map(users.map((u) => [u.id, u]))
    for (const b of batch) {
      const a = toAllocation(b.userId, Number(b.totalPoints), totalPoints, pool, uMap.get(b.userId))
      lines.push([a.userId, escape(a.username), escape(a.email), a.points, a.sharePct, a.tokenAllocation ?? ''].join(','))
    }
    cursor = batch[batch.length - 1]!.id
    if (batch.length < BATCH) break
  }
  return lines.join('\n')
}
