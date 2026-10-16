import { monogramHue, monogramInitials } from '@/lib/portfolio/monogram'

const SIZES = { sm: 'h-7 w-7 text-[11px]', md: 'h-9 w-9 text-xs', lg: 'h-12 w-12 text-base' } as const

/**
 * Neutral initials icon for user-tracked tokens. Pure text + CSS: no image, favicon or logo is
 * ever requested, and it carries no verification meaning.
 */
export function TokenMonogram({ name, size = 'md' }: { name: string; size?: keyof typeof SIZES }) {
  const hue = monogramHue(name)
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
