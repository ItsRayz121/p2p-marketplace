/**
 * Hot-wallet deposit poller — Fix 2 safety net.
 *
 * Runs every 2 minutes. For each active hot wallet it fetches the current
 * on-chain native balance, compares it to the last value stored in Redis,
 * and if the balance increased by more than a dust threshold it writes a
 * GasLedgerEntry so the deposit appears in Wallet Activity.
 *
 * This catches everything Moralis misses (webhook delivery failures, hot
 * wallet not yet subscribed to a stream, non-EVM chains, etc.).
 */

import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { logger } from '../lib/logger'
import { getHotWalletBalance } from '../lib/gas/gas.balance'
import { appendLedgerEntry } from '../lib/gas/gas.ledger'
import { fromDbChain } from '../lib/gas/gas.chains'
import type { GasChainId } from '../lib/gas/gas.chains'

// Minimum balance increase to record (below this = rounding/noise)
const DUST_THRESHOLD = 0.000_01

function redisKey(chain: string, address: string) {
  return `gas_hw_poll_balance:${chain}:${address.toLowerCase()}`
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
      const chainId = fromDbChain(w.chain as any) as GasChainId
      const currentBalance = await getHotWalletBalance(chainId, w.address)

      const key = redisKey(w.chain, w.address)
      const prevStr = await redis.get(key)

      if (prevStr !== null) {
        const prevBalance = parseFloat(prevStr)
        const diff = currentBalance - prevBalance

        if (diff > DUST_THRESHOLD) {
          logger.info(
            { chain: w.chain, diff: diff.toFixed(6), prev: prevBalance.toFixed(6), now: currentBalance.toFixed(6) },
            'Hot wallet deposit detected by balance poller',
          )

          await appendLedgerEntry({
            entryType:   'external_hot_wallet_deposit',
            chain:       chainId,
            nativeAmount: diff,
            toAddress:   w.address,
            notes:       `Balance poller: prev ${prevBalance.toFixed(6)}, now ${currentBalance.toFixed(6)}`,
          }).catch((err) =>
            logger.warn({ err, chain: w.chain }, 'Balance poller: failed to write ledger entry'),
          )
        }
      }

      // Always update baseline so the next tick has an accurate reference
      await redis.set(key, String(currentBalance), 'EX', 3_600) // 1h TTL; job re-sets every 2 min
    } catch (err) {
      logger.warn(
        { chain: w.chain, address: w.address.slice(0, 8) + '…', err: err instanceof Error ? err.message : String(err) },
        'Hot wallet deposit poller error for wallet',
      )
    }
  }))
}
