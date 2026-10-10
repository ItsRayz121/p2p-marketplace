import { cn } from '@/lib/utils'
import { shopBadgeStyle } from '@/lib/shopBadges'
import type { TraderBadge } from './TraderLevelCard'

// Rank (Bronze→Elite) is earned from real trading and the avatar gets more polished
// with every step: Bronze ('new') is deliberately plain — no ring, no colour — then
// Silver adds a ring, Gold a gradient + glow, Diamond a double ring, Elite a
// gradient ring with a crown. Colours match TraderLevelCard/BadgeChip per tier.
const TIER_RING: Partial<Record<TraderBadge, string>> = {
  active:  'ring-2 ring-offset-2 ring-offset-surface ring-slate-400/70',
  trusted: 'ring-2 ring-offset-2 ring-offset-surface ring-yellow-400',
  top:     'ring-2 ring-offset-2 ring-offset-surface ring-cyan-400',
}

// Gold and above also get a soft blurred glow — Bronze/Silver are common enough
// that lighting them up the same way would just be noise, not a signal.
const TIER_GLOW: Partial<Record<TraderBadge, string>> = {
  trusted: 'shadow-[0_0_9px_1px_rgba(234,179,8,0.55)]',
  top:     'shadow-[0_0_10px_2px_rgba(34,211,238,0.6),0_0_0_5px_rgba(34,211,238,0.18)]',
}

// Initials-avatar fill per tier (photos ignore this).
const TIER_FILL: Partial<Record<TraderBadge, string>> = {
  new:     'bg-slate-200 text-slate-500 dark:bg-slate-700/60 dark:text-slate-300',
  active:  'bg-slate-100 text-slate-700 dark:bg-slate-600/40 dark:text-slate-200',
  trusted: 'bg-gradient-to-br from-amber-100 to-yellow-300 text-amber-900',
  top:     'bg-gradient-to-br from-cyan-100 to-sky-300 text-cyan-900',
  elite:   'bg-gradient-to-br from-violet-200 to-fuchsia-300 text-violet-900',
}

const PALETTE = [
  'bg-blue-500/15 text-blue-700 dark:text-blue-300',
  'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  'bg-pink-500/15 text-pink-700 dark:text-pink-300',
  'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300',
  'bg-red-500/15 text-red-700 dark:text-red-300',
  'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300',
]

function colorFor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (Math.imul(31, h) + name.charCodeAt(i)) | 0
  return PALETTE[Math.abs(h) % PALETTE.length]
}

interface Props {
  name: string
  avatarUrl?: string | null
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  className?: string
  /** Trader tier (Bronze→Elite). Bronze is plain; higher tiers get progressively richer rings. */
  tier?: TraderBadge | null
  /** Equipped Points-shop badge key — shown as a small corner icon (cosmetic only). */
  equipped?: string | null
  /** Force the blurred glow on/off. Defaults to on for lg/xl, off for smaller
   *  sizes so dense lists (e.g. Messages) get a plain ring, not visual noise. */
  glow?: boolean
}

const SIZE = {
  xs:  'w-5 h-5 text-[9px]',
  sm:  'w-7 h-7 text-[11px]',
  md:  'w-9 h-9 text-sm',
  lg:  'w-12 h-12 text-base',
  xl:  'w-16 h-16 text-xl',
}

// Rendered px per size (matches SIZE above). Cloudinary serves the original
// upload (often ~1000px, 250KB+) unless asked otherwise, which on the homepage
// was a 28px avatar costing a quarter-megabyte on mobile.
const SIZE_PX = { xs: 20, sm: 28, md: 36, lg: 48, xl: 64 }

// Corner badge sizing per avatar size; xs is too small to carry one legibly.
const CORNER = {
  sm: 'h-3.5 w-3.5 text-[8px] -right-1 -bottom-1',
  md: 'h-4 w-4 text-[9px] -right-1 -bottom-1',
  lg: 'h-5 w-5 text-[11px] -right-1.5 -bottom-1.5',
  xl: 'h-6 w-6 text-[13px] -right-1.5 -bottom-1.5',
}

// Insert a resize + auto-format/quality transform right after /image/upload/.
// Requests 2x for retina. URLs that are not plain Cloudinary uploads, or that
// already carry a transform, are returned untouched.
function optimizedAvatarUrl(url: string, px: number): string {
  const m = url.match(/^(https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/)(v\d+\/.+)$/)
  if (!m) return url
  const d = px * 2
  return `${m[1]}c_fill,g_auto,w_${d},h_${d},f_auto,q_auto/${m[2]}`
}

export function UserAvatar({ name, avatarUrl, size = 'sm', className, tier, equipped, glow }: Props) {
  const initials = name
    .split(/[\s_]+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')
    || name.slice(0, 2).toUpperCase()

  const showGlow = glow ?? (size === 'lg' || size === 'xl')
  const isElite = tier === 'elite'
  const tierRing = tier
    ? cn(TIER_RING[tier], showGlow && TIER_GLOW[tier])
    : ''
  const shop = size === 'xs' ? null : shopBadgeStyle(equipped)
  const wrapped = isElite || !!shop

  const inner = avatarUrl ? (
    <img
      loading="lazy"
      decoding="async"
      src={optimizedAvatarUrl(avatarUrl, SIZE_PX[size])}
      width={SIZE_PX[size]}
      height={SIZE_PX[size]}
      alt={name}
      className={cn('rounded-full object-cover flex-shrink-0', SIZE[size], tierRing, !wrapped && className)}
    />
  ) : (
    <div className={cn('rounded-full flex items-center justify-center font-bold flex-shrink-0 select-none', SIZE[size], tier && TIER_FILL[tier] ? TIER_FILL[tier] : colorFor(name), tierRing, !wrapped && className)}>
      {initials}
    </div>
  )

  if (!wrapped) return inner

  const core = isElite ? (
    // Elite: a gradient ring around the avatar, with a soft glow on larger sizes.
    <span className={cn('inline-flex rounded-full bg-[conic-gradient(from_200deg,#8b5cf6,#ec4899,#f59e0b,#8b5cf6)] p-[2.5px]', showGlow && 'shadow-[0_0_12px_3px_rgba(168,85,247,0.45)]')}>
      <span className="inline-flex rounded-full bg-surface p-[1.5px]">{inner}</span>
    </span>
  ) : inner

  return (
    <span className={cn('relative inline-flex flex-shrink-0', className)}>
      {core}
      {isElite && (size === 'lg' || size === 'xl') && (
        <span aria-hidden className="absolute -top-3 left-1/2 -translate-x-1/2 text-sm leading-none">👑</span>
      )}
      {shop && (
        <span
          title={shop.label}
          aria-label={shop.label}
          className={cn('absolute flex items-center justify-center rounded-full border-2 bg-surface leading-none', shop.ring, CORNER[size as keyof typeof CORNER])}
        >
          {shop.emoji}
        </span>
      )}
    </span>
  )
}
