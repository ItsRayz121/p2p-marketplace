/**
 * Pure (I/O-free) helpers for the unified Deposits & Withdrawals view. Kept apart from
 * walletTransactions.ts so the status mapping and paging logic are unit-testable.
 */

export type TxDirection = 'in' | 'out'
export type TxStatusGroup = 'completed' | 'pending' | 'on_hold' | 'failed'
export type TxSource = 'onchain' | 'auto' | 'manual'

// Withdrawal.network label → canonical chain id used by Deposit.chain.
export const NETWORK_TO_CHAIN: Record<string, string> = {
  TRC20: 'tron', BEP20: 'bsc', ERC20: 'ethereum', BASE: 'base',
  ARBITRUM: 'arbitrum', OPTIMISM: 'optimism', POLYGON: 'polygon', APTOS: 'aptos',
}
export const CHAIN_TO_NETWORKS = Object.entries(NETWORK_TO_CHAIN).reduce<Record<string, string[]>>((acc, [n, c]) => {
  (acc[c] ??= []).push(n)
  return acc
}, {})

export function chainForWithdrawalNetwork(network: string): string {
  return NETWORK_TO_CHAIN[network.toUpperCase()] ?? network.toLowerCase()
}

export const DEPOSIT_STATUS: Record<string, TxStatusGroup> = { credited: 'completed', detected: 'pending', rejected: 'failed' }

export function depositStatusGroup(status: string): TxStatusGroup {
  return DEPOSIT_STATUS[status] ?? 'pending'
}

export function withdrawalStatusGroup(status: string, txHash: string | null): TxStatusGroup {
  if (status === 'sent' || status === 'completed') return 'completed'
  if (status === 'auto_approved') return txHash ? 'completed' : 'pending'
  if (status === 'on_hold') return 'on_hold'
  if (status === 'rejected' || status === 'cancelled') return 'failed'
  return 'pending'
}

export interface TxRow {
  key: string
  kind: 'deposit' | 'withdrawal'
  direction: TxDirection
  id: string
  ref: string | null
  chain: string
  network: string | null
  asset: string
  amount: string
  amountUsd: string | null
  txHash: string | null
  address: string | null
  user: { id: string; username: string | null; email: string | null } | null
  relatedOrder: string | null
  status: string
  statusGroup: TxStatusGroup
  source: TxSource
  createdAt: string
}

/** Sort the merged rows newest-first and slice one page. Pure — unit tested. */
export function mergePage(rows: TxRow[], page: number, limit: number): TxRow[] {
  const sorted = [...rows].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1
    return a.key < b.key ? 1 : -1
  })
  return sorted.slice((page - 1) * limit, page * limit)
}

