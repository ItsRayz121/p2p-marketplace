// Fetches live crypto rates from Binance every 5 minutes
// Writes to Redis AND PlatformConfig
// Called by BullMQ repeatable job

import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { logger } from '../lib/logger'
import { sendAdminAlertEmail } from '../services/email.service'
import { env } from '../lib/env'

const BINANCE_SYMBOLS: Record<string, string> = {
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  BNB: 'BNBUSDT',
  SOL: 'SOLUSDT',
  TRX: 'TRXUSDT',
  AVAX: 'AVAXUSDT',
  TON: 'TONUSDT',
  USDC: 'USDCUSDT',
}

export async function updateRates(): Promise<void> {
  try {
    // 1. Fetch USD/PKR rate
    let usdPkr = 278.5 // fallback
    try {
      const fxRes = await fetch(
        `https://v6.exchangerate-api.com/v6/${env.EXCHANGERATE_API_KEY}/latest/USD`,
        { signal: AbortSignal.timeout(8000) },
      )
      if (fxRes.ok) {
        const fxData = (await fxRes.json()) as { conversion_rates?: Record<string, number> }
        usdPkr = fxData.conversion_rates?.PKR ?? usdPkr
      }
    } catch (e) {
      logger.warn({ err: e }, 'ExchangeRate API failed — using last known USD/PKR')
      // Try to get from Redis cache
      const cached = await redis.get('rate:USD_PKR')
      if (cached) usdPkr = parseFloat(cached)
    }

    // 2. Fetch crypto prices from Binance
    const symbols = Object.values(BINANCE_SYMBOLS)
      .map((s) => `"${s}"`)
      .join(',')
    const binanceRes = await fetch(
      `https://api.binance.com/api/v3/ticker/price?symbols=[${symbols}]`,
      { signal: AbortSignal.timeout(8000) },
    )
    if (!binanceRes.ok) throw new Error(`Binance returned ${binanceRes.status}`)
    const binancePrices = (await binanceRes.json()) as Array<{ symbol: string; price: string }>

    const priceMap: Record<string, number> = {}
    for (const item of binancePrices) {
      priceMap[item.symbol] = parseFloat(item.price)
    }

    // 3. Calculate PKR rates and write to Redis + DB
    const now = new Date().toISOString()
    const updates: Array<{ key: string; value: string }> = []

    // USDT = 1 USD * usdPkr
    updates.push({ key: 'rate_USDT_PKR', value: String(usdPkr.toFixed(2)) })
    await redis.set('rate:USDT', JSON.stringify({ rate: usdPkr, updatedAt: now }), 'EX', 600)

    for (const [coin, symbol] of Object.entries(BINANCE_SYMBOLS)) {
      if (coin === 'USDC') {
        const usdcUsd = priceMap['USDCUSDT'] ?? 1
        const pkr = (usdcUsd * usdPkr).toFixed(2)
        updates.push({ key: `rate_USDC_PKR`, value: pkr })
        await redis.set(
          'rate:USDC',
          JSON.stringify({ rate: parseFloat(pkr), updatedAt: now }),
          'EX',
          600,
        )
        continue
      }
      const usdPrice = priceMap[symbol]
      if (!usdPrice) continue
      const pkrRate = (usdPrice * usdPkr).toFixed(2)
      updates.push({ key: `rate_${coin}_PKR`, value: pkrRate })
      await redis.set(
        `rate:${coin}`,
        JSON.stringify({ rate: parseFloat(pkrRate), updatedAt: now }),
        'EX',
        600,
      )
    }

    // Cache USD/PKR for fallback
    await redis.set('rate:USD_PKR', String(usdPkr), 'EX', 3600)

    // Write to PlatformConfig (upsert each key)
    await Promise.all(
      updates.map(({ key, value }) =>
        db.platformConfig.upsert({ where: { key }, create: { key, value }, update: { value } }),
      ),
    )

    logger.info({ coinsUpdated: updates.length, usdPkr }, 'Rates updated successfully')
  } catch (err) {
    logger.error({ err }, 'Rate update failed')
    // Alert admin on repeated failures (don't alert every time to avoid spam)
    const failCount = await redis.incr('rate_update_fail_count')
    await redis.expire('rate_update_fail_count', 3600)
    if (failCount === 3) {
      await sendAdminAlertEmail(
        'Rate Updater Failed 3 Times',
        `Rate update has failed 3 times in the last hour. Error: ${err instanceof Error ? err.message : String(err)}`,
      ).catch(() => {})
      await redis.del('rate_update_fail_count')
    }
    throw err // Let BullMQ retry
  }
}
