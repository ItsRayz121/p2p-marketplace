'use client'
import { useState } from 'react'
import { Share2, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { useAuth } from '@/hooks/useAuth'
import { buildGasShareLinks, isTelegramMiniApp, openTelegramLink, hapticSelection } from '@/lib/telegram'

/**
 * Share one blockchain's gas fee — optionally scoped to a single token on that
 * chain — with ONE universal link. Same surfaces as ShareListingButton:
 *
 * - Telegram Mini App → Telegram's share sheet for a `t.me/<bot>?startapp=G_…`
 *   deep link; a tap re-launches the Mini App straight to /gas with the chain
 *   (and token) pre-selected.
 * - Web / installed app → the native Web Share sheet with the canonical https
 *   URL (rich preview); falls back to copying the link.
 *
 * The sharer's referral code rides along so the link doubles as a referral link.
 */
export function ShareGasButton({
  chainSlug, chainName, tokenSymbol, tokenName, priceUsd, className, compact = false,
}: {
  chainSlug: string
  chainName: string
  tokenSymbol?: string | null
  tokenName?: string | null
  /** Live token price in USD — folded into the share caption when present. */
  priceUsd?: number | null
  className?: string
  compact?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const { user } = useAuth()

  const scoped = !!tokenSymbol
  const title = scoped
    ? `${tokenSymbol} gas on ${chainName} — RupChain`
    : `${chainName} gas fees — RupChain`
  const priceBit = scoped && priceUsd && priceUsd > 0 ? ` (~$${priceUsd.toFixed(4)}/${tokenSymbol})` : ''
  const text = scoped
    ? `Top up ${tokenName ?? tokenSymbol} gas on ${chainName}${priceBit} in seconds — pay with JazzCash, Easypaisa or USDT on RupChain.`
    : `Buy ${chainName} gas fees instantly on RupChain — pay with JazzCash, Easypaisa or USDT.`

  const handleShare = async () => {
    hapticSelection()
    const { web, telegram } = buildGasShareLinks(chainSlug, tokenSymbol ?? undefined, user?.referralCode)

    // Inside Telegram: share the Mini App deep link so recipients land on /gas.
    if (isTelegramMiniApp()) {
      const shareUrl = telegram ?? web
      openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(text)}`)
      return
    }

    // Web / desktop → the canonical https URL (normal tab + rich preview).
    const primary = web

    const nav = typeof navigator !== 'undefined' ? navigator : undefined
    if (nav?.share) {
      try {
        await nav.share({ title, text, url: primary })
        return
      } catch {
        // user dismissed, or share failed — fall through to copy
      }
    }

    try {
      await navigator.clipboard.writeText(primary)
      setCopied(true)
      toast.success('Link copied', 'Gas link copied to your clipboard')
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.info('Share this gas link', primary)
    }
  }

  if (compact) {
    return (
      <button
        type="button"
        onClick={handleShare}
        aria-label="Share gas link"
        title="Share gas link"
        className={cn('p-2 rounded-lg text-text-muted hover:text-primary hover:bg-surface-alt transition-colors', className)}
      >
        {copied ? <Check size={18} /> : <Share2 size={18} />}
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={handleShare}
      className={cn(
        'inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border bg-surface text-sm font-medium text-text-primary hover:border-primary/50 hover:text-primary transition-colors',
        className,
      )}
    >
      {copied ? <Check size={16} /> : <Share2 size={16} />}
      {copied ? 'Copied' : 'Share'}
    </button>
  )
}
