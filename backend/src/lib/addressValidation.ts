/**
 * Shared address-format validation for ON-CHAIN P2P delivery destinations only.
 *
 * IMPORTANT — scope: this validates the SHAPE of a real blockchain address
 * (BEP20/EVM, Aptos, TRC20). It does NOT — and must NOT — enforce a format on
 * internal / exchange transfers (Binance, OKX, Bitget, Gate, MEXC). Those move
 * account-to-account off-chain: there is no canonical address format (an account
 * may be a numeric UID, an email, a phone, a Pay-ID), no transaction hash, and
 * nothing to verify on-chain. Exchange/internal transfers are justified by the
 * transfer SCREENSHOT (payment proof), so this validator treats any non-blockchain
 * label as 'unknown' and accepts any non-empty value.
 *
 * It also does NOT touch the chain — on-chain truth for wallet deliveries is
 * established separately by blockchainVerification.service when the seller submits
 * a tx hash (and that path likewise skips exchange/screenshot deliveries).
 */

export type AddressKind = 'evm' | 'aptos' | 'tron' | 'unknown'

const EVM_RE = /^0x[0-9a-fA-F]{40}$/
const APTOS_RE = /^0x[0-9a-fA-F]{1,64}$/
const TRON_RE = /^T[A-Za-z1-9]{33}$/

// Only real on-chain networks are format-checked. Exchange venues are deliberately
// absent → they resolve to 'unknown' and are never enforced.
const KIND_BY_LABEL: Record<string, AddressKind> = {
  BEP20: 'evm', ERC20: 'evm', POLYGON: 'evm', ARBITRUM: 'evm', OPTIMISM: 'evm', BASE: 'evm',
  APTOS: 'aptos',
  TRC20: 'tron',
}

/** Resolve the address kind for a network/venue label. 'unknown' = not a blockchain address → no format enforcement. */
export function addressKindForNetwork(network: string): AddressKind {
  return KIND_BY_LABEL[(network ?? '').trim().toUpperCase()] ?? 'unknown'
}

export interface AddressValidationResult {
  valid: boolean
  reason?: string
}

/**
 * Validate a receiving address against a network label. Blockchain networks are
 * strictly shape-checked; every other label (exchange/internal transfer, or an
 * unrecognised one) is accepted as long as it's non-empty.
 */
export function validateAddressForNetwork(address: string, network: string): AddressValidationResult {
  const addr = (address ?? '').trim()
  if (!addr) return { valid: false, reason: 'Receiving address is required' }

  switch (addressKindForNetwork(network)) {
    case 'evm':
      return EVM_RE.test(addr)
        ? { valid: true }
        : { valid: false, reason: `Enter a valid ${network} address — 0x followed by 40 hex characters.` }
    case 'aptos':
      return APTOS_RE.test(addr)
        ? { valid: true }
        : { valid: false, reason: 'Enter a valid Aptos address — 0x followed by up to 64 hex characters.' }
    case 'tron':
      return TRON_RE.test(addr)
        ? { valid: true }
        : { valid: false, reason: 'Enter a valid TRC20 address — starts with T, 34 characters.' }
    default:
      // Exchange / internal transfer (or unknown): no on-chain format to enforce —
      // the transfer screenshot is the proof. Accept any non-empty value.
      return { valid: true }
  }
}
