/**
 * Points shop — spend RupChain Points on time-limited gas-fee discounts and badges.
 *
 * Catalog lives in code (DEFAULT_ITEMS) and can be replaced from the admin generic config
 * with a JSON array under `points_shop_items`. A gas_discount perk takes pct% off the
 * platform MARGIN of every gas order while active — margin only, floored at the margin
 * still undiscounted, so the base gas cost is never touched.
 */
import { randomBytes } from 'crypto'
import { Prisma } from '@prisma/client'
import { db } from '../lib/prisma'
import { AppError } from '../lib/errors'
import { isAirdropEnabledFor } from './airdrop.service'

export interface ShopItem {
  key: string
  kind: 'gas_discount' | 'badge'
  label: string
  description: string
  cost: number
  discountPct?: number
  durationDays?: number
  emoji?: string
}

export const POINTS_SHOP_ITEMS_KEY = 'points_shop_items'

export const DEFAULT_ITEMS: ShopItem[] = [
  { key: 'gas20_week', kind: 'gas_discount', label: '20% off gas fees · 1 week', description: '20% off the platform fee on every gas order for 7 days.', cost: 50, discountPct: 20, durationDays: 7, emoji: '⛽' },
  { key: 'gas30_month', kind: 'gas_discount', label: '30% off gas fees · 1 month', description: '30% off the platform fee on every gas order for 30 days.', cost: 100, discountPct: 30, durationDays: 30, emoji: '🔥' },
  { key: 'gas20_year', kind: 'gas_discount', label: '20% off gas fees · 1 year', description: '20% off the platform fee on every gas order for a full year.', cost: 400, discountPct: 20, durationDays: 365, emoji: '🏆' },
  { key: 'badge_supporter', kind: 'badge', label: 'Supporter badge', description: 'Show a Supporter star next to your name on your points page.', cost: 30, emoji: '⭐' },
  { key: 'badge_trader', kind: 'badge', label: 'Power Trader badge', description: 'A Power Trader flame for people who trade often.', cost: 150, emoji: '🔥' },
  { key: 'badge_whale', kind: 'badge', label: 'Whale badge', description: 'The Whale badge, a rare collector item.', cost: 500, emoji: '🐋' },
]

function validItem(o: unknown): ShopItem | null {
  const r = o as Record<string, unknown>
  const key = String(r?.key ?? '').trim()
  const kind = r?.kind
  const cost = Number(r?.cost)
  if (!/^[a-z0-9_]{2,40}$/.test(key) || (kind !== 'gas_discount' && kind !== 'badge')) return null
  if (!Number.isFinite(cost) || cost <= 0) return null
  const item: ShopItem = {
    key, kind, cost,
    label: String(r?.label ?? key).slice(0, 80),
    description: String(r?.description ?? '').slice(0, 200),
  }
  if (r?.emoji) item.emoji = String(r.emoji).slice(0, 4)
  if (kind === 'gas_discount') {
    const pct = Number(r?.discountPct), days = Number(r?.durationDays)
    if (!Number.isFinite(pct) || pct <= 0 || pct > 90 || !Number.isFinite(days) || days <= 0) return null
    item.discountPct = pct
    item.durationDays = Math.floor(days)
  }
  return item
}

export async function getCatalog(): Promise<ShopItem[]> {
  const row = await db.platformConfig.findUnique({ where: { key: POINTS_SHOP_ITEMS_KEY } })
  if (row?.value) {
    try {
      const parsed = JSON.parse(row.value) as unknown
      if (Array.isArray(parsed)) {
        const items = parsed.map(validItem).filter((i): i is ShopItem => !!i)
        if (items.length > 0) return items
      }
    } catch { /* fall back to defaults */ }
  }
  return DEFAULT_ITEMS
}

async function getBalance(userId: string): Promise<number> {
  const season = await db.airdropSeason.findFirst({ where: { status: 'active' }, orderBy: { index: 'desc' }, select: { id: true } })
  if (!season) return 0
  const acc = await db.airdropAccount.findUnique({ where: { userId_seasonId: { userId, seasonId: season.id } }, select: { totalPoints: true } })
  return Number(acc?.totalPoints ?? 0)
}

export interface ShopView {
  balance: number
  items: Array<ShopItem & { owned: boolean; activeUntil: string | null }>
  perks: Array<{ id: string; itemKey: string; kind: string; label: string; discountPct: number | null; expiresAt: string | null; createdAt: string }>
}

export async function getShop(userId: string): Promise<ShopView> {
  const now = new Date()
  const [catalog, balance, perks] = await Promise.all([
    getCatalog(),
    getBalance(userId),
    db.pointsPerk.findMany({ where: { userId, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }, orderBy: { createdAt: 'desc' } }),
  ])
  return {
    balance,
    items: catalog.map((i) => {
      const mine = perks.filter((p) => p.itemKey === i.key)
      const until = i.kind === 'gas_discount' ? mine.find((p) => p.expiresAt)?.expiresAt ?? null : null
      return { ...i, owned: mine.length > 0, activeUntil: until ? until.toISOString() : null }
    }),
    perks: perks.map((p) => ({
      id: p.id, itemKey: p.itemKey, kind: p.kind, label: p.label, discountPct: p.discountPct,
      expiresAt: p.expiresAt ? p.expiresAt.toISOString() : null, createdAt: p.createdAt.toISOString(),
    })),
  }
}

export async function buyItem(userId: string, itemKey: string): Promise<{ perkId: string; balance: number }> {
  if (!(await isAirdropEnabledFor(userId))) throw new AppError('POINTS_OFF', 'RupChain Points are not available right now.', 400)
  const item = (await getCatalog()).find((i) => i.key === itemKey)
  if (!item) throw new AppError('NOT_FOUND', 'That reward does not exist.', 404)

  const now = new Date()
  const existing = await db.pointsPerk.findMany({ where: { userId, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } })
  if (item.kind === 'badge' && existing.some((p) => p.itemKey === item.key)) {
    throw new AppError('ALREADY_OWNED', 'You already own this badge.', 409)
  }
  const activeDiscount = existing.find((p) => p.kind === 'gas_discount')
  if (item.kind === 'gas_discount' && activeDiscount?.expiresAt) {
    throw new AppError('DISCOUNT_ACTIVE', `You already have a gas discount until ${activeDiscount.expiresAt.toLocaleDateString('en-GB')}. Buy another once it ends.`, 409)
  }

  const cost = new Prisma.Decimal(item.cost)
  const perk = await db.$transaction(async (tx) => {
    const season = await tx.airdropSeason.findFirst({ where: { status: 'active' }, orderBy: { index: 'desc' }, select: { id: true } })
    if (!season) throw new AppError('POINTS_OFF', 'No active points season.', 400)
    // Guarded conditional decrement: a double-submit can never spend the same points twice.
    const flip = await tx.airdropAccount.updateMany({
      where: { userId, seasonId: season.id, totalPoints: { gte: cost } },
      data: { totalPoints: { decrement: cost } },
    })
    if (flip.count !== 1) throw new AppError('INSUFFICIENT_POINTS', `You need ${item.cost} points for this reward.`, 400)
    await tx.airdropLedger.create({
      data: {
        userId, seasonId: season.id, source: 'redeem', points: cost.negated(),
        eventKey: `shop:${userId}:${Date.now()}:${randomBytes(4).toString('hex')}`,
        metadata: { shop: item.key },
      },
    })
    return tx.pointsPerk.create({
      data: {
        userId, itemKey: item.key, kind: item.kind, label: item.label,
        discountPct: item.discountPct ?? null, pointsSpent: cost,
        expiresAt: item.durationDays ? new Date(Date.now() + item.durationDays * 86_400_000) : null,
      },
    })
  })
  return { perkId: perk.id, balance: await getBalance(userId) }
}

/** Highest active gas discount % the user holds (perks never stack with each other). */
export async function getActiveGasDiscountPct(userId: string | null | undefined): Promise<number> {
  if (!userId) return 0
  const best = await db.pointsPerk.findFirst({
    where: { userId, kind: 'gas_discount', expiresAt: { gt: new Date() } },
    orderBy: { discountPct: 'desc' },
    select: { discountPct: true },
  })
  return best?.discountPct ?? 0
}

/** Margin-only discount for a gas order from an active shop perk. Floored at the margin still undiscounted. */
export async function perkOrderDiscount(
  userId: string | null | undefined,
  marginUsdt: number,
  alreadyDiscountedUsdt: number,
): Promise<{ discountUsdt: number }> {
  const pct = await getActiveGasDiscountPct(userId)
  if (pct <= 0) return { discountUsdt: 0 }
  const room = Math.round(Math.max(0, marginUsdt - alreadyDiscountedUsdt) * 100) / 100
  if (room <= 0) return { discountUsdt: 0 }
  const raw = Math.round((pct / 100) * marginUsdt * 100) / 100
  return { discountUsdt: Math.min(raw, room) }
}
