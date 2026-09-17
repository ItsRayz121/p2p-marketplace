// Shared system-chat copy reused by both the USDT and CTM completion paths so
// wording stays identical across trade.service.ts and ctm.trade.service.ts.
export const TRUSTPILOT_CHAT_NUDGE =
  '⭐ Enjoyed trading here? Please leave RupChain a review on Trustpilot — it takes 30 seconds and helps other traders in Pakistan find a platform they can trust.'

// Backend-side kill switch, mirroring the frontend TrustpilotPrompt's own
// NEXT_PUBLIC_TRUSTPILOT_URL="off" escape hatch. Without this the chat nudge
// had no way to be turned off short of a code change, even when an operator
// had already disabled the on-page prompt. Set TRUSTPILOT_CHAT_NUDGE_ENABLED=false
// on Railway to suppress it.
export const TRUSTPILOT_CHAT_NUDGE_ENABLED = process.env.TRUSTPILOT_CHAT_NUDGE_ENABLED !== 'false'
