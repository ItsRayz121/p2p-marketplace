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
// screens showing an error can refetch on their own. What counts as recovery
// depends on the problem: any answer from the API proves the connection is back
// ('reachable'), but a server problem — a gateway error or the database being
// unavailable — is only cleared by evidence that data is served again ('ready':
// a 2xx from a real API read, or the /health/ready check). The liveness ping
// touches no database and is never used as that evidence. Nothing here reloads the page
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

export type RecoveryEvidence = 'reachable' | 'ready'

/** Which problems a piece of evidence clears. Pure, so it can be tested. */
export function clearsProblem(p: 'offline' | 'server' | null, evidence: RecoveryEvidence): boolean {
  if (!p) return false
  return evidence === 'ready' || p === 'offline'
}

/**
 * What an answer from GET /health/ready proves.
 *   2xx  -> 'ready'     : the API and its database answer.
 *   404  -> 'reachable' : the API answered but has no readiness route (an older build,
 *                         e.g. the frontend went live first). Readiness is UNKNOWN, so
 *                         this clears only a connection problem, never a server one.
 *   else -> 'server'    : 503 DATABASE_UNAVAILABLE, a gateway error, etc.
 */
export function classifyReadiness(status: number): RecoveryEvidence | 'server' {
  if (status >= 200 && status < 300) return 'ready'
  if (status === 404) return 'reachable'
  return 'server'
}

export function reportConnectionSuccess(evidence: RecoveryEvidence = 'ready'): void {
  if (!clearsProblem(problem, evidence)) return
  problem = null
  emit()
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(RECONNECTED_EVENT))
}
