import { describe, it, expect } from 'vitest'
import {
  CHAIN_TO_NETWORKS,
  chainForWithdrawalNetwork,
  depositStatusGroup,
  mergePage,
  withdrawalStatusGroup,
  type TxRow,
} from '../walletTransactionsCore'

const row = (key: string, createdAt: string, direction: 'in' | 'out' = 'in'): TxRow => ({
  key, kind: direction === 'in' ? 'deposit' : 'withdrawal', direction, id: key, ref: null, chain: 'bsc', network: null,
  asset: 'USDT', amount: '1', amountUsd: null, txHash: null, address: null, user: null, relatedOrder: null,
  status: 'credited', statusGroup: 'completed', source: 'onchain', createdAt,
})

describe('unified transaction status mapping', () => {
  it('maps deposits', () => {
    expect(depositStatusGroup('credited')).toBe('completed')
    expect(depositStatusGroup('detected')).toBe('pending')
    expect(depositStatusGroup('rejected')).toBe('failed')
  })

  it('maps withdrawals — auto_approved only counts as completed once it has a tx hash', () => {
    expect(withdrawalStatusGroup('sent', '0x1')).toBe('completed')
    expect(withdrawalStatusGroup('completed', null)).toBe('completed')
    expect(withdrawalStatusGroup('auto_approved', '0x1')).toBe('completed')
    expect(withdrawalStatusGroup('auto_approved', null)).toBe('pending')
    expect(withdrawalStatusGroup('pending', null)).toBe('pending')
    expect(withdrawalStatusGroup('first_approved', null)).toBe('pending')
    expect(withdrawalStatusGroup('on_hold', null)).toBe('on_hold')
    expect(withdrawalStatusGroup('rejected', null)).toBe('failed')
    expect(withdrawalStatusGroup('cancelled', null)).toBe('failed')
  })
})

describe('chain normalisation (deposits use chain ids, withdrawals use network labels)', () => {
  it('maps network labels to chain ids and back', () => {
    expect(chainForWithdrawalNetwork('BEP20')).toBe('bsc')
    expect(chainForWithdrawalNetwork('trc20')).toBe('tron')
    expect(chainForWithdrawalNetwork('SOMETHING')).toBe('something')
    expect(CHAIN_TO_NETWORKS.bsc).toEqual(['BEP20'])
    expect(CHAIN_TO_NETWORKS.ethereum).toEqual(['ERC20'])
  })
})

describe('mergePage', () => {
  it('interleaves deposits and withdrawals newest-first and pages the merged list', () => {
    const rows = [
      row('d:1', '2026-01-01T10:00:00.000Z'),
      row('w:1', '2026-01-03T10:00:00.000Z', 'out'),
      row('d:2', '2026-01-02T10:00:00.000Z'),
      row('w:2', '2026-01-04T10:00:00.000Z', 'out'),
    ]
    expect(mergePage(rows, 1, 3).map((r) => r.key)).toEqual(['w:2', 'w:1', 'd:2'])
    expect(mergePage(rows, 2, 3).map((r) => r.key)).toEqual(['d:1'])
    expect(mergePage(rows, 3, 3)).toEqual([])
  })

  it('is stable for identical timestamps', () => {
    const t = '2026-01-01T10:00:00.000Z'
    const a = mergePage([row('d:a', t), row('w:b', t, 'out')], 1, 10).map((r) => r.key)
    const b = mergePage([row('w:b', t, 'out'), row('d:a', t)], 1, 10).map((r) => r.key)
    expect(a).toEqual(b)
  })
})
