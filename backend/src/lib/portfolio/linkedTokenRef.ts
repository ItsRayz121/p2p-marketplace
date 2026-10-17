import { createHmac } from 'node:crypto'
import { env } from '../env'

/**
 * An opaque, stable reference to a RupChain token for use inside a portfolio backup.
 *
 * A backup must never carry the platform's own token id, but a restore needs to put entries back on the
 * right RupChain-linked token. This is a keyed hash of the id: it identifies the token to the server that
 * made it (which recomputes it for every token and matches), and tells anyone else nothing. The same token
 * always gives the same reference, so a backup stays restorable. If the key were ever rotated, old
 * references would stop matching and those entries would simply be reported as not restored.
 */
export function linkedTokenRef(ctmTokenId: string): string {
  return createHmac('sha256', env.CNIC_HASH_SECRET).update(`rupchain-portfolio-linked-token:v1:${ctmTokenId}`).digest('hex').slice(0, 32)
}
