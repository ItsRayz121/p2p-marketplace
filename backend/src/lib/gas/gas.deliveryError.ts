// Delivery-failure classifier — turns raw provider/RPC noise ("Request failed
// with status code 500", axios/network errors) into an actionable code + reason
// + recommended action, keeping a truncated raw tail for forensics.
//
// Kept dependency-free (no chain/wallet imports) so it can be unit-tested in
// isolation and reused anywhere.

export interface NormalizedDeliveryError {
  code: string
  reason: string
  action: string
  /** Single-line string suitable for GasFeeOrder.failureReason. */
  message: string
}

export function describeDeliveryError(chain: string, err: unknown): NormalizedDeliveryError {
  const code = (err as { code?: string })?.code
  const raw = err instanceof Error ? err.message : String(err)
  const rawTail = raw.length > 200 ? raw.slice(0, 200) + '…' : raw
  const lower = raw.toLowerCase()

  const build = (c: string, reason: string, action: string): NormalizedDeliveryError => ({
    code: c, reason, action,
    message: `[${c}] ${reason} — ${action} (raw: ${rawTail})`,
  })

  if (code === 'INSUFFICIENT_HOT_WALLET_BALANCE' || /insufficient.*balance|not enough/.test(lower)) {
    return build('INSUFFICIENT_HOT_WALLET_BALANCE', `Hot wallet has insufficient ${chain} balance to deliver`, `Refill the ${chain} hot wallet, then retry`)
  }
  if (/seed|mnemonic|gas_seed|gas_master_key|decryptgasseed|key not|not configured|missing.*key/.test(lower)) {
    return build('WALLET_NOT_CONFIGURED', `Signing key/mnemonic unavailable for ${chain}`, 'Verify GAS_MASTER_KEY / GAS_SEED_CIPHERTEXT are set, then retry')
  }
  if (/invalid address|bad address|checksum|invalid recipient|malformed|invalid base58|invalid bech32|wrong.*address|address.*invalid/.test(lower)) {
    return build('INVALID_RECIPIENT', `Recipient address is invalid for ${chain}`, 'Confirm the delivery address; refund if the user mistyped it')
  }
  if (/unsupported chain|delivery not implemented|no.*route|unsupported/.test(lower)) {
    return build('UNSUPPORTED_ROUTE', `Delivery route not supported for ${chain}`, 'Disable this chain or implement its delivery path')
  }
  if (/status code 429|too many requests|rate.?limit/.test(lower)) {
    return build('PROVIDER_RATE_LIMITED', `${chain} RPC/provider rate-limited the request`, 'Add/upgrade an API key or dedicated RPC, then retry')
  }
  if (/status code 5\d\d|http 5\d\d|\b50[023]\b|bad gateway|service unavailable|gateway timeout/.test(lower)) {
    return build('PROVIDER_ERROR', `${chain} RPC/provider returned a server error (5xx)`, 'Check the RPC/provider (e.g. toncenter, TronGrid) status & API key, then retry')
  }
  if (/timeout|timed out|etimedout|econnreset|econnrefused|enotfound|fetch failed|network|socket hang up|aborted/.test(lower)) {
    return build('PROVIDER_TIMEOUT', `${chain} RPC/provider was unreachable or timed out`, 'Check network/RPC endpoint health, then retry')
  }
  if (/nonce|replacement|underpriced|already known|mempool/.test(lower)) {
    return build('TX_BROADCAST_CONFLICT', `${chain} transaction broadcast conflict (nonce/mempool)`, 'Usually transient — retry; if persistent, check pending hot-wallet txs')
  }
  return build('DELIVERY_ERROR', `${chain} delivery failed`, 'Inspect the raw error; retry or refund')
}
