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
