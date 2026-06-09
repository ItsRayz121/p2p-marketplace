'use client'
import { cn } from '@/lib/utils'
import { EntityLogo } from './EntityLogo'

type SizeKey = 'xs' | 'sm' | 'md' | 'lg'

// Badge size (chain overlay) per base size.
const BADGE: Record<SizeKey, SizeKey> = { xs: 'xs', sm: 'xs', md: 'xs', lg: 'sm' }

/**
 * Renders a token icon with a small chain badge overlaid bottom-right — so a USDT
 * payment on BNB Smart Chain shows BOTH the USDT token logo and the BNB chain
 * logo, never just the chain. When no token is present, falls back to the chain
 * logo alone.
 */
export function TokenChainLogo({
  tokenSymbol,
  chain,
  size = 'sm',
  className,
}: {
  tokenSymbol?: string | null
  chain: string
  size?: SizeKey
  className?: string
}) {
  if (!tokenSymbol) {
    return <EntityLogo type="chain" slug={chain} size={size} className={className} />
  }
  return (
    <span className={cn('relative inline-flex flex-shrink-0', className)}>
      <EntityLogo type="token" slug={tokenSymbol} size={size} />
      <span className="absolute -bottom-1 -right-1 rounded-full ring-2 ring-surface bg-surface">
        <EntityLogo type="chain" slug={chain} size={BADGE[size]} />
      </span>
    </span>
  )
}
