/**
 * Pure rules deciding whether an EARLIER delivery broadcast can still pay the customer.
 * No I/O and no imports, so it is fully unit-testable. The strict policy built on top:
 *
 *   An order may be paid again ONLY when every earlier attempt is PROVEN dead.
 *   "Not seen yet" is never proof — the only proofs are:
 *     • the tx was mined and reverted (it executed and moved nothing), or
 *     • EVM: the sender's nonce was consumed by a different tx while ours has no receipt, or
 *     • non-EVM: the tx is unknown to the chain long after its hard expiry window.
 */

export type PriorAttemptVerdict =
  | 'none'        // nothing was ever journaled/broadcast for this order — safe to send
  | 'landed'      // the earlier tx IS on-chain and succeeded — adopt it, never resend/refund
  | 'dead'        // provably can never land — a new attempt is allowed (manual decision)
  | 'unresolved'  // cannot be ruled out — no resend, no refund

export type ObservedTxState = 'success' | 'reverted' | 'mempool' | 'not_found' | 'unreachable'

/** Chains whose txs carry a hard validity window (blockhash / expiration) far shorter than this. */
export const EXPIRY_PROOF_AFTER_MS = 15 * 60_000

const EXPIRING_CHAINS = new Set(['SOL', 'TRON', 'APT', 'SUI'])

export function classifyPriorAttempt(input: {
  hasAttempt: boolean
  chain: string
  evm: boolean
  state: ObservedTxState
  /** EVM: the nonce journaled before broadcast. */
  nonce: number | null
  /** EVM: sender's CONFIRMED ('latest') tx count, read BEFORE the status lookup. null if unreadable. */
  senderConfirmedCount: number | null
  attemptAgeMs: number | null
}): PriorAttemptVerdict {
  if (!input.hasAttempt) return 'none'
  if (input.state === 'success') return 'landed'
  if (input.state === 'reverted') return 'dead'
  if (input.state === 'unreachable') return 'unresolved'

  // not_found | mempool — only a positive proof makes it dead.
  if (input.evm) {
    if (input.nonce !== null && input.senderConfirmedCount !== null && input.senderConfirmedCount > input.nonce) {
      return 'dead' // nonce already used by another tx and ours has no receipt anywhere
    }
    return 'unresolved'
  }
  if (
    input.state === 'not_found'
    && EXPIRING_CHAINS.has(input.chain)
    && input.attemptAgeMs !== null
    && input.attemptAgeMs >= EXPIRY_PROOF_AFTER_MS
  ) {
    return 'dead'
  }
  return 'unresolved'
}

/** Human-readable explanation for admins. */
export function describePriorAttempt(v: PriorAttemptVerdict, txHash?: string | null): string {
  const h = txHash ? ` ${txHash}` : ''
  switch (v) {
    case 'none': return 'No earlier delivery attempt.'
    case 'landed': return `The earlier delivery transaction${h} actually landed on-chain.`
    case 'dead': return `The earlier delivery transaction${h} is proven unable to land.`
    case 'unresolved': return `The earlier delivery transaction${h} cannot be ruled out yet (it may still land). Resending or refunding now could pay the customer twice.`
  }
}

/**
 * Chains where a pre-broadcast journal exists (so a failure BEFORE the journal is provably a
 * no-send). On other chains an error can hide an accepted broadcast, so ANY failure there
 * goes straight to manual review instead of an automatic retry.
 */
const JOURNALED_CHAINS = new Set(['ETH', 'BSC', 'OPBNB', 'BASE', 'ARB', 'OP', 'MATIC', 'AVAX', 'SOL'])
export function supportsAttemptJournal(chain: string): boolean {
  return JOURNALED_CHAINS.has(chain)
}
