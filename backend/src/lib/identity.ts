/**
 * Canonical-identity helpers for non-custodial P2P.
 *
 * The user's legal name (from CNIC) is stored in User.fullName and used as the
 * trust anchor. It is revealed in full ONLY to a counterparty inside an active
 * trade (so they can match the payment account name). On public surfaces it must
 * be masked so we never leak a trader's full legal identity to the world.
 */

/**
 * Mask a legal name for public display, keeping the first letter of each word.
 * e.g. "Ahmed Raza Khan" -> "A**** R*** K***". Falls back to a generic label
 * when there is nothing to show.
 */
/** Normalize a name for comparison: lowercase, strip punctuation, collapse spaces. */
export function normalizeName(name: string | null | undefined): string {
  return (name ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Whether a payment-account name matches the holder's verified legal name.
 * Exact after normalization, OR the shorter name's tokens are all contained in
 * the longer one (tolerates an omitted middle name, e.g. "Ahmed Khan" vs
 * "Ahmed Raza Khan"). Used to block third-party-payment fraud.
 */
export function namesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeName(a)
  const nb = normalizeName(b)
  if (!na || !nb) return false
  if (na === nb) return true
  const ta = na.split(' ')
  const tb = nb.split(' ')
  const [shortTokens, longTokens] = ta.length <= tb.length ? [ta, tb] : [tb, ta]
  return shortTokens.every((t) => longTokens.includes(t))
}

export function maskName(name: string | null | undefined): string {
  const trimmed = (name ?? '').trim()
  if (!trimmed) return 'Verified user'
  return trimmed
    .split(/\s+/)
    .map((word) => {
      if (word.length <= 1) return word
      const stars = '*'.repeat(Math.min(Math.max(word.length - 1, 2), 4))
      return word[0] + stars
    })
    .join(' ')
}
