'use client'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { useLogoRegistry } from '@/hooks/useLogoRegistry'
import { resolveLogoDbOnly, resolveLogoStatic, getAvatarColor, getInitials } from '@/lib/logoRegistry'
import type { EntityType, LogoMap } from '@/lib/logoRegistry'

// ── Size map ──────────────────────────────────────────────────────────────────

type SizeKey = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl'

const SIZE: Record<SizeKey, string> = {
  xs:   'w-4 h-4 text-[8px]',
  sm:   'w-6 h-6 text-[9px]',
  md:   'w-8 h-8 text-xs',
  lg:   'w-9 h-9 text-xs',
  xl:   'w-10 h-10 text-sm',
  '2xl': 'w-14 h-14 text-base',
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface EntityLogoProps {
  type:       EntityType
  slug:       string
  size?:      SizeKey
  className?: string
  /**
   * Pre-fetched logo URL from the caller's API data.
   * Tried first; falls back to registry/CDN if this URL 404s.
   */
  logoUrl?: string | null
}

// ── Component ─────────────────────────────────────────────────────────────────

export function EntityLogo({
  type, slug, size = 'md', className, logoUrl: urlOverride,
}: EntityLogoProps) {
  const logoMap = useLogoRegistry()
  // Track every URL that has failed — prevents infinite retry loops and
  // allows graceful degradation across all 4 tiers.
  const [failedUrls, setFailedUrls] = useState<Set<string>>(() => new Set())

  // Build a deduped, ordered candidate list:
  //   1. urlOverride (pre-fetched from caller's API data)
  //   2. DB-uploaded URL (from GasChainConfig / GasTokenConfig / CtmToken / LogoRegistry)
  //   3. Static CDN URL (TrustWallet open-source assets)
  // Each tier is tried independently so a broken DB URL still falls through to CDN.
  const dbUrl     = logoMap ? resolveLogoDbOnly(type, slug, logoMap as LogoMap) : null
  const staticUrl = resolveLogoStatic(type, slug)

  const seen = new Set<string>()
  const candidates: string[] = []
  for (const url of [urlOverride ?? null, dbUrl, staticUrl]) {
    if (url && !seen.has(url)) { seen.add(url); candidates.push(url) }
  }

  const resolvedUrl = candidates.find((url) => !failedUrls.has(url)) ?? null

  const sizeClass = SIZE[size]

  function handleImgError() {
    if (resolvedUrl) setFailedUrls((prev) => new Set([...prev, resolvedUrl!]))
  }

  if (resolvedUrl) {
    return (
      <img
        src={resolvedUrl}
        alt={slug}
        className={cn(sizeClass, 'rounded-full object-cover flex-shrink-0', className)}
        onError={handleImgError}
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
