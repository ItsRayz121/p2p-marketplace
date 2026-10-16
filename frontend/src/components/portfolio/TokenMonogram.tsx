import { useState } from 'react'
import { monogramHue, monogramInitials } from '@/lib/portfolio/monogram'

const SIZES = { sm: 'h-7 w-7 text-[11px]', md: 'h-9 w-9 text-xs', lg: 'h-12 w-12 text-base' } as const

/**
 * Icon for a tracked token. Tokens the user typed in get a neutral initials icon (pure text + CSS: no
 * image, favicon or logo is requested, and it carries no verification meaning). A token that mirrors a
 * RupChain token shows the logo RupChain already hosts for it, and falls back to initials if it fails.
 */
export function TokenMonogram({ name, size = 'md', logoUrl }: { name: string; size?: keyof typeof SIZES; logoUrl?: string | null }) {
  const hue = monogramHue(name)
  const [failed, setFailed] = useState(false)
  if (logoUrl && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logoUrl} alt="" aria-hidden="true" data-testid="token-logo" loading="lazy" referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className={`inline-block ${SIZES[size]} flex-shrink-0 rounded-full object-cover bg-surface-hover`}
      />
    )
  }
  return (
    <span
      aria-hidden="true"
      data-testid="token-monogram"
      className={`inline-flex ${SIZES[size]} flex-shrink-0 items-center justify-center rounded-full font-semibold select-none`}
      style={{ backgroundColor: `hsl(${hue} 12% 90%)`, color: `hsl(${hue} 18% 28%)` }}
    >
      {monogramInitials(name)}
    </span>
  )
}
