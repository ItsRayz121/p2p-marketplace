import { cn } from '@/lib/utils'
import type { TraderBadge } from './TraderLevelCard'

// Bronze→Elite ring colour, keyed to the same hues TraderLevelCard/BadgeChip use
// for that tier, so the ring reads as the same badge rather than a new palette.
const TIER_RING: Record<TraderBadge, string> = {
  new:     'ring-amber-500/50',
  active:  'ring-slate-400/60',
  trusted: 'ring-yellow-400/70',
  top:     'ring-cyan-400/80',
  elite:   'ring-purple-400/90',
}

// Gold and above also get a soft blurred glow — Bronze/Silver are common enough
// that lighting them up the same way would just be noise, not a signal.
const TIER_GLOW: Partial<Record<TraderBadge, string>> = {
  trusted: 'shadow-[0_0_9px_1px_rgba(234,179,8,0.55)]',
  top:     'shadow-[0_0_10px_2px_rgba(34,211,238,0.6)]',
  elite:   'shadow-[0_0_12px_3px_rgba(192,132,252,0.6)]',
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
  /** Trader tier (Bronze→Elite) — draws a tier-coloured ring around the avatar. */
  tier?: TraderBadge | null
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

export function UserAvatar({ name, avatarUrl, size = 'sm', className, tier, glow }: Props) {
  const initials = name
    .split(/[\s_]+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')
    || name.slice(0, 2).toUpperCase()

  const showGlow = glow ?? (size === 'lg' || size === 'xl')
  const tierRing = tier
    ? cn('ring-2 ring-offset-2 ring-offset-surface', TIER_RING[tier], showGlow && TIER_GLOW[tier])
    : ''

  return avatarUrl ? (
    <img
      src={avatarUrl}
      alt={name}
      className={cn('rounded-full object-cover flex-shrink-0', SIZE[size], tierRing, className)}
    />
  ) : (
    <div className={cn('rounded-full flex items-center justify-center font-bold flex-shrink-0 select-none', SIZE[size], colorFor(name), tierRing, className)}>
      {initials}
    </div>
  )
}
