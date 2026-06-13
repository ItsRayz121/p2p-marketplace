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

// Aptos has NO GasHotWallet row (its address is HD-derived on demand), so the
// main wallet loop skips it entirely — leaving APT top-ups and external USDT/USDC
// sent to the Aptos gas wallet invisible in Wallet Activity. This polls it directly:
//   - native APT via balance-diff (no overlap — orders are paid in USDT, not APT)
//   - USDT/USDC FA via balance-diff, MINUS any amount already recorded as an
//     order_payment on Aptos in the recent window, so on-chain order payments
//     (already booked by the payment poller) are not double-counted here.
async function pollAptosHotWallet(): Promise<void> {
  const { getAptosHotWalletAddress } = await import('../lib/gas/aptosWalletService')
  const address = getAptosHotWalletAddress()
  if (!address) return // gas mnemonic/seed not configured in this environment

  // APT price for the USD value on native deposits (avoid the generic native-price
  // lookup, which is keyed on the delivery-chain symbol — wrong for an APT override).
  async function aptUsd(amount: number): Promise<number> {
    try {
      const raw = await redis.get('rate:APT')
      const p = raw ? ((JSON.parse(raw) as { usdPrice?: number }).usdPrice ?? 0) : 0
      return p > 0 ? amount * p : 0
    } catch { return 0 }
  }

  // ── Native APT ──────────────────────────────────────────────────────────────
  try {
    const { getAptosNativeBalance } = await import('../lib/gas/aptosRefund')
    const current = await getAptosNativeBalance(address)
    const key = redisKey('APT', address, 'APT')
    const prevStr = await redis.get(key)
    if (prevStr !== null) {
      const prev = parseFloat(prevStr)
      const diff = current - prev
      if (diff > DUST_THRESHOLD) {
        const sourceKey = sourceKeyFor('APT', address, 'APT')
        logger.info({ source: 'BALANCE_DIFF', chain: 'APT', address, symbol: 'APT', diff: diff.toFixed(6), prev: prev.toFixed(6), now: current.toFixed(6), sourceKey }, 'Aptos hot wallet native deposit detected by balance-diff poller')
        try {
          await appendLedgerEntry({
            entryType:    'external_hot_wallet_deposit',
            chain:        fromDbChain('APT'),
            chainOverride: { dbChain: 'APT', nativeSymbol: 'APT' },
            nativeAmount: diff,
            usdAmount:    await aptUsd(diff), // explicit → skips delivery-chain price lookup
            toAddress:    address,
            sourceKey,
            notes: `source:BALANCE_DIFF chain:APT symbol:APT prev:${prev.toFixed(6)} now:${current.toFixed(6)}`,
          })
        } catch (ledgerErr) {
          logger.warn({ err: ledgerErr, chain: 'APT', sourceKey }, 'Aptos native balance-diff: failed to write ledger entry')
        }
      }
    }
    await redis.set(key, String(current), 'EX', 3_600)
  } catch (err) {
    logger.warn({ chain: 'APT', err: err instanceof Error ? err.message : String(err) }, 'Aptos native balance-diff read failed')
  }

  // ── Aptos FA tokens (USDT/USDC) with order-payment reconciliation ─────────────
  const aptCfg = await db.gasChainConfig.findFirst({
    where: { OR: [{ backendChainId: 'APT' }, { slug: { in: ['APT', 'APTOS'] } }] },
    select: { tokens: { where: { tokenType: { not: 'native' }, isActive: true, contractAddress: { not: null } }, select: { symbol: true, contractAddress: true } } },
  })
  for (const t of aptCfg?.tokens ?? []) {
    const contract = t.contractAddress!
    try {
      const { balance: current } = await getHotWalletTokenBalance('APT', contract, address)
      const key = tokenRedisKey('APT', address, t.symbol, contract)
      const prevRaw = await redis.get(key)
      const now = Date.now()
      if (prevRaw !== null) {
        // Baseline is stored as JSON { b: balance, t: epochMs }; tolerate a legacy
        // bare-number value from before the timestamp was added.
        let prevBal: number
        let prevTs: number
        try {
          const o = JSON.parse(prevRaw) as { b: number; t: number }
          prevBal = o.b; prevTs = o.t
        } catch {
          prevBal = parseFloat(prevRaw); prevTs = now - 3 * 60_000
        }
        const diff = current - prevBal
        if (diff > TOKEN_DUST_THRESHOLD) {
          // Subtract token already booked as order payments on Aptos SINCE THE LAST
          // BASELINE — exactly the window this diff covers — so a USDT order payment
          // the payment poller recorded isn't also logged here as an external deposit
          // (and a prior tick's payment can't suppress a later genuine top-up).
          const agg = await db.gasLedgerEntry.aggregate({
            where: { chain: 'APT', entryType: 'order_payment', tokenSymbol: t.symbol.toUpperCase(), createdAt: { gte: new Date(prevTs) } },
            _sum: { tokenAmount: true },
          })
          const explained = Number(agg._sum.tokenAmount ?? 0)
          const external = diff - explained
          if (external > TOKEN_DUST_THRESHOLD) {
            const bucketMs = Math.floor(now / (2 * 60_000)) * (2 * 60_000)
            const sourceKey = `BALANCE_DIFF:APT:${address.toLowerCase()}:${t.symbol.toUpperCase()}:${contract.toLowerCase()}:${bucketMs}`
            logger.info({ source: 'TOKEN_BALANCE_DIFF', chain: 'APT', symbol: t.symbol, diff: diff.toFixed(6), explained: explained.toFixed(6), external: external.toFixed(6), sourceKey }, 'Aptos hot wallet TOKEN deposit detected (external portion) by balance-diff poller')
            try {
              await appendLedgerEntry({
                entryType:    'external_hot_wallet_deposit',
                chain:        fromDbChain('APT'),
                chainOverride: { dbChain: 'APT', nativeSymbol: 'APT' },
                nativeAmount: 0,
                tokenSymbol:  t.symbol.toUpperCase(),
                tokenAmount:  external,
                usdAmount:    isStableSymbol(t.symbol) ? external : 0,
                toAddress:    address,
                sourceKey,
                notes: `source:TOKEN_BALANCE_DIFF chain:APT token:${t.symbol.toUpperCase()} contract:${contract} diff:${diff.toFixed(6)} orderPaymentsExplained:${explained.toFixed(6)} external:${external.toFixed(6)}`,
              })
            } catch (ledgerErr) {
              logger.warn({ err: ledgerErr, chain: 'APT', sourceKey }, 'Aptos token balance-diff: failed to write ledger entry')
            }
          }
        }
      }
      await redis.set(key, JSON.stringify({ b: current, t: now }), 'EX', 3_600)
    } catch (err) {
      logger.warn({ chain: 'APT', symbol: t.symbol, err: err instanceof Error ? err.message : String(err) }, 'Aptos token balance-diff read failed')
    }
  }
}

export async function runHotWalletDepositPoller(): Promise<void> {
  const wallets = await db.gasHotWallet.findMany({
    where: { isActive: true },
    select: { chain: true, address: true },
  })

  // Poll the Aptos hot wallet explicitly — it has no GasHotWallet row, so the loop
  // below never reaches it. Independent of the EVM/other-chain wallets.
  await pollAptosHotWallet().catch((err) =>
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Aptos hot wallet deposit poll error'))

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
