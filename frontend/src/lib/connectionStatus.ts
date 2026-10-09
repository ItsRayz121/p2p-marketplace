// ─── App-wide connection status ──────────────────────────────────────────────
//
// Fed by resilientFetch in lib/api (every API call passes through it) and read by
// the ConnectionBanner. Three facts are tracked:
//
//   retrying — a request is being retried right now (the only time the UI may say
//              "Reconnecting…");
//   offline  — a request gave up without reaching the server;
//   server   — the server (or its gateway) answered 502/503/504.
//
// A later successful response clears the problem and fires RECONNECTED_EVENT so
// screens showing an error can refetch on their own. Nothing here reloads the page
// or replays a request: what the user is looking at and typing stays put.

export type ConnectionState = 'ok' | 'retrying' | 'offline' | 'server'
export const RECONNECTED_EVENT = 'rupchain:reconnected'

let retrying = 0
let problem: 'offline' | 'server' | null = null
let current: ConnectionState = 'ok'
const listeners = new Set<(s: ConnectionState) => void>()

function emit(): void {
  const next: ConnectionState = retrying > 0 ? 'retrying' : problem ?? 'ok'
  if (next === current) return
  current = next
  listeners.forEach((fn) => fn(next))
}

export function getConnectionState(): ConnectionState {
  return current
}

export function subscribeConnection(fn: (s: ConnectionState) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function beginRetry(): void {
  retrying += 1
  emit()
}

export function endRetry(): void {
  retrying = Math.max(0, retrying - 1)
  emit()
}

export function reportConnectionFailure(kind: 'offline' | 'server'): void {
  problem = kind
  emit()
}

export function reportConnectionSuccess(): void {
  if (!problem) return
  problem = null
  emit()
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(RECONNECTED_EVENT))
}
