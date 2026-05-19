// Fetches live crypto rates every 5 minutes.
// Source chain: CoinGecko → Bybit → Kraken → Binance → stale Redis cache.
// Binance geo-blocks Railway (451). CoinGecko free tier rate-limits (400).
// Writes to Redis AND PlatformConfig.
//
// ─── HOW TO ADD PRICING FOR A NEW GAS TOKEN ───────────────────────────────────
//
// CASE A — Stablecoin (USDT, USDC, BUSD, DAI, TUSD, USDP, or any USD peg):
//   Set priceSymbol to 'USDT' (or the matching stable symbol) in the DB seed.
//   gasFee.routes.ts hardcodes 1.0 for all STABLECOIN_SYMBOLS — Redis is never
//   consulted. No code change here is needed.
//
// CASE B — Native gas token that already has an entry below (ETH, BNB, TRX,
//   AVAX, MATIC, SOL, TON, SUI, APT, NEAR):
//   Set priceSymbol to the matching symbol in the DB seed. Done — the rate
//   updater already writes rate:{symbol} to Redis every 5 minutes.
//   Example: a new EVM L2 that uses ETH as gas → priceSymbol: 'ETH'. No code
//   change here is needed.
//
// CASE C — Brand-new native token not yet listed below (e.g. 'XYZ'):
//   1. Find its CoinGecko coin ID: coingecko.com/en/coins/xyz → slug in URL.
//   2. Add one entry to each of the three maps below:
//        COINGECKO_IDS:   XYZ: '<coingecko-slug>'
//        BINANCE_SYMBOLS: XYZ: 'XYZUSDT'   (omit if Binance doesn't list it)
//        BYBIT_SYMBOLS:   XYZ: 'XYZUSDT'   (omit if Bybit doesn't list it)
//      Kraken only lists major coins — add to KRAKEN_PAIRS only if confirmed.
//   3. Set priceSymbol: 'XYZ' in the DB seed for that token.
//   After the next rate-updater cycle (~5 min after deploy) the price appears.
//
// ─── CURRENTLY REGISTERED NATIVE TOKENS ──────────────────────────────────────
// Symbol │ Chains that use it
// ───────┼────────────────────────────────────────────────────────────────────
// ETH    │ Ethereum, Arbitrum (ARB), Optimism (OP), Base (BASE)
// BNB    │ BNB Smart Chain (BSC), opBNB
// TRX    │ TRON (also has dedicated CoinPaprika/CryptoCompare fallback)
// AVAX   │ Avalanche C-Chain
// MATIC  │ Polygon (priceSymbol stays 'MATIC' even though token renamed to POL)
// SOL    │ Solana
// TON    │ TON
// SUI    │ SUI
// APT    │ Aptos
// NEAR   │ NEAR Protocol
// ─────────────────────────────────────────────────────────────────────────────

import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { logger } from '../lib/logger'
import { sendAdminAlertEmail } from '../services/email.service'
import { env } from '../lib/env'

const COINGECKO_IDS: Record<string, string> = {
  BTC:  'bitcoin',
  ETH:  'ethereum',
  BNB:  'binancecoin',
  SOL:  'solana',
  TRX:  'tron',
  AVAX: 'avalanche-2',
  MATIC: 'matic-network',
  TON:  'the-open-network',
  SUI:  'sui',
  APT:  'aptos',
  NEAR: 'near',
  USDC: 'usd-coin',
}

const BINANCE_SYMBOLS: Record<string, string> = {
  BTC:  'BTCUSDT',
  ETH:  'ETHUSDT',
  BNB:  'BNBUSDT',
  SOL:  'SOLUSDT',
  TRX:  'TRXUSDT',
  AVAX: 'AVAXUSDT',
  MATIC: 'MATICUSDT',
  TON:  'TONUSDT',
  SUI:  'SUIUSDT',
  APT:  'APTUSDT',
  NEAR: 'NEARUSDT',
  USDC: 'USDCUSDT',
}

// Kraken pairs (quote = USD) — Kraken lists only major coins; add here only
// when confirmed listed: kraken.com/features/api#get-ticker-information
const KRAKEN_PAIRS: Record<string, string> = {
  BTC: 'XBTUSD',
  ETH: 'ETHUSD',
  SOL: 'SOLUSD',
  AVAX: 'AVAXUSD',
  USDC: 'USDCUSD',
}

// Bybit symbols (spot, USDT quote)
const BYBIT_SYMBOLS: Record<string, string> = {
  BTC:  'BTCUSDT',
  ETH:  'ETHUSDT',
  BNB:  'BNBUSDT',
  SOL:  'SOLUSDT',
  TRX:  'TRXUSDT',
  AVAX: 'AVAXUSDT',
  MATIC: 'MATICUSDT',
  TON:  'TONUSDT',
  SUI:  'SUIUSDT',
  APT:  'APTUSDT',
  NEAR: 'NEARUSDT',
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

// Lightweight dedicated TRX/USD fetchers.
// CoinPaprika and CryptoCompare are free, no API key, and are not geo-blocked
// on Railway cloud. Called after the bulk source succeeds but is missing TRX
// (e.g. Kraken does not list TRX pairs).
async function fetchTrxUsdPrice(): Promise<number | null> {
  const attempts: Array<{ name: string; fn: () => Promise<number> }> = [
    {
      name: 'coinpaprika',
      fn: async () => {
        const res = await fetch('https://api.coinpaprika.com/v1/tickers/trx-tron', {
          signal: AbortSignal.timeout(8000),
        })
        if (!res.ok) throw new Error(`CoinPaprika HTTP ${res.status}`)
        const data = (await res.json()) as { quotes?: { USD?: { price?: number } } }
        const price = data.quotes?.USD?.price
        if (!price) throw new Error('CoinPaprika: no TRX price in response')
        return price
      },
    },
    {
      name: 'cryptocompare',
      fn: async () => {
        const res = await fetch(
          'https://min-api.cryptocompare.com/data/price?fsym=TRX&tsyms=USD',
          { signal: AbortSignal.timeout(8000) },
        )
        if (!res.ok) throw new Error(`CryptoCompare HTTP ${res.status}`)
        const data = (await res.json()) as { USD?: number }
        const price = data.USD
        if (!price) throw new Error('CryptoCompare: no TRX price in response')
        return price
      },
    },
    {
      name: 'coingecko-simple',
      fn: async () => {
        // Single-coin request — much less likely to be rate-limited than the full batch.
        const isPro = !!env.COINGECKO_API_KEY
        const base = isPro
          ? 'https://pro-api.coingecko.com/api/v3'
          : 'https://api.coingecko.com/api/v3'
        const headers: Record<string, string> = isPro
          ? { 'x-cg-pro-api-key': env.COINGECKO_API_KEY! }
          : {}
        const res = await fetch(`${base}/simple/price?ids=tron&vs_currencies=usd`, {
          headers,
          signal: AbortSignal.timeout(8000),
        })
        if (!res.ok) throw new Error(`CoinGecko simple HTTP ${res.status}`)
        const data = (await res.json()) as { tron?: { usd?: number } }
        const price = data.tron?.usd
        if (!price) throw new Error('CoinGecko simple: no TRX price')
        return price
      },
    },
  ]

  for (const { name, fn } of attempts) {
    try {
      const price = await fn()
      logger.info({ source: name, trxUsdPrice: price }, 'TRX price fetched from dedicated source')
      return price
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn({ source: name, err: msg }, `Dedicated TRX fetcher ${name} failed — trying next`)
    }
  }
  logger.error('All dedicated TRX price fetchers failed — rate:TRX will not be updated this cycle')
  return null
}

// Try each source in order; return first non-empty priceMap with source label.
// Sources are accepted even if they are missing some coins (e.g. Kraken has no
// TRX pairs). Missing gas-critical coins are patched in separately afterwards
// by fetchTrxUsdPrice, so we never reject a whole source just because it lacks TRX.
async function fetchPricesWithFallback(): Promise<{ priceMap: Record<string, number>; source: string }> {
  const sources: Array<{ name: string; fn: () => Promise<Record<string, number>> }> = [
    { name: 'coingecko', fn: fetchPricesFromCoinGecko },
    { name: 'bybit', fn: fetchPricesFromBybit },
    { name: 'kraken', fn: fetchPricesFromKraken },
    { name: 'binance', fn: fetchPricesFromBinance },
  ]

  const errors: string[] = []
  for (const { name, fn } of sources) {
    try {
      const priceMap = await fn()
      logger.info({ coins: Object.keys(priceMap), source: name }, 'Prices fetched')
      return { priceMap, source: name }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn({ source: name, err: msg }, `${name} failed — trying next source`)
      errors.push(`${name}: ${msg}`)
    }
  }

  // All live sources failed — try stale Redis cache.
  // Redis stores { rate: pkrRate, usdPrice: number } per coin. We read usdPrice
  // directly (new format) and fall back to pkrRate / USD_PKR for old-format keys.
  logger.warn('All price sources failed — attempting stale Redis cache')
  const usdPkrStr = await redis.get('rate:USD_PKR')
  const cachedUsdPkr = usdPkrStr ? parseFloat(usdPkrStr) : 278.5
  const coins = Object.keys(COINGECKO_IDS)
  const priceMap: Record<string, number> = {}
  for (const coin of coins) {
    const cached = await redis.get(`rate:${coin}`)
    if (cached) {
      const parsed = JSON.parse(cached) as { rate: number; usdPrice?: number }
      if (parsed.usdPrice !== undefined && parsed.usdPrice > 0) {
        priceMap[coin] = parsed.usdPrice
      } else if (parsed.rate > 0 && cachedUsdPkr > 0) {
        // Legacy format: rate field holds PKR rate — convert back to USD
        priceMap[coin] = parsed.rate / cachedUsdPkr
      }
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

    // 2b. Fill in any gas-critical coins that the bulk source didn't cover.
    // Kraken (which often wins on Railway) lacks TRX — fetch it separately.
    if (!priceMap['TRX']) {
      logger.warn({ source: priceSource }, 'TRX missing from bulk source — running dedicated TRX fetcher')
      const trxUsd = await fetchTrxUsdPrice()
      if (trxUsd) priceMap['TRX'] = trxUsd
    }

    // 3. Calculate PKR rates and write to Redis + DB
    const now = new Date().toISOString()
    const updates: Array<{ key: string; value: string }> = []

    updates.push({ key: 'rate_USDT_PKR', value: String(usdPkr.toFixed(2)) })
    await redis.set('rate:USDT', JSON.stringify({ rate: usdPkr, usdPrice: 1.0, updatedAt: now, source: priceSource }), 'EX', 3600)

    const skippedCoins: string[] = []
    for (const coin of Object.keys(COINGECKO_IDS)) {
      const usdPrice = priceMap[coin]
      if (!usdPrice) {
        skippedCoins.push(coin)
        continue
      }
      const pkrRate = (usdPrice * usdPkr).toFixed(2)
      const redisKey = `rate:${coin}`
      // Store both usdPrice (for direct use) and rate/PKR (for PKR display).
      // TTL is 3600s — long enough to survive 1-hour gaps in the updater job.
      const redisValue = JSON.stringify({ rate: parseFloat(pkrRate), usdPrice, updatedAt: now, source: priceSource })
      updates.push({ key: `rate_${coin}_PKR`, value: pkrRate })
      logger.debug({ key: redisKey, usdPrice, pkrRate }, 'Setting coin rate in Redis')
      await redis.set(redisKey, redisValue, 'EX', 3600)
      logger.debug({ key: redisKey }, 'Redis SET confirmed')
    }

    if (skippedCoins.length > 0) {
      logger.warn({ skippedCoins, source: priceSource }, 'Some coins missing from priceMap — Redis keys NOT written for these coins')
    }

    await redis.set('rate:USD_PKR', String(usdPkr), 'EX', 3600)
    logger.debug({ key: 'rate:USD_PKR', usdPkr }, 'Redis SET rate:USD_PKR confirmed')

    await Promise.all(
      updates.map(({ key, value }) =>
        db.platformConfig.upsert({ where: { key }, create: { key, value }, update: { value } }),
      ),
    )

    await redis.del('rate_update_fail_count')

    logger.info(
      { coinsUpdated: updates.length, skippedCoins, usdPkr, source: priceSource, writtenKeys: updates.map(u => u.key) },
      'Rates updated successfully',
    )
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
