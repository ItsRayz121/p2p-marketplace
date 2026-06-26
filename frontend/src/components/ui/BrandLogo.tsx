import Image from 'next/image'
import { cn } from '@/lib/utils'

/**
 * RupChain brand mark — the single square R+chain badge used everywhere.
 * The badge's own plate is navy (#0D1B2A), which is *darker* than the dark-mode
 * surfaces (#1e293b / #0f172a), so on dark backgrounds the plate edge would
 * dissolve. We add a faint hairline ring matched to the badge's 22% corner
 * radius: it's invisible on light surfaces (where the navy plate already pops)
 * but defines the edge on dark surfaces. Crisp at every size because the source
 * PNG is square. Pass Tailwind sizing via `className` (e.g. "w-10 h-10").
 */
export function BrandLogo({
  size = 40,
  className,
  priority = false,
}: {
  size?: number
  className?: string
  priority?: boolean
}) {
  return (
    <Image
      src="/brand/icon-512.png"
      alt="RupChain"
      width={size}
      height={size}
      className={cn(
        'object-contain flex-shrink-0 rounded-[22%] ring-1 ring-white/25',
        className,
      )}
      priority={priority}
    />
  )
}
