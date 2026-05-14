import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { env } from '../lib/env'
import { logger } from '../lib/logger'
import { sendAdminAlertEmail } from '../services/email.service'

const BALANCE_KEY = 'gas_wallet_balance:TRON'
const PAUSED_KEY = 'gas_wallet_paused:TRON'
// TTL for the auto-pause flag: next monitor run (5 min) will re-evaluate and
// either extend or clear it — so 6 min gives a comfortable margin.
const PAUSED_TTL_S = 360

async function getTronBalanceTRX(address: string): Promise<number> {
  const url = `${env.TRON_FULLNODE_URL}/v1/accounts/${encodeURIComponent(address)}`
  const headers: Record<string, string> = {}
  if (env.TRONGRID_API_KEY) headers['TRONGRID-API-Key'] = env.TRONGRID_API_KEY

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`TronGrid accounts API error: HTTP ${res.status}`)

  const data = (await res.json()) as { data?: Array<{ balance?: number }> }
  const balanceSun = data.data?.[0]?.balance ?? 0
  return balanceSun / 1_000_000 // SUN → TRX
}

export async function runGasMonitorBalances() {
  const wallet = await db.gasHotWallet.findUnique({ where: { chain: 'TRON' } })
  if (!wallet) {
    logger.warn('No TRON hot wallet configured — skipping balance monitor')
    return
  }

  let balanceTRX: number
  try {
    balanceTRX = await getTronBalanceTRX(wallet.address)
  } catch (err) {
    logger.error({ err }, 'Failed to fetch TRON hot wallet balance from TronGrid')
    return
  }

  // Cache in Redis (30 min TTL so admin dashboard always has a recent value)
  await redis.set(BALANCE_KEY, String(balanceTRX), 'EX', 1800)
  logger.info({ balanceTRX, address: wallet.address }, 'Gas hot wallet balance refreshed')

  const alertThreshold = env.GAS_WALLET_ALERT_THRESHOLD_TRON
  const pauseThreshold = env.GAS_WALLET_PAUSE_THRESHOLD_TRON

  if (balanceTRX < pauseThreshold) {
    // Set auto-pause flag — order creation checks this key before accepting orders
    await redis.set(PAUSED_KEY, '1', 'EX', PAUSED_TTL_S)
    logger.error({ balanceTRX, pauseThreshold }, 'Gas hot wallet CRITICAL — below pause threshold, new orders paused')
    await sendAdminAlertEmail(
      'CRITICAL: Gas Hot Wallet Below Pause Threshold',
      `TRON hot wallet balance: ${balanceTRX.toFixed(2)} TRX\n` +
      `Pause threshold: ${pauseThreshold} TRX\n\n` +
      `New gas orders are now automatically paused. Please top up the hot wallet immediately.\n\n` +
      `Wallet address: ${wallet.address}`,
    )
  } else if (balanceTRX < alertThreshold) {
    await redis.del(PAUSED_KEY)
    logger.warn({ balanceTRX, alertThreshold }, 'Gas hot wallet LOW — below alert threshold')
    await sendAdminAlertEmail(
      'WARNING: Gas Hot Wallet Low Balance',
      `TRON hot wallet balance: ${balanceTRX.toFixed(2)} TRX\n` +
      `Alert threshold: ${alertThreshold} TRX\n\n` +
      `Please top up the hot wallet soon to avoid service interruption.\n\n` +
      `Wallet address: ${wallet.address}`,
    )
  } else {
    // Healthy — clear any stale auto-pause flag
    await redis.del(PAUSED_KEY)
  }
}
