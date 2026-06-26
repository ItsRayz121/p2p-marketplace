import Image from 'next/image'
import { cn } from '@/lib/utils'

/**
 * RupChain brand mark — the single square R+chain badge used everywhere.
 * The badge carries its own dark rounded plate, so it reads on both light and
 * dark surfaces; no separate theme variant is needed. The source is a square
 * PNG, so rendering it into a square box (object-contain) stays crisp and fully
 * visible at every size. Pass Tailwind sizing via `className` (e.g. "w-10 h-10").
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
      className={cn('object-contain flex-shrink-0', className)}
      priority={priority}
    />
  )
}
