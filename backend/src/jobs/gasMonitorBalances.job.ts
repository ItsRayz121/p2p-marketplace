import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { env } from '../lib/env'
import { getHotWalletBalance, getNativeUsdPrice } from '../lib/gas/gas.balance'
import { fromDbChain } from '../lib/gas/gas.chains'
import { getAptosHotWalletAddress } from '../lib/gas/aptosWalletService'
import { getAptosNativeBalance } from '../lib/gas/aptosRefund'
import { sendAdminAlertEmail } from '../services/email.service'
import { logger } from '../lib/logger'
import type { GasChainId } from '../lib/gas/gas.chains'
import { createAdminNotif } from '../services/adminNotification.service'

// Aptos is an inbound-only USDT rail (no GasHotWallet row), but its hot wallet
// still needs native APT to pay gas for outgoing USDT refunds. Monitor it
// separately so admins are warned before refunds start failing.
const APT_LOW_ALERT_KEY = 'gas_aptos_apt_low_alerted'
const APT_LOW_ALERT_TTL_S = 6 * 3600 // re-alert at most every 6h

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
        body:     `APT balance ${apt.toFixed(4)} is below ${minApt} APT. Aptos USDT refunds need APT for gas — top up to avoid failures.`,
        href:     '/admin/gas',
        metadata: { apt, minApt, address },
      })
      await sendAdminAlertEmail(
        'WARNING: Aptos Gas Hot Wallet Low on APT',
        `The Aptos hot wallet is low on native APT (used to pay gas for USDT refunds).\n\n` +
        `  APT balance:  ${apt.toFixed(6)} APT\n` +
        `  Alert floor:  ${minApt} APT\n\n` +
        `Aptos USDT refunds will fail once APT runs out. Top up APT to:\n${address}`,
      )
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
      body:     `${chain} balance $${balanceUsd.toFixed(2)} is below pause threshold $${pauseThresholdUsd}. New orders paused.`,
      href:     `/admin/gas`,
      metadata: { chain, balanceUsd, pauseThresholdUsd },
    })
    await sendAdminAlertEmail(
      `CRITICAL: ${chain} Gas Hot Wallet Below Pause Threshold`,
      `${chain} hot wallet\n` +
      `  Balance:         $${balanceUsd.toFixed(2)} USD (${balance.toFixed(6)} native)\n` +
      `  Pause threshold: $${pauseThresholdUsd} USD\n\n` +
      `New gas orders on ${chain} are now automatically paused. Please top up the hot wallet immediately.\n\n` +
      `Wallet address: ${address}`,
    )
  } else if (alertThresholdUsd !== null && balanceUsd <= alertThresholdUsd) {
    await redis.del(pausedKey)
    logger.warn({ balanceUsd, alertThresholdUsd, chain }, 'Gas hot wallet LOW — below alert threshold (USD)')
    void createAdminNotif({
      category: 'GAS',
      title:    `WARNING: ${chain} Hot Wallet Low Balance`,
      body:     `${chain} balance $${balanceUsd.toFixed(2)} is below alert threshold $${alertThresholdUsd}.`,
      href:     `/admin/gas`,
      metadata: { chain, balanceUsd, alertThresholdUsd },
    })
    await sendAdminAlertEmail(
      `WARNING: ${chain} Gas Hot Wallet Low Balance`,
      `${chain} hot wallet\n` +
      `  Balance:         $${balanceUsd.toFixed(2)} USD (${balance.toFixed(6)} native)\n` +
      `  Alert threshold: $${alertThresholdUsd} USD\n\n` +
      `Please top up the hot wallet soon to avoid service interruption.\n\n` +
      `Wallet address: ${address}`,
    )
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

  // Monitor all active chains in parallel; individual failures don't abort others
  await Promise.allSettled([
    ...wallets.map((w) => {
      const chain = fromDbChain(w.chain)
      const dbChain = w.chain as string
      const thresholds: ChainThresholds = thresholdMap[dbChain] ?? { alertThresholdUsd: null, pauseThresholdUsd: null }
      return monitorChain(chain, w.id, w.address, thresholds)
    }),
    // Aptos APT gas (separate inbound-only rail, no GasHotWallet row)
    monitorAptosGasBalance(),
  ])
}
