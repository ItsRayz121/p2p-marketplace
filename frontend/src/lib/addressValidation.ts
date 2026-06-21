/**
 * Shared address-format validation for P2P delivery destinations (client mirror of
 * backend/src/lib/addressValidation.ts). Format/shape check only — gives buyers and
 * sellers instant green/red feedback before they submit an address. The backend
 * re-validates on every write; this is purely UX.
 */

export type AddressKind = 'evm' | 'aptos' | 'tron' | 'exchange_uid' | 'unknown'

const EVM_RE = /^0x[0-9a-fA-F]{40}$/
const APTOS_RE = /^0x[0-9a-fA-F]{1,64}$/
const TRON_RE = /^T[A-Za-z1-9]{33}$/
const EXCHANGE_UID_RE = /^[0-9]{5,20}$/

const KIND_BY_LABEL: Record<string, AddressKind> = {
  BEP20: 'evm', ERC20: 'evm', POLYGON: 'evm', ARBITRUM: 'evm', OPTIMISM: 'evm', BASE: 'evm',
  APTOS: 'aptos',
  TRC20: 'tron',
  BINANCE: 'exchange_uid', OKX: 'exchange_uid', BITGET: 'exchange_uid', GATE: 'exchange_uid', MEXC: 'exchange_uid',
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
        : { valid: false, reason: 'Enter a valid Aptos address — 0x followed by up to 64 hex characters.' }
    case 'tron':
      return TRON_RE.test(addr)
        ? { valid: true }
        : { valid: false, reason: 'Enter a valid TRC20 address — starts with T, 34 characters.' }
    case 'exchange_uid':
      return EXCHANGE_UID_RE.test(addr)
        ? { valid: true }
        : { valid: false, reason: `Enter a valid ${network} UID (numeric account id, 5–20 digits).` }
    default:
      return { valid: true }
  }
}

/** Is this label one we can format-check (vs an unknown/free-form destination)? */
export function isValidatableNetwork(network: string): boolean {
  return addressKindForNetwork(network) !== 'unknown'
}

/** Canonical product label for a coin on a network, e.g. "USDT BEP20", "USDT Aptos". */
export function networkAssetLabel(network: string, coin = 'USDT'): string {
  return `${coin} ${network}`
}
