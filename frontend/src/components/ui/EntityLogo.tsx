'use client'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { useLogoRegistry } from '@/hooks/useLogoRegistry'
import { resolveLogoDbOnly, resolveLogoStatic, resolveLogoLocal, BANK_LOGO_LOCAL_GENERIC, getAvatarColor, getInitials } from '@/lib/logoRegistry'
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
  //   3. Local self-hosted SVG (/public) — guaranteed same-origin, never 404s
  //   4. Static CDN URL (TrustWallet / favicon services — reliable but external)
  // The local tier sits ahead of the external CDN so a flaky/blocked favicon
  // service can never collapse a known entity to the grey initials avatar.
  // Each tier is tried independently so a broken URL falls through to the next.
  const dbUrl     = logoMap ? resolveLogoDbOnly(type, slug, logoMap as LogoMap) : null
  const localUrl  = resolveLogoLocal(type, slug)
  const staticUrl = resolveLogoStatic(type, slug)

  // Generic bank glyph: last-resort same-origin fallback for banks only, applied
  // AFTER the external official-logo tier so a real bank favicon wins when it loads.
  const genericUrl = type === 'bank' ? BANK_LOGO_LOCAL_GENERIC : null

  const seen = new Set<string>()
  const candidates: string[] = []
  for (const url of [urlOverride ?? null, dbUrl, localUrl, staticUrl, genericUrl]) {
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
        // bg-white keeps logos with transparent/dark artwork visible on any
        // surface in both light and dark themes (safe container background).
        className={cn(sizeClass, 'rounded-full object-cover flex-shrink-0 bg-white ring-1 ring-black/5', className)}
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
