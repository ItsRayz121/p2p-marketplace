/**
 * Address-format validation for ON-CHAIN P2P delivery destinations only (client
 * mirror of backend/src/lib/addressValidation.ts). Shape check for real blockchain
 * addresses (BEP20/EVM, Aptos, TRC20) — gives instant green/red feedback before
 * submit. Backend re-validates on every write; this is purely UX.
 *
 * It deliberately does NOT enforce a format on internal / exchange transfers
 * (Binance, OKX, Bitget, Gate, MEXC): those have no canonical address, no tx hash,
 * and are justified by the transfer screenshot — so they resolve to 'unknown' and
 * any non-empty value is accepted. Use isValidatableNetwork() to decide whether to
 * show a validation indicator at all.
 */

export type AddressKind = 'evm' | 'aptos' | 'tron' | 'unknown'

const EVM_RE = /^0x[0-9a-fA-F]{40}$/
// Aptos account addresses are 32 bytes = exactly 64 hex chars. Require the full
// 64-char form so a 40-char EVM/BEP20 address can never pass as a valid Aptos one.
const APTOS_RE = /^0x[0-9a-fA-F]{64}$/
const TRON_RE = /^T[A-Za-z1-9]{33}$/

// Looks-like-a-wallet guard: reject an on-chain address pasted into an exchange UID field.
const LOOKS_LIKE_WALLET_RE = /^(0x[0-9a-fA-F]{20,}|T[A-Za-z1-9]{33})$/
const EXCHANGE_ACCOUNT_MAX = 64

const KIND_BY_LABEL: Record<string, AddressKind> = {
  BEP20: 'evm', ERC20: 'evm', POLYGON: 'evm', ARBITRUM: 'evm', OPTIMISM: 'evm', BASE: 'evm',
  APTOS: 'aptos',
  TRC20: 'tron',
}

export function addressKindForNetwork(network: string): AddressKind {
  return KIND_BY_LABEL[(network ?? '').trim().toUpperCase()] ?? 'unknown'
}

export interface AddressValidationResult {
  valid: boolean
  reason?: string
}

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
      // Exchange / internal transfer (or unknown): no on-chain format to enforce,
      // but reject a wallet address pasted as a UID (sanity guard).
      return validateExchangeAccount(addr)
  }
}

/**
 * Sanity-check an exchange / internal-transfer account identifier. No canonical
 * format exists, so this only rejects wallet-address-shaped values and absurd lengths.
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

/** True only for real blockchain networks we can shape-check. Exchange/internal → false. */
export function isValidatableNetwork(network: string): boolean {
  return addressKindForNetwork(network) !== 'unknown'
}

/** Canonical product label for a coin on a network, e.g. "USDT BEP20", "USDT Aptos". */
export function networkAssetLabel(network: string, coin = 'USDT'): string {
  return `${coin} ${network}`
}
