import posthog from 'posthog-js'

export function initPostHog() {
  if (typeof window === 'undefined') return
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY
  if (!key) return
  posthog.init(key, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com',
    capture_pageview: true,
    autocapture: false,
    persistence: 'localStorage',
    disable_session_recording: true,
  })
}

export function identifyUser(userId: string, props?: Record<string, unknown>) {
  if (typeof window === 'undefined') return
  posthog.identify(userId, props)
}

export function resetAnalyticsUser() {
  if (typeof window === 'undefined') return
  posthog.reset()
}

function capture(event: string, props?: Record<string, unknown>) {
  if (typeof window === 'undefined') return
  posthog.capture(event, props)
}

// ─── Funnel events (§27.8) ────────────────────────────────────────────────────

export const analytics = {
  /** Step 1 — user completes registration */
  userRegistered: () => capture('user_registered'),

  /** Step 2 — buyer creates a trade against an ad */
  tradeInitiated: (props: { tradeId: string; coin: string; amount: number; side: 'buy' | 'sell' }) =>
    capture('trade_initiated', props),

  /** Step 3 — buyer uploads payment proof */
  paymentProofUploaded: (props: { tradeId: string }) => capture('payment_proof_uploaded', props),

  /** Step 4 — seller confirms they received payment */
  paymentConfirmed: (props: { tradeId: string }) => capture('payment_confirmed', props),

  /** Step 5 — seller releases crypto (trade complete) */
  tradeCompleted: (props: { tradeId: string; amount: number; coin: string }) =>
    capture('trade_completed', props),

  /** Step 6 — user submits KYC documents */
  kycSubmitted: (props: { level: string }) => capture('kyc_submitted', props),

  // ─── Supporting events ──────────────────────────────────────────────────────

  adCreated: (props: { coin: string; side: 'buy' | 'sell'; paymentMethod: string }) =>
    capture('ad_created', props),

  pushNotificationSubscribed: () => capture('push_notification_subscribed'),
} as const
