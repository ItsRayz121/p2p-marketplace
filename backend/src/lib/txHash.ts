/** An EVM transaction hash is 0x followed by exactly 64 hex characters. */
export function isWellFormedEvmTxHash(hash: string | null | undefined): boolean {
  return typeof hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hash)
}
