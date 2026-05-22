'use client'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { useLogoRegistry } from '@/hooks/useLogoRegistry'
import { resolveLogo, getAvatarColor, getInitials } from '@/lib/logoRegistry'
import type { EntityType } from '@/lib/logoRegistry'

// ── Size map ──────────────────────────────────────────────────────────────────

const SIZE: Record<string, string> = {
  xs:  'w-4 h-4 text-[8px]',
  sm:  'w-6 h-6 text-[9px]',
  md:  'w-8 h-8 text-xs',
  lg:  'w-9 h-9 text-xs',
  xl:  'w-10 h-10 text-sm',
  '2xl': 'w-14 h-14 text-base',
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface EntityLogoProps {
  type:     EntityType
  slug:     string
  size?:    keyof typeof SIZE
  className?: string
  /**
   * Pass a pre-fetched logo URL from API data to skip registry lookup.
   * The registry is still used as a fallback if this URL fails to load.
   */
  logoUrl?: string | null
}

// ── Component ─────────────────────────────────────────────────────────────────

export function EntityLogo({
  type, slug, size = 'md', className, logoUrl: urlOverride,
}: EntityLogoProps) {
  const logoMap = useLogoRegistry()
  const [imgError, setImgError] = useState(false)

  // 1. Explicit override (caller already has URL from their API response)
  // 2. DB registry (admin-uploaded) + static CDN fallback
  const resolvedUrl = (!imgError && urlOverride)
    ? urlOverride
    : (!imgError ? resolveLogo(type, slug, logoMap) : null)

  const sizeClass = SIZE[size] ?? SIZE.md

  if (resolvedUrl) {
    return (
      <img
        src={resolvedUrl}
        alt={slug}
        className={cn(sizeClass, 'rounded-full object-cover flex-shrink-0', className)}
        onError={() => setImgError(true)}
      />
    )
  }

  // Initials avatar fallback
  return (
    <div
      className={cn(
        sizeClass,
        'rounded-full flex items-center justify-center font-bold flex-shrink-0 text-white select-none',
        getAvatarColor(slug),
        className,
      )}
    >
      {getInitials(slug)}
    </div>
  )
}
