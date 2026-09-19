'use client'
import Link from 'next/link'
import { ExternalLink } from 'lucide-react'
import { EntityLogo } from '@/components/ui/EntityLogo'
import type { SharedGasPreview } from '@/lib/messaging'

/** A one-tap-shared gas chain rendered inline in a chat/channel bubble — tap it
 *  to go straight to that chain's gas-fee page. Mirrors SharedAdCard's shape
 *  (icon, name, one-line detail, external-link affordance) so a gas share
 *  reads the same as a shared listing instead of a plain text link. */
export function SharedGasCard({ gas, mine = false }: { gas: SharedGasPreview; mine?: boolean }) {
  if (gas.deleted) {
    return (
      <div className={`rounded-lg border px-3 py-2 text-xs italic ${mine ? 'border-white/30 text-white/70' : 'border-border text-text-muted'}`}>
        This gas chain is no longer available.
      </div>
    )
  }
  const href = `/gas/${gas.slug.toLowerCase()}`
  return (
    <Link
      href={href}
      className={`flex items-center gap-2 rounded-lg border p-2 transition-colors ${mine ? 'border-white/25 hover:bg-white/10' : 'border-border hover:bg-surface-alt'}`}
    >
      <EntityLogo type="chain" slug={gas.slug} size="sm" logoUrl={gas.logoUrl} />
      <div className="min-w-0 flex-1">
        <p className={`text-xs font-semibold truncate ${mine ? 'text-white' : 'text-text-primary'}`}>⛽ {gas.name ?? gas.slug}</p>
        <p className={`text-[11px] ${mine ? 'text-white/70' : 'text-text-muted'}`}>
          Buy with PKR or USDT{gas.networkLabel ? ` · ${gas.networkLabel}` : ''}
        </p>
      </div>
      <ExternalLink className={`w-3.5 h-3.5 flex-shrink-0 ${mine ? 'text-white/70' : 'text-text-muted'}`} />
    </Link>
  )
}
