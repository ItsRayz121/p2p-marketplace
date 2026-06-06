import Image from 'next/image'
import { cn } from '@/lib/utils'

/**
 * Theme-aware RupChain brand mark. Renders the coloured icon on light surfaces
 * and the white icon on dark surfaces so the logo stays visible in both themes.
 * Pass Tailwind sizing via `className` (e.g. "w-10 h-10").
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
    <>
      <Image
        src="/brand/logo-icon.png"
        alt="RupChain"
        width={size}
        height={size}
        className={cn('object-contain flex-shrink-0 dark:hidden', className)}
        priority={priority}
      />
      <Image
        src="/brand/logo-icon-white.png"
        alt="RupChain"
        width={size}
        height={size}
        className={cn('object-contain flex-shrink-0 hidden dark:block', className)}
        priority={priority}
      />
    </>
  )
}
