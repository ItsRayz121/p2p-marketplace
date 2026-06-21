import { AppError } from '../lib/errors'

export interface TokenAddressShape {
  symbol: string
  addressRegex?: string | null
  addressExample?: string | null
}

/**
 * Guardrail: when an admin has configured an address pattern (`addressRegex`) for a
 * CTM token, the buyer's token receiving address must match it — so a wrong-chain or
 * junk value (e.g. a phone number where a Sidra/MEC address is expected) can't be
 * stored on a BUY listing or used at trade start.
 *
 * Scope: only ON-CHAIN wallet deliveries have a canonical address format. Email /
 * username deliveries carry an email or username in this field, so the blockchain
 * regex must NOT be applied to them. Legacy listings (no deliveryType recorded) keep
 * the check to preserve existing protection. A malformed regex fails open (skip).
 */
export function assertTokenAddressFormat(
  token: TokenAddressShape,
  address: string | null | undefined,
  deliveryType?: string | null,
): void {
  if (deliveryType && deliveryType !== 'blockchain') return
  const regex = token.addressRegex
  const addr = (address ?? '').trim()
  if (!regex || !addr) return

  let re: RegExp | null = null
  try { re = new RegExp(regex) } catch { re = null }
  if (re && !re.test(addr)) {
    const ex = token.addressExample
    throw new AppError(
      'VALIDATION_ERROR',
      `That doesn't look like a valid ${token.symbol} address.${ex ? ` Example: ${ex}` : ''}`,
      400,
    )
  }
}
