/**
 * Network-aware block-explorer links. Lets the UI turn a tx hash or address into
 * a clickable "view on explorer" link so users can independently verify a
 * transfer on-chain — the manual fallback when our node can't auto-verify
 * (Aptos, exchange-UID delivery, or a momentarily busy RPC).
 */

const TX_PATH: Record<string, (h: string) => string> = {
  BEP20: (h) => `https://bscscan.com/tx/${h}`,
  ERC20: (h) => `https://etherscan.io/tx/${h}`,
  POLYGON: (h) => `https://polygonscan.com/tx/${h}`,
  ARBITRUM: (h) => `https://arbiscan.io/tx/${h}`,
  OPTIMISM: (h) => `https://optimistic.etherscan.io/tx/${h}`,
  BASE: (h) => `https://basescan.org/tx/${h}`,
  TRC20: (h) => `https://tronscan.org/#/transaction/${h}`,
  APTOS: (h) => `https://explorer.aptoslabs.com/txn/${h}?network=mainnet`,
}

const ADDRESS_PATH: Record<string, (a: string) => string> = {
  BEP20: (a) => `https://bscscan.com/address/${a}`,
  ERC20: (a) => `https://etherscan.io/address/${a}`,
  POLYGON: (a) => `https://polygonscan.com/address/${a}`,
  ARBITRUM: (a) => `https://arbiscan.io/address/${a}`,
  OPTIMISM: (a) => `https://optimistic.etherscan.io/address/${a}`,
  BASE: (a) => `https://basescan.org/address/${a}`,
  TRC20: (a) => `https://tronscan.org/#/address/${a}`,
  APTOS: (a) => `https://explorer.aptoslabs.com/account/${a}?network=mainnet`,
}

const EXPLORER_NAME: Record<string, string> = {
  BEP20: 'BscScan', ERC20: 'Etherscan', POLYGON: 'PolygonScan',
  ARBITRUM: 'Arbiscan', OPTIMISM: 'Etherscan', BASE: 'BaseScan',
  TRC20: 'Tronscan', APTOS: 'Aptos Explorer',
}

const norm = (n: string) => (n ?? '').trim().toUpperCase()

export function explorerTxUrl(network: string, txHash: string): string | null {
  const fn = TX_PATH[norm(network)] as ((h: string) => string) | undefined
  const h = (txHash ?? '').trim()
  return fn && h ? fn(h) : null
}

export function explorerAddressUrl(network: string, address: string): string | null {
  const fn = ADDRESS_PATH[norm(network)] as ((a: string) => string) | undefined
  const a = (address ?? '').trim()
  return fn && a ? fn(a) : null
}

export function explorerName(network: string): string {
  return EXPLORER_NAME[norm(network)] ?? 'block explorer'
}
