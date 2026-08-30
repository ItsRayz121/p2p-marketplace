'use client'
import { useEffect, useState } from 'react'
import { X } from 'lucide-react'

// Public Trustpilot "write a review" page for rupchain.com. The domain is
// claimed/verified, so this is stable — the env var only exists as an override
// (e.g. to point at a locale-specific evaluate URL, or set it to "off" to hide
// the nudge entirely).
const ENV_URL = process.env.NEXT_PUBLIC_TRUSTPILOT_URL
const TRUSTPILOT_URL =
  ENV_URL === 'off' ? undefined : (ENV_URL || 'https://www.trustpilot.com/evaluate/rupchain.com')

const DISMISS_KEY = 'rc_review_prompt_at'
// Once per browser per ~75 days (middle of the 60–90 day window). Whether the
// user picks a star (clicks through) or dismisses, we don't ask again for this long.
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

// Trustpilot's evaluate page opens the review composer pre-set to the given
// score when passed ?stars=N, so a tap on an inline star already starts the
// review — a far stronger nudge than a bare "write a review" button.
function withStars(url: string, n: number): string {
  return `${url}${url.includes('?') ? '&' : '?'}stars=${n}`
}

const CAPTION: Record<'gas' | 'trade', string> = {
  trade:
    'Takes 30 seconds · sign in with Google · your review helps other traders in Pakistan pick a platform they can trust.',
  gas:
    'Gas landed in your wallet. A 30-second public review · Google sign-in · helps other people top up with confidence.',
}

/**
 * Compact "rate us publicly" nudge for the happy path only — a completed gas
 * order, or a completed trade. It sits as a peer *below* the in-app counterparty
 * rating and never replaces it: the in-app rating is the trust engine
 * (counterparty scores, dispute weighting, maker reputation); this is purely a
 * review-acquisition ask.
 *
 * Rules baked in:
 *   - Points at the verified rupchain.com Trustpilot page; set
 *     NEXT_PUBLIC_TRUSTPILOT_URL="off" to hide it entirely.
 *   - Shown at most once per browser per ~75 days (localStorage timestamp).
 *   - Never gated or incentivised — no reward for reviewing (Trustpilot ToS).
 *   - Shown to everyone who reached completion, at any in-app score — we do not
 *     selectively invite only happy users (Trustpilot's guidelines prohibit it).
 *   - The caller only mounts this after genuine completion.
 */
export function TrustpilotPrompt({ surface }: { surface: 'gas' | 'trade' }) {
  const [visible, setVisible] = useState(false)
  const [committed, setCommitted] = useState(false)
  const [hover, setHover] = useState(0)

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

  const pick = (n: number) => {
    if (committed) return
    remember()
    setCommitted(true)
    window.open(withStars(TRUSTPILOT_URL, n), '_blank', 'noopener,noreferrer')
  }

  if (committed) {
    return (
      <div className="rounded-xl border border-[#00b67a]/30 bg-[#00b67a]/[0.06] px-3.5 py-3 text-left">
        <p className="flex items-center gap-1.5 text-[13px] font-semibold text-[#00b67a]">
          <span aria-hidden>✓</span> Opening Trustpilot — thank you
        </p>
        <p className="mt-1 text-[11.5px] leading-snug text-text-muted">
          You can still adjust your rating on Trustpilot before you post it.
        </p>
      </div>
    )
  }

  return (
    <div className="relative rounded-xl border border-[#00b67a]/30 bg-[#00b67a]/[0.06] px-3.5 pt-3 pb-3.5 text-left">
      <button
        type="button"
        onClick={close}
        aria-label="Not now"
        title="Not now"
        className="absolute right-2 top-2 grid h-[22px] w-[22px] place-items-center rounded-md text-text-muted transition-colors hover:bg-surface-alt hover:text-text-primary"
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>

      <div className="flex items-center gap-1.5 text-xs">
        <span className="inline-flex items-center gap-1 font-bold tracking-tight text-text-primary">
          <span className="text-sm leading-none text-[#00b67a]" aria-hidden>★</span>Trustpilot
        </span>
        <span className="rounded-full border border-[#00b67a]/40 px-1.5 py-px text-[9.5px] uppercase tracking-wide text-[#00b67a]">
          verified
        </span>
      </div>

      <p className="mt-1.5 pr-6 text-[13.5px] font-semibold text-text-primary">Rate RupChain publicly</p>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <div
          className="flex gap-1"
          role="group"
          aria-label="Rate RupChain on Trustpilot, 1 to 5 stars"
          onMouseLeave={() => setHover(0)}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHover(0)
          }}
        >
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              aria-label={`${n} ${n === 1 ? 'star' : 'stars'}`}
              onMouseEnter={() => setHover(n)}
              onFocus={() => setHover(n)}
              onClick={() => pick(n)}
              className={`grid h-[30px] w-[30px] place-items-center rounded-md border text-base transition-transform hover:-translate-y-px focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00b67a]/50 ${
                n <= hover
                  ? 'border-[#00b67a] bg-[#00b67a] text-white'
                  : 'border-border bg-surface-alt text-text-muted'
              }`}
            >
              ★
            </button>
          ))}
        </div>
        <span className="text-[11px] italic text-text-muted">tap a star to start</span>
      </div>

      <p className="mt-2 text-[11.5px] leading-snug text-text-muted">{CAPTION[surface]}</p>
    </div>
  )
}
