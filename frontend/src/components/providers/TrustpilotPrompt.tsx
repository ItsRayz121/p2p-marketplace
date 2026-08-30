'use client'
import { useEffect, useState } from 'react'
import { Star, X } from 'lucide-react'

// Public Trustpilot "write a review" page for rupchain.com. The domain is
// claimed/verified, so this is stable — the env var only exists as an override
// (e.g. to point at a locale-specific evaluate URL, or set it to "off" to hide
// the nudge entirely).
const ENV_URL = process.env.NEXT_PUBLIC_TRUSTPILOT_URL
const TRUSTPILOT_URL =
  ENV_URL === 'off' ? undefined : (ENV_URL || 'https://www.trustpilot.com/evaluate/rupchain.com')

const DISMISS_KEY = 'rc_review_prompt_at'
// Once per browser per ~75 days (middle of the 60–90 day window). Whether the
// user clicks through or dismisses, we don't ask again for this long.
const SNOOZE_MS = 75 * 24 * 60 * 60 * 1000

function recentlyPrompted(): boolean {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY) ?? '0')
    return at > 0 && Date.now() - at < SNOOZE_MS
  } catch {
    return false
  }
}

function remember(): void {
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now()))
  } catch {
    /* private mode / storage disabled — the in-session state still hides it */
  }
}

/**
 * Lightweight, one-time "leave us a review" nudge for the happy path only — a
 * completed gas order, or a trade the user just rated 4–5★. It sits alongside
 * the in-app rating and never replaces it: the in-app rating is the trust engine
 * (counterparty scores, dispute weighting, maker reputation); this is just a
 * review-acquisition ask.
 *
 * Rules baked in:
 *   - Points at the verified rupchain.com Trustpilot page; set
 *     NEXT_PUBLIC_TRUSTPILOT_URL="off" to hide it entirely.
 *   - Shown at most once per browser per ~75 days (localStorage timestamp).
 *   - Never gated or incentivised — no reward for reviewing (Trustpilot ToS).
 *   - The caller is responsible for only mounting this on a positive signal.
 */
export function TrustpilotPrompt({ surface }: { surface: 'gas' | 'trade' }) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!TRUSTPILOT_URL) return
    if (recentlyPrompted()) return
    setVisible(true)
  }, [])

  if (!TRUSTPILOT_URL || !visible) return null

  const close = () => {
    remember()
    setVisible(false)
  }

  const review = () => {
    remember()
    window.open(TRUSTPILOT_URL, '_blank', 'noopener,noreferrer')
    setVisible(false)
  }

  return (
    <div className="relative rounded-xl border border-border bg-surface-alt p-4 text-left">
      <button
        onClick={close}
        aria-label="Dismiss"
        className="absolute top-2.5 right-2.5 text-text-muted hover:text-text-primary"
      >
        <X className="w-4 h-4" />
      </button>
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-9 h-9 rounded-full bg-[#00b67a]/10 flex items-center justify-center">
          <Star className="w-5 h-5 text-[#00b67a] fill-[#00b67a]" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-text-primary">
            {surface === 'gas'
              ? 'Gas delivered — mind leaving a review?'
              : 'Glad that went smoothly — mind leaving a review?'}
          </p>
          <p className="text-xs text-text-muted mt-0.5">
            A quick word on Trustpilot helps other people trade with confidence. Takes about a minute.
          </p>
          <div className="flex flex-wrap gap-2 mt-3">
            <button
              onClick={review}
              className="px-3 py-1.5 bg-[#00b67a] text-white text-xs font-semibold rounded-lg hover:bg-[#00a56e] transition-colors"
            >
              Review on Trustpilot
            </button>
            <button
              onClick={close}
              className="px-3 py-1.5 border border-border text-text-secondary text-xs font-medium rounded-lg hover:bg-surface transition-colors"
            >
              Maybe later
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
