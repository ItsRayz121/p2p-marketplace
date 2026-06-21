/**
 * Shared address-format validation for P2P delivery destinations.
 *
 * This is a FORMAT (shape) check only — it does NOT touch the chain. Its job is to
 * stop obviously-invalid receiving destinations (random strings, wrong-network
 * formats) from being persisted on ads, trades, and the saved-address book.
 * On-chain truth for wallet deliveries is established later by
 * blockchainVerification.service when the seller submits a tx hash.
 *
 * Network/venue labels handled:
 *   - Wallet networks: BEP20 / ERC20 / POLYGON / ARBITRUM / OPTIMISM / BASE (EVM),
 *     APTOS, TRC20
 *   - Exchange venues (off-chain UID transfers): Binance / OKX / Bitget / Gate / MEXC
 */

export type AddressKind = 'evm' | 'aptos' | 'tron' | 'exchange_uid' | 'unknown'

const EVM_RE = /^0x[0-9a-fA-F]{40}$/
const APTOS_RE = /^0x[0-9a-fA-F]{1,64}$/
const TRON_RE = /^T[A-Za-z1-9]{33}$/
// Exchange UIDs are numeric account ids (Binance/OKX/Bitget/Gate/MEXC). 5–20 digits
// is wide enough for every venue while still rejecting random alphanumeric junk.
const EXCHANGE_UID_RE = /^[0-9]{5,20}$/

const KIND_BY_LABEL: Record<string, AddressKind> = {
  BEP20: 'evm', ERC20: 'evm', POLYGON: 'evm', ARBITRUM: 'evm', OPTIMISM: 'evm', BASE: 'evm',
  APTOS: 'aptos',
  TRC20: 'tron',
  BINANCE: 'exchange_uid', OKX: 'exchange_uid', BITGET: 'exchange_uid', GATE: 'exchange_uid', MEXC: 'exchange_uid',
}

/** Resolve the address kind for a network/venue label. 'unknown' = we can't assert a format. */
export function addressKindForNetwork(network: string): AddressKind {
  return KIND_BY_LABEL[(network ?? '').trim().toUpperCase()] ?? 'unknown'
}

export interface AddressValidationResult {
  valid: boolean
  reason?: string
}

/**
 * Validate a receiving address/UID against a network or exchange venue label.
 * Unknown labels are NOT blocked (we only require non-empty) so new venues don't
 * silently break — but every label we know about is strictly checked.
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
    case 'exchange_uid':
      return EXCHANGE_UID_RE.test(addr)
        ? { valid: true }
        : { valid: false, reason: `Enter a valid ${network} UID (numeric account id, 5–20 digits).` }
    default:
      return { valid: true }
  }
}
