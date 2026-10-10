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

export type CosmeticSlot = 'frame' | 'theme' | 'bubble'
export const COSMETIC_SLOTS: readonly CosmeticSlot[] = ['frame', 'theme', 'bubble']

export interface ShopItem {
  key: string
  kind: 'gas_discount' | 'badge' | 'cosmetic'
  /** Cosmetic slot: which part of the profile this item restyles (one equipped per slot). */
  slot?: CosmeticSlot
  label: string
  description: string
  cost: number
  discountPct?: number
  durationDays?: number
  emoji?: string
}

export const POINTS_SHOP_ITEMS_KEY = 'points_shop_items'

export const DEFAULT_ITEMS: ShopItem[] = [
  { key: 'gas20_week', kind: 'gas_discount', label: '20% off gas fees · 1 week', description: '20% off our service fee on every gas order for 7 days.', cost: 50, discountPct: 20, durationDays: 7, emoji: '⛽' },
  { key: 'gas30_month', kind: 'gas_discount', label: '30% off gas fees · 1 month', description: '30% off our service fee on every gas order for 30 days.', cost: 100, discountPct: 30, durationDays: 30, emoji: '🔥' },
  { key: 'gas40_week', kind: 'gas_discount', label: '40% off gas fees · 1 week', description: '40% off our service fee on every gas order for 7 days.', cost: 150, discountPct: 40, durationDays: 7, emoji: '⚡' },
  { key: 'gas50_month', kind: 'gas_discount', label: '50% off gas fees · 1 month', description: '50% off our service fee on every gas order for 30 days.', cost: 300, discountPct: 50, durationDays: 30, emoji: '💎' },
  { key: 'gas20_year', kind: 'gas_discount', label: '20% off gas fees · 1 year', description: '20% off our service fee on every gas order for a full year.', cost: 400, discountPct: 20, durationDays: 365, emoji: '🏆' },
  { key: 'gas70_3days', kind: 'gas_discount', label: '70% off gas fees · 3 days', description: '70% off our service fee on every gas order for 3 days.', cost: 450, discountPct: 70, durationDays: 3, emoji: '🚀' },
  { key: 'gas90_day', kind: 'gas_discount', label: '90% off gas fees · 24 hours', description: '90% off our service fee on every gas order for 24 hours. The biggest discount we offer.', cost: 800, discountPct: 90, durationDays: 1, emoji: '👑' },
  { key: 'badge_supporter', kind: 'badge', label: 'Supporter', description: 'A Supporter star for your collection.', cost: 30, emoji: '⭐' },
  { key: 'badge_trader', kind: 'badge', label: 'Power Trader', description: 'A Power Trader flame for people who trade often.', cost: 150, emoji: '🔥' },
  { key: 'badge_whale', kind: 'badge', label: 'Whale', description: 'The rare Whale badge.', cost: 500, emoji: '🐋' },
  // Cosmetics — purely decorative, never a trust signal. One equipped per slot.
  { key: 'frame_aurora', kind: 'cosmetic', slot: 'frame', label: 'Aurora frame', description: 'A teal-to-violet ring around your avatar.', cost: 150, emoji: '🌌' },
  { key: 'frame_sunset', kind: 'cosmetic', slot: 'frame', label: 'Sunset frame', description: 'A warm orange-to-pink ring around your avatar.', cost: 150, emoji: '🌇' },
  { key: 'frame_midnight', kind: 'cosmetic', slot: 'frame', label: 'Midnight frame', description: 'A deep indigo ring with a soft glow.', cost: 200, emoji: '🌙' },
  { key: 'theme_ocean', kind: 'cosmetic', slot: 'theme', label: 'Ocean profile theme', description: 'A calm blue banner on your public profile.', cost: 120, emoji: '🌊' },
  { key: 'theme_forest', kind: 'cosmetic', slot: 'theme', label: 'Forest profile theme', description: 'A green banner on your public profile.', cost: 120, emoji: '🌲' },
  { key: 'theme_royal', kind: 'cosmetic', slot: 'theme', label: 'Royal profile theme', description: 'A purple and gold banner on your public profile.', cost: 200, emoji: '👑' },
  { key: 'bubble_mint', kind: 'cosmetic', slot: 'bubble', label: 'Mint chat bubbles', description: 'Your messages appear in soft mint green.', cost: 80, emoji: '🍃' },
  { key: 'bubble_violet', kind: 'cosmetic', slot: 'bubble', label: 'Violet chat bubbles', description: 'Your messages appear in violet.', cost: 80, emoji: '🔮' },
  { key: 'bubble_sunset', kind: 'cosmetic', slot: 'bubble', label: 'Sunset chat bubbles', description: 'Your messages appear in a warm sunset gradient.', cost: 100, emoji: '🌅' },
]

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)

function validItem(o: unknown): ShopItem | null {
  const r = o as Record<string, unknown>
  const key = str(r?.key).trim()
  const kind = r?.kind
  const cost = Number(r?.cost)
  if (!/^[a-z0-9_]{2,40}$/.test(key) || (kind !== 'gas_discount' && kind !== 'badge' && kind !== 'cosmetic')) return null
  if (!Number.isFinite(cost) || cost <= 0) return null
  const item: ShopItem = {
    key, kind, cost,
    label: str(r?.label, key).slice(0, 80),
    description: str(r?.description).slice(0, 200),
  }
  if (typeof r?.emoji === 'string' && r.emoji) item.emoji = r.emoji.slice(0, 4)
  if (kind === 'cosmetic') {
    if (!COSMETIC_SLOTS.includes(r?.slot as CosmeticSlot)) return null
    item.slot = r.slot as CosmeticSlot
  }
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
        // A custom catalog predates cosmetics, so keep the default cosmetics available too.
        if (items.length > 0) return [...items, ...DEFAULT_ITEMS.filter((d) => d.kind === 'cosmetic' && !items.some((i) => i.key === d.key))]
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
  equippedBadge: string | null
  equippedCosmetics: Partial<Record<CosmeticSlot, string>>
  items: Array<ShopItem & { owned: boolean; activeUntil: string | null }>
  perks: Array<{ id: string; itemKey: string; kind: string; label: string; discountPct: number | null; expiresAt: string | null; createdAt: string }>
}

export async function getShop(userId: string): Promise<ShopView> {
  const now = new Date()
  const [catalog, balance, perks, stats] = await Promise.all([
    getCatalog(),
    getBalance(userId),
    db.pointsPerk.findMany({ where: { userId, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }, orderBy: { createdAt: 'desc' } }),
    db.tradeStats.findUnique({ where: { userId }, select: { equippedBadge: true, equippedCosmetics: true } }),
  ])
  return {
    balance,
    equippedBadge: stats?.equippedBadge ?? null,
    equippedCosmetics: parseCosmetics(stats?.equippedCosmetics),
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
  if (item.kind !== 'gas_discount' && existing.some((p) => p.itemKey === item.key)) {
    throw new AppError('ALREADY_OWNED', 'You already own this item.', 409)
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

/** Defensive parse of the stored JSON: only known slots with string values survive. */
export function parseCosmetics(v: unknown): Partial<Record<CosmeticSlot, string>> {
  const out: Partial<Record<CosmeticSlot, string>> = {}
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const s of COSMETIC_SLOTS) {
      const k = (v as Record<string, unknown>)[s]
      if (typeof k === 'string' && k) out[s] = k
    }
  }
  return out
}

/**
 * Equip (or clear, with null) one cosmetic in a slot. The user must own the item and
 * the item must belong to that slot. Purely decorative: never touches earned rank.
 */
export async function equipCosmetic(userId: string, slot: CosmeticSlot, itemKey: string | null): Promise<Partial<Record<CosmeticSlot, string>>> {
  if (!COSMETIC_SLOTS.includes(slot)) throw new AppError('VALIDATION', 'Unknown slot.', 400)
  if (itemKey !== null) {
    const item = (await getCatalog()).find((i) => i.key === itemKey)
    if (!item || item.kind !== 'cosmetic' || item.slot !== slot) throw new AppError('NOT_FOUND', 'That item does not fit this slot.', 404)
    const owned = await db.pointsPerk.findFirst({ where: { userId, kind: 'cosmetic', itemKey }, select: { id: true } })
    if (!owned) throw new AppError('NOT_OWNED', 'You do not own this item.', 403)
  }
  const current = await db.tradeStats.findUnique({ where: { userId }, select: { equippedCosmetics: true } })
  const next = parseCosmetics(current?.equippedCosmetics)
  if (itemKey === null) delete next[slot]
  else next[slot] = itemKey
  const json = next as Prisma.InputJsonValue
  await db.tradeStats.upsert({ where: { userId }, update: { equippedCosmetics: json }, create: { userId, equippedCosmetics: json } })
  return next
}

/**
 * Choose which owned badge is shown publicly (or null to hide). Purely cosmetic: it
 * never touches the earned trader tier. The user must actually own the badge.
 */
export async function equipBadge(userId: string, itemKey: string | null): Promise<{ equippedBadge: string | null }> {
  if (itemKey !== null) {
    const owned = await db.pointsPerk.findFirst({ where: { userId, kind: 'badge', itemKey }, select: { id: true } })
    if (!owned) throw new AppError('NOT_OWNED', 'You do not own this badge.', 403)
  }
  await db.tradeStats.upsert({
    where: { userId },
    update: { equippedBadge: itemKey },
    create: { userId, equippedBadge: itemKey },
  })
  return { equippedBadge: itemKey }
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
