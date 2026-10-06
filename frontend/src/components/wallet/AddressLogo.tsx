'use client'
import { EntityLogo } from '@/components/ui/EntityLogo'

// Mirrors how the wallet's saved-address list picks a logo: CTM delivery addresses show the
// token, on-chain networks show the chain, anything else is an exchange / internal-transfer venue.
// Logos resolve through EntityLogo's registry (admin uploads → bundled → CDN → initials), so a
// newly added token, chain or exchange picks up its logo with no change here.
const CTM_NETWORK = 'CTM'
const CHAIN_NETWORKS = new Set(['BEP20', 'APTOS', 'ERC20', 'TRC20', 'POLYGON', 'ARBITRUM', 'OPTIMISM', 'BASE'])

export function AddressLogo({ coin, network, size = 'md', className }: {
  coin: string
  network: string
  size?: 'xs' | 'sm' | 'md' | 'lg'
  className?: string
}) {
  const cls = `flex-shrink-0 ${className ?? ''}`
  if (network === CTM_NETWORK) return <EntityLogo type="token" slug={coin} size={size} className={cls} />
  if (CHAIN_NETWORKS.has(network.toUpperCase())) return <EntityLogo type="chain" slug={network} size={size} className={cls} />
  return <EntityLogo type="exchange" slug={network} size={size} className={cls} />
}
