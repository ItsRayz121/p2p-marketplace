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
import { getHotWalletTokenBalance } from '../lib/gas/gas.tokenBalance'
import { appendLedgerEntry } from '../lib/gas/gas.ledger'
import { fromDbChain, GAS_CHAINS } from '../lib/gas/gas.chains'
import type { GasChainId } from '../lib/gas/gas.chains'

// Minimum balance increase to record (below this = rounding / RPC noise)
const DUST_THRESHOLD = 0.000_01
// Token deposits use a slightly larger floor — token balances can carry tiny
// rounding artifacts across decimal conversions; 0.001 USDT/USDC is still dust.
const TOKEN_DUST_THRESHOLD = 0.001

// Symbols we treat as ~$1 so a token top-up gets a USD value in the ledger.
function isStableSymbol(symbol: string): boolean {
  const s = symbol.toUpperCase()
  return ['USDT', 'USDC', 'DAI', 'BUSD', 'USD'].some((x) => s.includes(x))
}

// Redis key includes chain, address, AND native symbol so that chains sharing
// the same address (all EVM hot wallets) each have an independent baseline.
function redisKey(chain: string, address: string, nativeSymbol: string) {
  return `gas_hw_poll_balance:${chain}:${address.toLowerCase()}:${nativeSymbol}`
}

// Per-token baseline key — keyed by symbol AND contract so two tokens (or a
// re-pointed contract) never share a baseline.
function tokenRedisKey(chain: string, address: string, symbol: string, contract: string) {
  return `gas_hw_poll_token_balance:${chain}:${address.toLowerCase()}:${symbol.toUpperCase()}:${contract.toLowerCase()}`
}

// Build the sourceKey bucket: floor to the current 2-minute window so that
// the same deposit cannot be recorded twice within a single poll cycle.
function sourceKeyFor(chain: string, address: string, symbol: string): string {
  const bucketMs = Math.floor(Date.now() / (2 * 60_000)) * (2 * 60_000)
  return `BALANCE_DIFF:${chain}:${address.toLowerCase()}:${symbol}:${bucketMs}`
}

// Poll each active non-native token a wallet holds and record balance increases.
// This is the token counterpart of the native balance-diff above: a USDT/USDC
// transfer moves NO native balance, so the native poller can never see it. The
// only other path that records external token top-ups is the Moralis webhook —
// which is dead once Moralis credits lapse, leaving token deposits invisible in
// Wallet Activity. This closes that gap with the same on-chain readers the admin
// wallet view already uses (no third-party dependency).
async function pollWalletTokens(
  chainId: GasChainId,
  dbChain: string,
  address: string,
  tokens: Array<{ symbol: string; contractAddress: string }>,
): Promise<void> {
  for (const t of tokens) {
    try {
      const { balance: currentBalance } = await getHotWalletTokenBalance(dbChain, t.contractAddress, address)
      const key = tokenRedisKey(dbChain, address, t.symbol, t.contractAddress)
      const prevStr = await redis.get(key)

      if (prevStr !== null) {
        const prevBalance = parseFloat(prevStr)
        const diff = currentBalance - prevBalance
        if (diff > TOKEN_DUST_THRESHOLD) {
          const bucketMs = Math.floor(Date.now() / (2 * 60_000)) * (2 * 60_000)
          const sourceKey = `BALANCE_DIFF:${dbChain}:${address.toLowerCase()}:${t.symbol.toUpperCase()}:${t.contractAddress.toLowerCase()}:${bucketMs}`
          const usdAmount = isStableSymbol(t.symbol) ? diff : 0

          logger.info(
            { source: 'TOKEN_BALANCE_DIFF', chain: dbChain, address, symbol: t.symbol, diff: diff.toFixed(6), prev: prevBalance.toFixed(6), now: currentBalance.toFixed(6), sourceKey },
            'Hot wallet TOKEN deposit detected by balance-diff poller',
          )

          try {
            await appendLedgerEntry({
              entryType:    'external_hot_wallet_deposit',
              chain:        chainId,
              nativeAmount: 0,             // a token transfer moves no native gas
              tokenSymbol:  t.symbol.toUpperCase(),
              tokenAmount:  diff,
              usdAmount,                   // explicit → skips native price lookup
              toAddress:    address,
              sourceKey,
              notes: `source:TOKEN_BALANCE_DIFF chain:${dbChain} token:${t.symbol.toUpperCase()} contract:${t.contractAddress} prev:${prevBalance.toFixed(6)} now:${currentBalance.toFixed(6)}`,
            })
          } catch (ledgerErr) {
            logger.warn({ err: ledgerErr, chain: dbChain, sourceKey }, 'Token balance-diff poller: failed to write ledger entry')
          }
        }
      } else {
        logger.debug({ chain: dbChain, symbol: t.symbol, now: currentBalance.toFixed(6) }, 'Token balance-diff poller: baseline set (first run for this token)')
      }

      await redis.set(key, String(currentBalance), 'EX', 3_600)
    } catch (err) {
      // A read failure (rate-limited RPC, missing reader) must not abort the
      // other tokens — log and continue so the baseline simply updates next tick.
      logger.warn({ chain: dbChain, symbol: t.symbol, err: err instanceof Error ? err.message : String(err) }, 'Token balance-diff poller: read failed for token')
    }
  }
}

export async function runHotWalletDepositPoller(): Promise<void> {
  const wallets = await db.gasHotWallet.findMany({
    where: { isActive: true },
    select: { chain: true, address: true },
  })

  if (wallets.length === 0) return

  // Prefetch the active non-native tokens for every chain we hold a wallet on,
  // so per-wallet token polling needs no extra DB round-trip.
  const walletChains = [...new Set(wallets.map((w) => w.chain))]
  const chainCfgs = await db.gasChainConfig.findMany({
    where: { backendChainId: { in: walletChains } },
    select: {
      backendChainId: true,
      tokens: {
        where: { tokenType: { not: 'native' }, isActive: true, contractAddress: { not: null } },
        select: { symbol: true, contractAddress: true },
      },
    },
  })
  const tokensByChain = new Map<string, Array<{ symbol: string; contractAddress: string }>>()
  for (const c of chainCfgs) {
    if (!c.backendChainId) continue
    tokensByChain.set(c.backendChainId, c.tokens.map((t) => ({ symbol: t.symbol, contractAddress: t.contractAddress! })))
  }

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

          // appendLedgerEntry returns null for P2002 (duplicate sourceKey) and
          // re-throws all other errors — use try/catch so we don't conflate a
          // real DB error with a "duplicate skipped" log.
          try {
            await appendLedgerEntry({
              entryType:    'external_hot_wallet_deposit',
              chain:        chainId,
              nativeAmount: diff,
              toAddress:    w.address,
              sourceKey,
              notes: `source:BALANCE_DIFF chain:${w.chain} symbol:${sym} prev:${prevBalance.toFixed(6)} now:${currentBalance.toFixed(6)}`,
            })
            // null return is logged inside appendLedgerEntry; no extra log needed here.
          } catch (ledgerErr) {
            logger.warn({ err: ledgerErr, chain: w.chain, sourceKey }, 'Balance-diff poller: failed to write ledger entry')
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

      // Then poll this wallet's non-native tokens (USDT/USDC top-ups), which the
      // native diff above can never see.
      const tokens = tokensByChain.get(w.chain) ?? []
      if (tokens.length > 0) await pollWalletTokens(chainId, w.chain, w.address, tokens)
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
