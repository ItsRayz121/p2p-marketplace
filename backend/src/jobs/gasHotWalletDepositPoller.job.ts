/**
 * Hot-wallet deposit poller — balance-diff safety net.
 *
 * Runs every 2 minutes. For each active hot wallet it fetches the current
 * on-chain native balance, compares it to the last value stored in Redis,
 * and if the balance increased by more than a dust threshold it writes a
 * GasLedgerEntry so the deposit appears in Wallet Activity.
 *
 * This catches everything Moralis misses (webhook delivery failures, hot
 * wallet not yet subscribed to a stream, non-EVM chains, etc.).
 *
 * Deduplication:
 *   - Redis key is per-chain/address/symbol — a deposit on BSC only affects
 *     the BSC key; ARB/OP/AVAX keys are unaffected.
 *   - sourceKey (chain:address:symbol:2min-bucket) prevents the same balance
 *     increase from being recorded twice within one poll window.
 *   - The Moralis webhook path refreshes this Redis key when it detects a
 *     deposit, so the next poller tick sees diff=0 and skips silently.
 */

import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { logger } from '../lib/logger'
import { getHotWalletBalance } from '../lib/gas/gas.balance'
import { appendLedgerEntry } from '../lib/gas/gas.ledger'
import { fromDbChain, GAS_CHAINS } from '../lib/gas/gas.chains'
import type { GasChainId } from '../lib/gas/gas.chains'

// Minimum balance increase to record (below this = rounding / RPC noise)
const DUST_THRESHOLD = 0.000_01

// Redis key includes chain, address, AND native symbol so that chains sharing
// the same address (all EVM hot wallets) each have an independent baseline.
function redisKey(chain: string, address: string, nativeSymbol: string) {
  return `gas_hw_poll_balance:${chain}:${address.toLowerCase()}:${nativeSymbol}`
}

// Build the sourceKey bucket: floor to the current 2-minute window so that
// the same deposit cannot be recorded twice within a single poll cycle.
function sourceKeyFor(chain: string, address: string, symbol: string): string {
  const bucketMs = Math.floor(Date.now() / (2 * 60_000)) * (2 * 60_000)
  return `BALANCE_DIFF:${chain}:${address.toLowerCase()}:${symbol}:${bucketMs}`
}

export async function runHotWalletDepositPoller(): Promise<void> {
  const wallets = await db.gasHotWallet.findMany({
    where: { isActive: true },
    select: { chain: true, address: true },
  })

  if (wallets.length === 0) return

  await Promise.allSettled(wallets.map(async (w) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chainId    = fromDbChain(w.chain as any) as GasChainId
      const chainCfg   = GAS_CHAINS[chainId]
      const sym        = chainCfg?.nativeSymbol ?? chainId
      const currentBalance = await getHotWalletBalance(chainId, w.address)

      const key = redisKey(w.chain, w.address, sym)
      const prevStr = await redis.get(key)

      if (prevStr !== null) {
        const prevBalance = parseFloat(prevStr)
        const diff = currentBalance - prevBalance

        if (diff > DUST_THRESHOLD) {
          const sourceKey = sourceKeyFor(w.chain, w.address, sym)
          logger.info(
            {
              source:  'BALANCE_DIFF',
              chain:   w.chain,
              address: w.address,
              symbol:  sym,
              diff:    diff.toFixed(6),
              prev:    prevBalance.toFixed(6),
              now:     currentBalance.toFixed(6),
              sourceKey,
            },
            'Hot wallet deposit detected by balance-diff poller',
          )

          const entry = await appendLedgerEntry({
            entryType:    'external_hot_wallet_deposit',
            chain:        chainId,
            nativeAmount: diff,
            toAddress:    w.address,
            sourceKey,
            notes: `source:BALANCE_DIFF chain:${w.chain} symbol:${sym} prev:${prevBalance.toFixed(6)} now:${currentBalance.toFixed(6)}`,
          }).catch((err) => {
            logger.warn({ err, chain: w.chain }, 'Balance-diff poller: failed to write ledger entry')
            return null
          })

          if (entry === null) {
            logger.info(
              { sourceKey, chain: w.chain },
              'Balance-diff poller: duplicate skipped — sourceKey already recorded',
            )
          }
        } else if (diff < -DUST_THRESHOLD) {
          // Balance decreased (outflow already recorded elsewhere — delivery, drain, etc.)
          logger.debug({ chain: w.chain, diff: diff.toFixed(6) }, 'Balance-diff poller: outflow detected, no entry needed')
        }
      } else {
        logger.debug({ chain: w.chain, address: w.address, now: currentBalance.toFixed(6) }, 'Balance-diff poller: baseline set (first run for this key)')
      }

      // Always update baseline — must happen even when diff=0 so the next tick
      // has an accurate reference.
      await redis.set(key, String(currentBalance), 'EX', 3_600)
    } catch (err) {
      logger.warn(
        {
          chain:   w.chain,
          address: w.address.slice(0, 8) + '…',
          err:     err instanceof Error ? err.message : String(err),
        },
        'Hot wallet deposit poller error for wallet',
      )
    }
  }))
}
