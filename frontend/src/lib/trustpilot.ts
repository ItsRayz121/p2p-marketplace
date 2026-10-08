/**
 * Single source of truth for the Trustpilot review URL. Override with
 * NEXT_PUBLIC_TRUSTPILOT_URL; set it to "off" to disable Trustpilot surfaces.
 */
const ENV_URL = process.env.NEXT_PUBLIC_TRUSTPILOT_URL

export const TRUSTPILOT_URL: string | undefined =
  ENV_URL === 'off' ? undefined : (ENV_URL || 'https://www.trustpilot.com/evaluate/rupchain.com')

/** Neutral, editable draft an admin can review before sending. No reward, no positive-only ask. */
export function trustpilotRequestDraft(): string | null {
  if (!TRUSTPILOT_URL) return null
  return (
    'If you have a moment, we would appreciate an honest review of your RupChain experience on Trustpilot, whatever your feedback is: ' +
    TRUSTPILOT_URL
  )
}
