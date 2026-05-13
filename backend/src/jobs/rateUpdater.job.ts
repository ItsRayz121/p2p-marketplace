// Fetches live crypto rates every 5 minutes.
// Primary source: CoinGecko (no geo-blocking).
// Fallback: Binance (blocked by 451 from some Railway regions).
// Writes to Redis AND PlatformConfig.

import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { logger } from '../lib/logger'
import { sendAdminAlertEmail } from '../services/email.service'
import { env } from '../lib/env'

// CoinGecko coin ID mapping
const COINGECKO_IDS: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  BNB: 'binancecoin',
  SOL: 'solana',
  TRX: 'tron',
  AVAX: 'avalanche-2',
  TON: 'the-open-network',
  USDC: 'usd-coin',
}

// Binance symbol mapping (kept as fallback)
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

// Returns { COIN: usdPrice } for all supported coins
async function fetchPricesFromCoinGecko(): Promise<Record<string, number>> {
  const ids = Object.values(COINGECKO_IDS).join(',')
  const isPro = !!env.COINGECKO_API_KEY
  const baseUrl = isPro
    ? 'https://pro-api.coingecko.com/api/v3'
    : 'https://api.coingecko.com/api/v3'
  const headers: Record<string, string> = {}
  if (isPro) headers['x-cg-pro-api-key'] = env.COINGECKO_API_KEY!

  const res = await fetch(`${baseUrl}/simple/price?ids=${ids}&vs_currencies=usd`, {
    headers,
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`CoinGecko returned ${res.status}`)

  const data = (await res.json()) as Record<string, { usd?: number }>
  const priceMap: Record<string, number> = {}
  for (const [coin, geckoId] of Object.entries(COINGECKO_IDS)) {
    const price = data[geckoId]?.usd
    if (price !== undefined) priceMap[coin] = price
  }
  return priceMap
}

// Fallback — Binance may return 451 (geo-block) from some server regions
async function fetchPricesFromBinance(): Promise<Record<string, number>> {
  const symbols = Object.values(BINANCE_SYMBOLS)
    .map((s) => `"${s}"`)
    .join(',')
  const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbols=[${symbols}]`, {
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`Binance returned ${res.status}`)

  const prices = (await res.json()) as Array<{ symbol: string; price: string }>
  const priceMap: Record<string, number> = {}
  for (const { symbol, price } of prices) {
    for (const [coin, sym] of Object.entries(BINANCE_SYMBOLS)) {
      if (sym === symbol) {
        priceMap[coin] = parseFloat(price)
        break
      }
    }
  }
  return priceMap
}

export async function updateRates(): Promise<void> {
  try {
    // 1. Fetch USD/PKR rate
    let usdPkr = 278.5 // hardcoded fallback
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
      const cached = await redis.get('rate:USD_PKR')
      if (cached) usdPkr = parseFloat(cached)
    }

    // 2. Fetch crypto prices — CoinGecko first, Binance as fallback
    let priceMap: Record<string, number> = {}
    let priceSource = 'coingecko'
    try {
      priceMap = await fetchPricesFromCoinGecko()
      logger.info({ coins: Object.keys(priceMap).length }, 'Prices fetched from CoinGecko')
    } catch (geckoErr) {
      logger.warn({ err: geckoErr }, 'CoinGecko failed — trying Binance fallback')
      priceSource = 'binance'
      priceMap = await fetchPricesFromBinance()
      logger.info({ coins: Object.keys(priceMap).length }, 'Prices fetched from Binance')
    }

    // 3. Calculate PKR rates and write to Redis + DB
    const now = new Date().toISOString()
    const updates: Array<{ key: string; value: string }> = []

    // USDT pegged to USD
    updates.push({ key: 'rate_USDT_PKR', value: String(usdPkr.toFixed(2)) })
    await redis.set('rate:USDT', JSON.stringify({ rate: usdPkr, updatedAt: now, source: priceSource }), 'EX', 600)

    for (const coin of Object.keys(COINGECKO_IDS)) {
      const usdPrice = priceMap[coin]
      if (!usdPrice) continue
      const pkrRate = (usdPrice * usdPkr).toFixed(2)
      updates.push({ key: `rate_${coin}_PKR`, value: pkrRate })
      await redis.set(
        `rate:${coin}`,
        JSON.stringify({ rate: parseFloat(pkrRate), updatedAt: now, source: priceSource }),
        'EX',
        600,
      )
    }

    // Cache USD/PKR for ExchangeRate API fallback
    await redis.set('rate:USD_PKR', String(usdPkr), 'EX', 3600)

    // Write to PlatformConfig
    await Promise.all(
      updates.map(({ key, value }) =>
        db.platformConfig.upsert({ where: { key }, create: { key, value }, update: { value } }),
      ),
    )

    // Reset failure counter on success
    await redis.del('rate_update_fail_count')

    logger.info({ coinsUpdated: updates.length, usdPkr, source: priceSource }, 'Rates updated successfully')
  } catch (err) {
    logger.error({ err }, 'Rate update failed')
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
