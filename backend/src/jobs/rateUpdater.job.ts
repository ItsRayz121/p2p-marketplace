// Fetches live crypto rates every 5 minutes.
// Source chain: CoinGecko → Kraken → Bybit → Binance → stale Redis cache.
// Binance geo-blocks Railway (451). CoinGecko free tier rate-limits (400).
// Writes to Redis AND PlatformConfig.

import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { logger } from '../lib/logger'
import { sendAdminAlertEmail } from '../services/email.service'
import { env } from '../lib/env'

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

// Kraken pairs (quote = USD)
const KRAKEN_PAIRS: Record<string, string> = {
  BTC: 'XBTUSD',
  ETH: 'ETHUSD',
  SOL: 'SOLUSD',
  AVAX: 'AVAXUSD',
  USDC: 'USDCUSD',
}

// Bybit symbols (linear USDT perps, price ≈ spot)
const BYBIT_SYMBOLS: Record<string, string> = {
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  BNB: 'BNBUSDT',
  SOL: 'SOLUSDT',
  TRX: 'TRXUSDT',
  AVAX: 'AVAXUSDT',
  TON: 'TONUSDT',
  USDC: 'USDCUSDT',
}

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
  if (Object.keys(priceMap).length === 0) throw new Error('CoinGecko returned empty price map')
  return priceMap
}

async function fetchPricesFromKraken(): Promise<Record<string, number>> {
  const pairList = Object.values(KRAKEN_PAIRS).join(',')
  const res = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${pairList}`, {
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`Kraken returned ${res.status}`)

  const body = (await res.json()) as { error: string[]; result: Record<string, { c: [string] }> }
  if (body.error?.length) throw new Error(`Kraken error: ${body.error.join(', ')}`)

  const priceMap: Record<string, number> = {}
  for (const [coin, pair] of Object.entries(KRAKEN_PAIRS)) {
    // Kraken may return the pair with a prefix (XXBTZUSD vs XBTUSD)
    const entry = Object.entries(body.result).find(([k]) => k.includes(pair) || pair.includes(k))
    if (entry) priceMap[coin] = parseFloat(entry[1].c[0])
  }
  if (Object.keys(priceMap).length === 0) throw new Error('Kraken returned empty price map')
  return priceMap
}

async function fetchPricesFromBybit(): Promise<Record<string, number>> {
  const res = await fetch('https://api.bybit.com/v5/market/tickers?category=spot', {
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`Bybit returned ${res.status}`)

  const body = (await res.json()) as {
    retCode: number
    result: { list: Array<{ symbol: string; lastPrice: string }> }
  }
  if (body.retCode !== 0) throw new Error(`Bybit retCode ${body.retCode}`)

  const symbolMap = new Map(body.result.list.map((t) => [t.symbol, t.lastPrice]))
  const priceMap: Record<string, number> = {}
  for (const [coin, sym] of Object.entries(BYBIT_SYMBOLS)) {
    const p = symbolMap.get(sym)
    if (p) priceMap[coin] = parseFloat(p)
  }
  if (Object.keys(priceMap).length === 0) throw new Error('Bybit returned empty price map')
  return priceMap
}

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

// Try each source in order; return first success with source label.
async function fetchPricesWithFallback(): Promise<{ priceMap: Record<string, number>; source: string }> {
  const sources: Array<{ name: string; fn: () => Promise<Record<string, number>> }> = [
    { name: 'coingecko', fn: fetchPricesFromCoinGecko },
    { name: 'kraken', fn: fetchPricesFromKraken },
    { name: 'bybit', fn: fetchPricesFromBybit },
    { name: 'binance', fn: fetchPricesFromBinance },
  ]

  const errors: string[] = []
  for (const { name, fn } of sources) {
    try {
      const priceMap = await fn()
      logger.info({ coins: Object.keys(priceMap).length, source: name }, 'Prices fetched')
      return { priceMap, source: name }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn({ source: name, err: msg }, `${name} failed — trying next source`)
      errors.push(`${name}: ${msg}`)
    }
  }

  // All live sources failed — try stale Redis cache
  logger.warn('All price sources failed — attempting stale Redis cache')
  const coins = Object.keys(COINGECKO_IDS)
  const priceMap: Record<string, number> = {}
  for (const coin of coins) {
    const cached = await redis.get(`rate:${coin}`)
    if (cached) {
      const parsed = JSON.parse(cached) as { rate: number }
      priceMap[coin] = parsed.rate
    }
  }
  if (Object.keys(priceMap).length > 0) {
    logger.warn({ coins: Object.keys(priceMap).length }, 'Using stale cached prices')
    return { priceMap, source: 'stale-cache' }
  }

  throw new Error(`All price sources failed:\n${errors.join('\n')}`)
}

export async function updateRates(): Promise<void> {
  try {
    // 1. Fetch USD/PKR rate
    let usdPkr = 278.5
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

    // 2. Fetch crypto prices with multi-source fallback chain
    const { priceMap, source: priceSource } = await fetchPricesWithFallback()

    // 3. Calculate PKR rates and write to Redis + DB
    const now = new Date().toISOString()
    const updates: Array<{ key: string; value: string }> = []

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

    await redis.set('rate:USD_PKR', String(usdPkr), 'EX', 3600)

    await Promise.all(
      updates.map(({ key, value }) =>
        db.platformConfig.upsert({ where: { key }, create: { key, value }, update: { value } }),
      ),
    )

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
    throw err
  }
}
