import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { getHotWalletBalance } from '../lib/gas/gas.balance'
import { getGasChain, fromDbChain } from '../lib/gas/gas.chains'
import { sendAdminAlertEmail } from '../services/email.service'
import { logger } from '../lib/logger'
import type { GasChainId } from '../lib/gas/gas.chains'

// TTL for the auto-pause flag: next monitor run (5 min) will re-evaluate and
// either extend or clear it — so 6 min gives a comfortable margin.
const PAUSED_TTL_S = 360

async function monitorChain(chain: GasChainId, address: string): Promise<void> {
  const chainConfig = getGasChain(chain)
  const balanceKey = `gas_wallet_balance:${chain}`
  const pausedKey  = `gas_wallet_paused:${chain}`

  let balance: number
  try {
    balance = await getHotWalletBalance(chain, address)
  } catch (err) {
    logger.error({ err, chain }, 'Failed to fetch gas hot wallet balance')
    return
  }

  // Cache in Redis (30 min TTL so admin dashboard always has a recent value)
  await redis.set(balanceKey, String(balance), 'EX', 1800)
  logger.info({ balance, address, chain }, 'Gas hot wallet balance refreshed')

  const alertThreshold = chainConfig.getAlertThreshold()
  const pauseThreshold = chainConfig.getPauseThreshold()
  const symbol = chainConfig.nativeSymbol

  if (balance < pauseThreshold) {
    await redis.set(pausedKey, '1', 'EX', PAUSED_TTL_S)
    logger.error({ balance, pauseThreshold, chain }, 'Gas hot wallet CRITICAL — below pause threshold')
    await sendAdminAlertEmail(
      `CRITICAL: ${chain} Gas Hot Wallet Below Pause Threshold`,
      `${chain} hot wallet balance: ${balance.toFixed(6)} ${symbol}\n` +
      `Pause threshold: ${pauseThreshold} ${symbol}\n\n` +
      `New gas orders on ${chain} are now automatically paused. Please top up the hot wallet immediately.\n\n` +
      `Wallet address: ${address}`,
    )
  } else if (balance < alertThreshold) {
    await redis.del(pausedKey)
    logger.warn({ balance, alertThreshold, chain }, 'Gas hot wallet LOW — below alert threshold')
    await sendAdminAlertEmail(
      `WARNING: ${chain} Gas Hot Wallet Low Balance`,
      `${chain} hot wallet balance: ${balance.toFixed(6)} ${symbol}\n` +
      `Alert threshold: ${alertThreshold} ${symbol}\n\n` +
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

  // Monitor all active chains in parallel; individual failures don't abort others
  await Promise.allSettled(
    wallets.map((w) => monitorChain(fromDbChain(w.chain), w.address)),
  )
}
