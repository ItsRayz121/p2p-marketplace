// posthog-js is a large bundle and analytics is never needed for first paint, so
// it is imported on demand: the first page load defers it until the browser is
// idle, and any event fired sooner (e.g. a signup) loads it immediately.
type PostHogClient = typeof import('posthog-js').default

let posthogReady: Promise<PostHogClient> | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null

function startPostHog(): Promise<PostHogClient> {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
  if (!posthogReady) {
    posthogReady = import('posthog-js').then((m) => {
      const ph = m.default
      ph.init(process.env.NEXT_PUBLIC_POSTHOG_KEY as string, {
        api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com',
        capture_pageview: true,
        autocapture: false,
        persistence: 'localStorage',
        disable_session_recording: true,
      })
      return ph
    })
  }
  return posthogReady
}

function withPostHog(fn: (ph: PostHogClient) => void) {
  if (typeof window === 'undefined' || !process.env.NEXT_PUBLIC_POSTHOG_KEY) return
  void startPostHog().then(fn).catch(() => { /* analytics must never break the app */ })
}

export function initPostHog() {
  if (typeof window === 'undefined') return
  if (!process.env.NEXT_PUBLIC_POSTHOG_KEY || posthogReady || idleTimer) return
  // Wait for the page to settle; fall back to a timer where idle callbacks don't exist.
  idleTimer = setTimeout(() => { idleTimer = null; void startPostHog().catch(() => {}) }, 3000)
}

export function identifyUser(userId: string, props?: Record<string, unknown>) {
  withPostHog((ph) => ph.identify(userId, props))
}

export function resetAnalyticsUser() {
  withPostHog((ph) => ph.reset())
}

function capture(event: string, props?: Record<string, unknown>) {
  withPostHog((ph) => ph.capture(event, props))
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

  pushNotificationSubscribed: (props?: { trigger: string }) =>
    capture('push_notification_subscribed', props),

  pushPromptShown: (props: { trigger: string }) => capture('push_prompt_shown', props),

  pushPromptDismissed: (props: { trigger: string }) => capture('push_prompt_dismissed', props),
} as const
