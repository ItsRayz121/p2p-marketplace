'use client'
import { useState } from 'react'
import { Check } from 'lucide-react'
import { supportChatApi, type SupportMessage } from '@/lib/supportChat'
import { toast } from '@/lib/toast'

const ENV_URL = process.env.NEXT_PUBLIC_TRUSTPILOT_URL
const TRUSTPILOT_URL =
  ENV_URL === 'off' ? undefined : (ENV_URL || 'https://www.trustpilot.com/evaluate/rupchain.com')

function withStars(url: string, n: number): string {
  return `${url}${url.includes('?') ? '&' : '?'}stars=${n}`
}

/**
 * Renders a system `review_nudge` message as an inline Trustpilot star-picker,
 * matching the RefundAddressForm pattern. If the user has already acknowledged it
 * (a matching `review_ack` exists), shows a static "thanks" state instead — once
 * reviewed, this stops appearing on future trades entirely (server-side gate).
 */
export function ReviewNudgeCard({
  request,
  answer,
  onSubmitted,
}: {
  request: SupportMessage
  answer: SupportMessage | null
  onSubmitted: (msg: SupportMessage) => void
}) {
  const [submitting, setSubmitting] = useState(false)
  const [hover, setHover] = useState(0)
  const answeredStars = (answer?.metadata?.stars as number | undefined) ?? null

  async function pick(n: number) {
    if (submitting || !TRUSTPILOT_URL) return
    setSubmitting(true)
    try {
      window.open(withStars(TRUSTPILOT_URL, n), '_blank', 'noopener,noreferrer')
      const msg = await supportChatApi.reviewAck(request.id, n)
      onSubmitted(msg)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not record your review — please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="rounded-2xl border border-[#00b67a]/30 bg-[#00b67a]/[0.06] px-3 py-3 space-y-2">
      <div className="flex items-center gap-1.5 text-xs">
        <span className="inline-flex items-center gap-1 font-bold tracking-tight text-text-primary">
          <span className="text-sm leading-none text-[#00b67a]" aria-hidden>★</span>Trustpilot
        </span>
      </div>
      <p className="text-sm text-text-primary whitespace-pre-wrap break-words">{request.body}</p>

      {answeredStars ? (
        <div className="rounded-xl border border-success/30 bg-success/10 px-3 py-2 text-xs">
          <div className="flex items-center gap-1.5 text-success font-semibold mb-0.5">
            <Check className="w-3.5 h-3.5" /> Thanks for reviewing us!
          </div>
          <p className="text-text-muted">You rated RupChain {answeredStars}★ on Trustpilot.</p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <div
            className="flex gap-1"
            role="group"
            aria-label="Rate RupChain on Trustpilot, 1 to 5 stars"
            onMouseLeave={() => setHover(0)}
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                disabled={submitting}
                aria-label={`${n} ${n === 1 ? 'star' : 'stars'}`}
                onMouseEnter={() => setHover(n)}
                onFocus={() => setHover(n)}
                onClick={() => pick(n)}
                className={`grid h-[30px] w-[30px] place-items-center rounded-md border text-base transition-transform hover:-translate-y-px disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00b67a]/50 ${
                  n <= hover ? 'border-[#00b67a] bg-[#00b67a] text-white' : 'border-border bg-surface-alt text-text-muted'
                }`}
              >
                ★
              </button>
            ))}
          </div>
          <span className="text-[11px] italic text-text-muted">tap a star to open Trustpilot</span>
        </div>
      )}
    </div>
  )
}
