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
