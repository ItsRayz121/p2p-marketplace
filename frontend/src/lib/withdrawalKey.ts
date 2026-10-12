/**
 * Idempotency key for a withdrawal submission: one stable session id plus a fingerprint of the exact
 * payload. The same payload re-sent after a dropped connection carries the SAME key (the server then
 * returns the first withdrawal instead of creating another); any change to coin, network, amount or
 * address produces a different key, so an edited request is never mistaken for the old one.
 *
 * Allowed by the server: 1-128 chars of letters, digits and . _ : -
 */
export function withdrawalIdempotencyKey(sessionId: string, parts: readonly string[]): string {
  // FNV-1a over the joined payload: tiny, deterministic, and good enough to tell payloads apart
  // (this is a de-dupe fingerprint, not a security boundary).
  const text = parts.map((p) => p.trim()).join('\u0001')
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `${sessionId}:${h.toString(36)}`
}
