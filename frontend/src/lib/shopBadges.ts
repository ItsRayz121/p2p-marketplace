// Cosmetic Points-shop badges a user can equip. These are never a trust signal —
// rank (Bronze→Elite) is earned from real trading; these only decorate the avatar.
// The catalog itself lives on the backend (points_shop_items); this is the
// presentation side keyed by item key, with a neutral fallback for new items.

export interface ShopBadgeStyle { emoji: string; label: string; ring: string }

const STYLES: Record<string, ShopBadgeStyle> = {
  badge_supporter: { emoji: '⭐', label: 'Supporter', ring: 'border-amber-400' },
  badge_trader: { emoji: '🔥', label: 'Power Trader', ring: 'border-orange-500' },
  badge_whale: { emoji: '🐋', label: 'Whale', ring: 'border-sky-500' },
}

export function shopBadgeStyle(key: string | null | undefined): ShopBadgeStyle | null {
  if (!key) return null
  return STYLES[key] ?? { emoji: '🏅', label: 'Badge', ring: 'border-primary' }
}

// ─── Cosmetics (avatar frame / profile theme / chat bubble) ─────────────────────
// Decorative only. Frames sit OUTSIDE the earned rank ring so a bought item can never
// replace or imitate a trust signal.
export type CosmeticSlot = 'frame' | 'theme' | 'bubble'
export type EquippedCosmetics = Partial<Record<CosmeticSlot, string>> | null | undefined

export const FRAME_STYLES: Record<string, { bg: string; glow?: string }> = {
  frame_aurora: { bg: 'bg-gradient-to-tr from-teal-400 via-cyan-400 to-violet-500' },
  frame_sunset: { bg: 'bg-gradient-to-tr from-orange-400 via-rose-400 to-pink-500' },
  frame_midnight: { bg: 'bg-gradient-to-tr from-indigo-700 via-slate-700 to-indigo-500', glow: 'shadow-[0_0_10px_2px_rgba(99,102,241,0.45)]' },
}

export const THEME_STYLES: Record<string, string> = {
  theme_ocean: 'bg-gradient-to-r from-sky-500 via-blue-500 to-cyan-400',
  theme_forest: 'bg-gradient-to-r from-emerald-600 via-green-500 to-lime-400',
  theme_royal: 'bg-gradient-to-r from-purple-700 via-fuchsia-600 to-amber-400',
}

// Own-message bubble colours (text stays readable on each).
export const BUBBLE_STYLES: Record<string, string> = {
  bubble_mint: 'bg-emerald-500 text-white',
  bubble_violet: 'bg-violet-600 text-white',
  bubble_sunset: 'bg-gradient-to-br from-orange-500 to-pink-500 text-white',
}

export function cosmeticOf(c: EquippedCosmetics, slot: CosmeticSlot): string | undefined {
  const v = c && typeof c === 'object' ? (c as Record<string, unknown>)[slot] : undefined
  return typeof v === 'string' && v ? v : undefined
}
