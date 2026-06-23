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
// Aptos account addresses are 32 bytes = exactly 64 hex chars. We REQUIRE the full
// 64-char form so a 40-char EVM/BEP20 address (which would otherwise fall inside a
// 1..64 range) can never masquerade as a valid Aptos address. Real Aptos wallet /
// deposit addresses are emitted in full 64-hex form (leading zeros preserved).
const APTOS_RE = /^0x[0-9a-fA-F]{64}$/
const TRON_RE = /^T[A-Za-z1-9]{33}$/

// Anything that looks like a real blockchain wallet address — used to reject a
// wallet address pasted into an EXCHANGE account/UID field (an exchange UID is a
// short account identifier, never a 0x… / T… on-chain address).
const LOOKS_LIKE_WALLET_RE = /^(0x[0-9a-fA-F]{20,}|T[A-Za-z1-9]{33})$/
// Generous upper bound for an exchange account/UID (covers numeric UIDs, emails,
// Pay-IDs) while still rejecting pasted on-chain addresses / junk.
const EXCHANGE_ACCOUNT_MAX = 64

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
        : { valid: false, reason: 'Enter a valid Aptos address — 0x followed by exactly 64 hex characters.' }
    case 'tron':
      return TRON_RE.test(addr)
        ? { valid: true }
        : { valid: false, reason: 'Enter a valid TRC20 address — starts with T, 34 characters.' }
    default:
      // Exchange / internal transfer (or unknown): there's no on-chain format to
      // enforce — the transfer screenshot is the proof. We still apply a light
      // sanity guard so a blockchain wallet address can't be pasted as a UID.
      return validateExchangeAccount(addr)
  }
}

/**
 * Sanity-check an exchange / internal-transfer account identifier (Binance UID,
 * OKX/Bitget/Gate/MEXC account, email, Pay-ID). There is no canonical format, so
 * this only rejects the two things that are clearly wrong: a value shaped like an
 * on-chain wallet address, and an absurdly long value.
 */
export function validateExchangeAccount(account: string): AddressValidationResult {
  const v = (account ?? '').trim()
  if (!v) return { valid: false, reason: 'Account / UID is required' }
  if (LOOKS_LIKE_WALLET_RE.test(v)) {
    return { valid: false, reason: 'That looks like a blockchain wallet address. Enter your exchange account ID / UID instead.' }
  }
  if (v.length > EXCHANGE_ACCOUNT_MAX) {
    return { valid: false, reason: `Exchange account / UID is too long (max ${EXCHANGE_ACCOUNT_MAX} characters).` }
  }
  return { valid: true }
}
