import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { getHotWalletBalance, getNativeUsdPrice } from '../lib/gas/gas.balance'
import { fromDbChain } from '../lib/gas/gas.chains'
import { sendAdminAlertEmail } from '../services/email.service'
import { logger } from '../lib/logger'
import type { GasChainId } from '../lib/gas/gas.chains'
import { createAdminNotif } from '../services/adminNotification.service'

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
    logger.error({ balanceUsd, pauseThresholdUsd, chain }, 'Gas hot wallet CRITICAL — below pause threshold (USD)')
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
  await Promise.allSettled(
    wallets.map((w) => {
      const chain = fromDbChain(w.chain)
      const dbChain = w.chain as string
      const thresholds: ChainThresholds = thresholdMap[dbChain] ?? { alertThresholdUsd: null, pauseThresholdUsd: null }
      return monitorChain(chain, w.id, w.address, thresholds)
    }),
  )
}
