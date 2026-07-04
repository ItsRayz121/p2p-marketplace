'use client'
import { useState } from 'react'
import { Share2, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { buildListingShareLinks, isTelegramMiniApp, openTelegramLink, hapticSelection } from '@/lib/telegram'

/**
 * Share a specific listing across every surface with ONE universal link.
 *
 * - Telegram Mini App → opens Telegram's share sheet for a `t.me/<bot>?startapp=…`
 *   deep link, so a tap on the shared link re-launches the Mini App straight to
 *   this listing.
 * - Web / installed app → the native Web Share sheet (navigator.share) with the
 *   canonical https URL; falls back to copying the link when Share isn't available.
 */
export function ShareListingButton({
  kind, id, title, text, className, compact = false,
}: {
  kind: 'usdt' | 'ctm'
  id: string
  title: string
  text: string
  className?: string
  compact?: boolean
}) {
  const [copied, setCopied] = useState(false)

  const handleShare = async () => {
    hapticSelection()
    const { web, telegram } = buildListingShareLinks(kind, id)

    // Inside Telegram: share the Mini App deep link so recipients land on the listing.
    if (isTelegramMiniApp()) {
      const shareUrl = telegram ?? web
      openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(text)}`)
      return
    }

    // Native share sheet (mobile browsers + installed app).
    const nav = typeof navigator !== 'undefined' ? navigator : undefined
    if (nav?.share) {
      try {
        await nav.share({ title, text, url: web })
        return
      } catch {
        // user dismissed, or share failed — fall through to copy
      }
    }

    // Fallback: copy the link.
    try {
      await navigator.clipboard.writeText(web)
      setCopied(true)
      toast.success('Link copied', 'Listing link copied to your clipboard')
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.info('Share this listing', web)
    }
  }

  if (compact) {
    return (
      <button
        type="button"
        onClick={handleShare}
        aria-label="Share listing"
        title="Share listing"
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
