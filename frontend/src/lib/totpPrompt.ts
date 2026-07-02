// A single, shared 2FA (TOTP) step-up prompt for the whole app.
//
// Why this exists: admin "save" actions fan out into several API calls at once
// (e.g. one PATCH per config field). Each one independently gets a 403
// TOTP_REQUIRED, and the old code called window.prompt() per request — so the
// user saw the same box 5–6 times. This module gives api.ts ONE prompt that all
// concurrent callers await, plus a short in-memory cache so back-to-back saves
// don't re-ask within a few minutes.

type Listener = () => void

let pending: Promise<string | null> | null = null
let resolveFn: ((v: string | null) => void) | null = null
let open = false
const listeners = new Set<Listener>()

function emit() {
  for (const l of listeners) l()
}

/** Subscribe to open/close changes (used by the modal via useSyncExternalStore). */
export function subscribeTotp(l: Listener): () => void {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

export function isTotpPromptOpen(): boolean {
  return open
}

/**
 * Request a 6-digit code from the user. Concurrent callers share the SAME
 * prompt — the box appears once and everyone resolves with the same result.
 * Resolves to the entered code, or null if the user cancelled.
 */
export function promptForTotp(): Promise<string | null> {
  if (pending) return pending
  pending = new Promise<string | null>((resolve) => { resolveFn = resolve })
  open = true
  emit()
  return pending
}

/** Called by the modal to finish the prompt (code on submit, null on cancel). */
export function resolveTotp(code: string | null): void {
  const r = resolveFn
  pending = null
  resolveFn = null
  open = false
  emit()
  r?.(code)
}
