'use client'
import { useEffect, useRef } from 'react'

// rupchain.com — verified Trustpilot business unit.
const BUSINESS_UNIT_ID = '6a93bec893a7a59a46a48fa2'
const REVIEW_URL = 'https://www.trustpilot.com/review/rupchain.com'

/** Template + token pairs from Trustpilot's widget catalogue. */
export const TRUSTBOX = {
  reviewCollector: {
    templateId: '56278e9abfbbba0bdcd568bc',
    token: 'b35f09dd-bc34-4689-9de9-fca1a9608ab6',
    height: '52px',
  },
  microStar: { templateId: '5419b6ffb0d04a076446a9af', token: undefined, height: '24px' },
  microReviewCount: { templateId: '5419b6a8b0d04a076446a9ad', token: undefined, height: '20px' },
} as const

declare global {
  interface Window {
    Trustpilot?: {
      loadFromElement: (el: HTMLElement | null, forceReload?: boolean) => void
    }
  }
}

type Props = {
  /** Which catalogue widget to render. Defaults to the Review Collector CTA. */
  variant?: keyof typeof TRUSTBOX
  height?: string
  width?: string
  theme?: 'light' | 'dark'
  className?: string
}

/**
 * Trustpilot TrustBox widget. The bootstrap script is loaded once in the root
 * layout; on mount we ask it to hydrate this element so the widget also renders
 * after client-side navigation (the bootstrap only auto-scans on first load).
 *
 * With zero published reviews only `reviewCollector` shows anything meaningful —
 * the rating widgets stay blank until the first review lands, then populate.
 */
export function TrustBox({
  variant = 'reviewCollector',
  height,
  width = '100%',
  theme = 'light',
  className,
}: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const cfg = TRUSTBOX[variant]

  useEffect(() => {
    let tries = 0
    const timer = setInterval(() => {
      tries += 1
      if (window.Trustpilot && ref.current) {
        window.Trustpilot.loadFromElement(ref.current, true)
        clearInterval(timer)
      } else if (tries > 40) {
        clearInterval(timer) // ~10s: script blocked or offline — leave the fallback link
      }
    }, 250)
    return () => clearInterval(timer)
  }, [variant])

  return (
    <div
      ref={ref}
      className={`trustpilot-widget ${className ?? ''}`}
      data-locale="en-US"
      data-template-id={cfg.templateId}
      data-businessunit-id={BUSINESS_UNIT_ID}
      data-style-height={height ?? cfg.height}
      data-style-width={width}
      data-theme={theme}
      {...(cfg.token ? { 'data-token': cfg.token } : {})}
    >
      {/* Fallback shown only pre-hydration or if the script is blocked — Trustpilot
          replaces the widget's inner content once it loads. Styled so a brief
          flash still looks intentional. */}
      <a
        href={REVIEW_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-xs font-medium text-text-muted hover:text-text-primary transition-colors"
      >
        Review us on Trustpilot
      </a>
    </div>
  )
}
