/**
 * Gas-token contract-address guardrails.
 *
 * Wrong/placeholder token contract addresses entered through the admin UI were
 * the root cause of silent "read failed" balances and the risk of mis-delivery
 * (a non-native token order falling through to native delivery, or a transfer to
 * a non-token contract). These helpers let the token create/edit endpoints reject
 * malformed addresses up front and verify a real token lives at the address on
 * chain before it can be made delivery-live.
 *
 * Format validation is cheap and deterministic. The on-chain probe (decimals())
 * is authoritative: it catches well-formed but WRONG addresses (e.g. a Base USDC
 * address pasted into the Arbitrum row) that format checks can't.
 */

import { getHotWalletTokenBalance } from './gas.tokenBalance'

// Map a chain's stored addressType/chainType to a format family. Falls back to
// permissive when unknown so we never hard-block an exotic chain on format alone.
function family(addressType: string | null, chainType: string | null): string {
  const t = (addressType || chainType || '').toUpperCase()
  if (t === 'EVM') return 'EVM'
  if (t === 'TRC20' || t === 'TRON') return 'TRON'
  if (t === 'APTOS' || t === 'APT') return 'APTOS'
  if (t === 'SUI') return 'SUI'
  if (t === 'SOL' || t === 'SOLANA') return 'SOL'
  if (t === 'TON') return 'TON'
  return 'UNKNOWN'
}

/** True when `address` is syntactically valid for the chain's address family. */
export function addressFormatValid(
  addressType: string | null,
  chainType: string | null,
  address: string,
): boolean {
  const a = address.trim()
  switch (family(addressType, chainType)) {
    case 'EVM':   return /^0x[0-9a-fA-F]{40}$/.test(a)
    case 'TRON':  return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)
    case 'APTOS': return /^0x[0-9a-fA-F]{1,64}$/.test(a)
    case 'SUI':   return /^0x[0-9a-fA-F]{1,64}$/.test(a)
    case 'SOL':   return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)
    case 'TON':   return a.length > 0 // EQ…/UQ… or raw 0:hex — accept non-empty
    default:      return a.length > 0
  }
}

/** Human-readable expected format, for error messages. */
export function addressFormatHint(addressType: string | null, chainType: string | null): string {
  switch (family(addressType, chainType)) {
    case 'EVM':   return '0x followed by 40 hex characters'
    case 'TRON':  return 'a base58 address starting with T (34 chars)'
    case 'APTOS': return '0x followed by up to 64 hex characters (fungible-asset metadata)'
    case 'SUI':   return '0x followed by up to 64 hex characters'
    case 'SOL':   return 'a base58 mint address (32–44 chars)'
    default:      return 'a non-empty address'
  }
}

export interface TokenProbeResult {
  ok: boolean
  decimals: number | null
  error: string | null
}

/**
 * Verify a real token contract lives at `contract` on `dbChain` by reading its
 * balance/decimals for `owner` (any address works — balanceOf returns 0). A throw
 * (e.g. viem's "decimals returned no data (0x)") means there is no token there.
 */
export async function probeTokenContract(
  dbChain: string,
  contract: string,
  owner: string,
): Promise<TokenProbeResult> {
  try {
    const r = await getHotWalletTokenBalance(dbChain, contract, owner)
    return { ok: true, decimals: r.decimals, error: null }
  } catch (e) {
    return { ok: false, decimals: null, error: e instanceof Error ? e.message.slice(0, 200) : 'probe failed' }
  }
}
