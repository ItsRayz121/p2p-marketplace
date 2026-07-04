import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { env } from '../lib/env'
import { getHotWalletBalance, getNativeUsdPrice } from '../lib/gas/gas.balance'
import { fromDbChain } from '../lib/gas/gas.chains'
import { getAptosHotWalletAddress } from '../lib/gas/aptosWalletService'
import { getAptosNativeBalance } from '../lib/gas/aptosRefund'
import { logger } from '../lib/logger'
import type { GasChainId } from '../lib/gas/gas.chains'
import { createAdminNotif } from '../services/adminNotification.service'
import { appendLedgerEntry } from '../lib/gas/gas.ledger'

// Aptos is an inbound-only USDT rail (no GasHotWallet row), but its hot wallet
// still needs native APT to pay gas for outgoing USDT refunds. Monitor it
// separately so admins are warned before refunds start failing.
const APT_LOW_ALERT_KEY = 'gas_aptos_apt_low_alerted'
const APT_LOW_ALERT_TTL_S = 6 * 3600 // re-alert at most every 6h
const APT_PREV_BALANCE_KEY = 'gas_monitor_prev_aptos_apt_balance'
const APT_DUST_THRESHOLD = 0.000_01

async function monitorAptosGasBalance(): Promise<void> {
  const address = getAptosHotWalletAddress()
  if (!address) return // Aptos wallet not configured — nothing to watch

  let apt: number
  try {
    apt = await getAptosNativeBalance(address)
  } catch (err) {
    logger.warn({ err: extractErrorMessage(err) }, '[gas-monitor] Aptos APT balance fetch failed — will retry next run')
    return
  }

  await redis.set('gas_aptos_apt_balance', String(apt), 'EX', 1800)

  // Detect inbound APT deposits and write ledger entries so they appear in Wallet Activity.
  // Aptos has no GasHotWallet row, so the gasHotWalletDepositPoller skips it — we fill
  // that gap here using the same balance-diff approach.
  const prevStr = await redis.get(APT_PREV_BALANCE_KEY)
  if (prevStr !== null) {
    const prevBalance = parseFloat(prevStr)
    const delta = apt - prevBalance
    if (delta > APT_DUST_THRESHOLD) {
      const aptRateRaw = await redis.get('rate:APT').catch(() => null)
      let aptUsdPrice = 0
      if (aptRateRaw) {
        try { aptUsdPrice = (JSON.parse(aptRateRaw) as { usdPrice?: number }).usdPrice ?? 0 } catch { /* ignore */ }
      }
      const usdAmount = aptUsdPrice > 0 ? delta * aptUsdPrice : 0
      const bucketMs = Math.floor(Date.now() / (2 * 60_000)) * (2 * 60_000)
      const sourceKey = `BALANCE_DIFF:APT:${address.toLowerCase()}:APT:${bucketMs}`

      await appendLedgerEntry({
        entryType:     'external_hot_wallet_deposit',
        chain:         'BSC' as GasChainId, // dummy for type; chainOverride is authoritative
        chainOverride: { dbChain: 'APT', nativeSymbol: 'APT' },
        nativeAmount:  delta,
        usdAmount,
        toAddress:     address,
        sourceKey,
        notes: `source:BALANCE_DIFF chain:APT symbol:APT prev:${prevBalance.toFixed(6)} now:${apt.toFixed(6)}`,
      }).catch((e) => logger.warn({ err: e }, '[gas-monitor] Failed to write Aptos deposit ledger entry'))

      const usdStr = usdAmount > 0 ? ` (~$${usdAmount.toFixed(2)})` : ''
      void createAdminNotif({
        category: 'GAS',
        title:    `Aptos Hot Wallet Topped Up — +${delta.toFixed(6)} APT${usdStr}`,
        body:     `Aptos hot wallet received ${delta.toFixed(6)} APT${usdStr}. New balance: ${apt.toFixed(6)} APT.`,
        href:     '/admin/gas',
        metadata: { delta, balance: apt, usdAmount, address },
      })
      logger.info({ delta, balance: apt, address }, '[gas-monitor] Aptos APT deposit detected via balance diff')
    }
  }
  await redis.set(APT_PREV_BALANCE_KEY, String(apt), 'EX', 1800)
  const minApt = env.GAS_APTOS_MIN_APT

  if (apt < minApt) {
    logger.warn({ apt, minApt, address }, '[gas-monitor] Aptos hot wallet LOW on APT gas — USDT refunds may fail')
    // Dedupe email + notif so we don't spam every 5-minute run.
    const already = await redis.get(APT_LOW_ALERT_KEY)
    if (!already) {
      await redis.set(APT_LOW_ALERT_KEY, '1', 'EX', APT_LOW_ALERT_TTL_S)
      void createAdminNotif({
        category: 'GAS',
        title:    `WARNING: Aptos Hot Wallet Low on APT Gas`,
        body:     `APT balance ${apt.toFixed(4)} is below ${minApt} APT. Aptos USDT refunds need APT for gas — top up to avoid failures.\nTop up APT to: ${address}`,
        href:     '/admin/gas',
        metadata: { apt, minApt, address },
      })
    }
  } else {
    // Recovered — clear the dedupe flag so a future dip alerts again.
    await redis.del(APT_LOW_ALERT_KEY)
  }
}

// TTL for the auto-pause flag: next monitor run (5 min) will re-evaluate and
// either extend or clear it — 6 min gives a comfortable margin.
const PAUSED_TTL_S = 360

// TTL for the last-fetch-error key: 2 hours.  Cleared on next successful fetch.
const ERROR_TTL_S = 7200

// Retry config: 3 attempts with 2 s back-off between each.
const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 2_000

function extractErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.slice(0, 200)
}

interface ChainThresholds {
  alertThresholdUsd: number | null
  pauseThresholdUsd: number | null
}

async function fetchBalanceWithRetry(
  chain: GasChainId,
  address: string,
): Promise<{ balance: number; attempts: number }> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const balance = await getHotWalletBalance(chain, address)
      return { balance, attempts: attempt }
    } catch (err) {
      lastErr = err
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
      }
    }
  }
  throw lastErr
}

async function monitorChain(
  chain: GasChainId,
  walletId: string,
  address: string,
  thresholds: ChainThresholds,
): Promise<void> {
  const dbChain = chain === 'ETHEREUM' ? 'ETH' : chain
  const balanceKey    = `gas_wallet_balance:${dbChain}`
  const balanceUsdKey = `gas_wallet_balance_usd:${dbChain}`
  const pausedKey     = `gas_wallet_paused:${dbChain}`
  const errorKey      = `gas_wallet_error:${dbChain}`

  let balance: number
  let attempts: number
  try {
    ;({ balance, attempts } = await fetchBalanceWithRetry(chain, address))
  } catch (err) {
    const msg = extractErrorMessage(err)
    logger.error({ err, chain, rpcError: msg }, 'Gas hot wallet balance fetch failed after all retries')
    await redis.set(errorKey, msg, 'EX', ERROR_TTL_S)
    return
  }

  // Successful fetch — clear any stale error
  await redis.del(errorKey)

  if (attempts > 1) {
    logger.warn({ chain, attempts }, 'Gas hot wallet balance fetch succeeded after retry')
  }

  const usdPrice = await getNativeUsdPrice(chain)
  const balanceUsd = usdPrice > 0 ? balance * usdPrice : null

  logger.debug({
    chain,
    nativeBalance: balance,
    usdPrice,
    computedBalanceUsd: balanceUsd,
    alertThresholdUsd: thresholds.alertThresholdUsd,
    pauseThresholdUsd: thresholds.pauseThresholdUsd,
    thresholdResult: balanceUsd === null ? 'no-usd-price'
      : thresholds.pauseThresholdUsd !== null && balanceUsd <= thresholds.pauseThresholdUsd ? 'PAUSED'
      : thresholds.alertThresholdUsd !== null && balanceUsd <= thresholds.alertThresholdUsd ? 'ALERT'
      : 'ok',
  }, '[gas-monitor] balance & threshold check')

  // Detect inbound top-up: if balance increased by more than dust since last check, notify admin
  const prevBalanceStr = await redis.get(balanceKey)
  if (prevBalanceStr !== null) {
    const prevBalance = parseFloat(prevBalanceStr)
    const delta = balance - prevBalance
    const dustThreshold = 0.000001
    if (delta > dustThreshold) {
      const deltaUsd = usdPrice > 0 ? delta * usdPrice : null
      const usdStr = deltaUsd !== null ? ` (~$${deltaUsd.toFixed(2)})` : ''
      void createAdminNotif({
        category: 'GAS',
        title: `Hot Wallet Topped Up — ${chain} +${delta.toFixed(6)}${usdStr}`,
        body: `${chain} hot wallet received ${delta.toFixed(6)} native${usdStr}. New balance: ${balance.toFixed(6)}.`,
        href: '/admin/gas',
        metadata: { chain, delta, balance, deltaUsd, address },
      })
      logger.info({ chain, delta, balance, address }, 'Gas hot wallet inbound transfer detected')
    }
  }

  // Cache native + USD balances (30 min TTL)
  await redis.set(balanceKey, String(balance), 'EX', 1800)
  if (balanceUsd !== null) {
    await redis.set(balanceUsdKey, String(balanceUsd.toFixed(4)), 'EX', 1800)
  }

  // Stamp the DB row with the successful refresh time
  await db.gasHotWallet.update({
    where: { id: walletId },
    data: { lastBalanceRefreshAt: new Date() },
  })

  logger.info({ balance, balanceUsd, address, chain }, 'Gas hot wallet balance refreshed')

  const { alertThresholdUsd, pauseThresholdUsd } = thresholds

  // No thresholds configured — skip alerting
  if (alertThresholdUsd === null && pauseThresholdUsd === null) {
    await redis.del(pausedKey)
    return
  }

  // Cannot compute USD balance — clear pause and bail
  if (balanceUsd === null) {
    logger.warn({ chain }, 'USD price unavailable — skipping threshold check')
    return
  }

  if (pauseThresholdUsd !== null && balanceUsd <= pauseThresholdUsd) {
    await redis.set(pausedKey, '1', 'EX', PAUSED_TTL_S)
    logger.error({ balanceUsd, pauseThresholdUsd, chain, usdPrice },
      'Gas hot wallet CRITICAL — below pause threshold (USD); verify rate:POL / rate:MATIC in Redis')
    void createAdminNotif({
      category: 'GAS',
      title:    `CRITICAL: ${chain} Hot Wallet Below Pause Threshold`,
      body:     `${chain} balance $${balanceUsd.toFixed(2)} (${balance.toFixed(6)} native) is below pause threshold $${pauseThresholdUsd}. New orders paused — top up immediately.\nWallet: ${address}`,
      href:     `/admin/gas`,
      metadata: { chain, balanceUsd, pauseThresholdUsd, address },
    })
  } else if (alertThresholdUsd !== null && balanceUsd <= alertThresholdUsd) {
    await redis.del(pausedKey)
    logger.warn({ balanceUsd, alertThresholdUsd, chain }, 'Gas hot wallet LOW — below alert threshold (USD)')
    void createAdminNotif({
      category: 'GAS',
      title:    `WARNING: ${chain} Hot Wallet Low Balance`,
      body:     `${chain} balance $${balanceUsd.toFixed(2)} (${balance.toFixed(6)} native) is below alert threshold $${alertThresholdUsd}. Top up soon to avoid interruption.\nWallet: ${address}`,
      href:     `/admin/gas`,
      metadata: { chain, balanceUsd, alertThresholdUsd, address },
    })
  } else {
    await redis.del(pausedKey)
  }
}

export async function runGasMonitorBalances(): Promise<void> {
  const wallets = await db.gasHotWallet.findMany({ where: { isActive: true } })

  if (wallets.length === 0) {
    logger.warn('No active gas hot wallets configured — skipping balance monitor')
    return
  }

  // Fetch all GasChainConfig rows that have a backendChainId (one query for all wallets)
  const chainConfigs = await db.gasChainConfig.findMany({
    where: { backendChainId: { not: null } },
    select: { backendChainId: true, alertThresholdUsd: true, pauseThresholdUsd: true },
  })
  const thresholdMap = Object.fromEntries(
    chainConfigs.map((c) => [c.backendChainId!, { alertThresholdUsd: c.alertThresholdUsd, pauseThresholdUsd: c.pauseThresholdUsd }]),
  ) as Record<string, ChainThresholds>

  // Collect addresses already covered by GasHotWallet rows (to avoid duplicate monitoring)
  const coveredAddresses = new Set(wallets.map((w) => w.address.toLowerCase()))

  // Also monitor EVM chains registered in GasChainConfig with a depositAddressOverride
  // but no GasHotWallet row — enables zero-code onboarding for new EVM chains.
  type RegistryEvmCfg = { address: string; symbol: string; slug: string; rpcUrl: string | null; rpcUrlFallback: string | null }
  const registryOnlyEvm: RegistryEvmCfg[] = []
  const evmRegistryCfgs = await db.gasChainConfig.findMany({
    where: { isActive: true, chainType: 'EVM', depositAddressOverride: { not: null } },
    select: { depositAddressOverride: true, symbol: true, slug: true, rpcUrl: true, rpcUrlFallback: true, alertThresholdUsd: true, pauseThresholdUsd: true },
  }).catch(() => [] as Array<{ depositAddressOverride: string | null; symbol: string; slug: string; rpcUrl: string | null; rpcUrlFallback: string | null; alertThresholdUsd: number | null; pauseThresholdUsd: number | null }>)
  for (const cfg of evmRegistryCfgs) {
    if (cfg.depositAddressOverride && !coveredAddresses.has(cfg.depositAddressOverride.toLowerCase())) {
      registryOnlyEvm.push({ address: cfg.depositAddressOverride, symbol: cfg.symbol, slug: cfg.slug, rpcUrl: cfg.rpcUrl, rpcUrlFallback: cfg.rpcUrlFallback })
    }
  }

  // Monitor all active chains in parallel; individual failures don't abort others
  await Promise.allSettled([
    ...wallets.map((w) => {
      const chain = fromDbChain(w.chain)
      const dbChain = w.chain as string
      const thresholds: ChainThresholds = thresholdMap[dbChain] ?? { alertThresholdUsd: null, pauseThresholdUsd: null }
      return monitorChain(chain, w.id, w.address, thresholds)
    }),
    // Registry-only EVM chains — fetch live balance via RPC, store for admin panel, detect deposits
    ...registryOnlyEvm.map(({ address, symbol, slug, rpcUrl, rpcUrlFallback }) => (async () => {
      const rpcEndpoints = [rpcUrl, rpcUrlFallback].filter((u): u is string => !!u)
      if (rpcEndpoints.length === 0) return

      let balance: number | null = null
      for (const url of rpcEndpoints) {
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_getBalance', params: [address, 'latest'], id: 1 }),
            signal: AbortSignal.timeout(10_000),
          })
          if (res.ok) {
            const data = await res.json() as { result?: string }
            if (data.result) { balance = Number(BigInt(data.result)) / 1e18; break }
          }
        } catch { /* try next RPC */ }
      }
      if (balance === null) {
        logger.warn({ slug, address }, '[gas-monitor] Registry EVM chain: all RPC endpoints failed for balance fetch')
        return
      }

      // Cache for admin live balance panel (Phase 8)
      await redis.set(`gas_wallet_balance:${slug}`, String(balance), 'EX', 1800)

      const balKey = `gas_registry_balance:${slug}`
      const prevStr = await redis.get(balKey)
      const prevBalance = prevStr !== null ? parseFloat(prevStr) : null
      if (prevBalance !== null) {
        const delta = balance - prevBalance
        if (delta > 0.000_01) {
          logger.info({ slug, delta, balance }, '[gas-monitor] Registry EVM chain deposit detected')
          await appendLedgerEntry({
            entryType:     'external_hot_wallet_deposit',
            chain:         'BSC' as GasChainId,
            chainOverride: { dbChain: slug as import('../lib/gas/gas.chains').DbGasChain, nativeSymbol: symbol },
            nativeAmount:  delta,
            toAddress:     address,
            sourceKey:     `BALANCE_DIFF:${slug}:${address.toLowerCase()}:${symbol}:${Math.floor(Date.now() / (2 * 60_000)) * (2 * 60_000)}`,
            notes: `source:BALANCE_DIFF chain:${slug} prev:${prevBalance.toFixed(6)} now:${balance.toFixed(6)}`,
          }).catch((e) => logger.warn({ err: e, slug }, '[gas-monitor] Failed to write registry EVM deposit ledger entry'))
        }
      }
      await redis.set(balKey, String(balance), 'EX', 1800)
    })()),
    // Aptos APT gas (separate inbound-only rail, no GasHotWallet row)
    monitorAptosGasBalance(),
  ])
}
