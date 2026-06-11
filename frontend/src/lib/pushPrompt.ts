/**
 * Contextual push opt-in triggering.
 *
 * High-intent moments (e.g. entering an active trade) call promptPushOptIn();
 * PushOptInBanner listens for the event and shows immediately with copy
 * matched to the trigger, instead of waiting for the idle timer. The banner
 * still owns all gating (permission state, 30-day snooze), so callers can
 * fire this unconditionally.
 */
export type PushPromptTrigger = 'timer' | 'trade'

export const PUSH_PROMPT_EVENT = 'pakswap:push-prompt'

export function promptPushOptIn(trigger: Exclude<PushPromptTrigger, 'timer'>) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(PUSH_PROMPT_EVENT, { detail: { trigger } }))
}
