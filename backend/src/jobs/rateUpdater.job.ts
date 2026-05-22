// Fetches live crypto rates every 5 minutes.
// Source chain: CoinGecko → FreeCryptoApi → CoinStats → Bybit → Kraken → Binance → CMC(emergency) → stale Redis cache.
// Binance geo-blocks Railway (451). CoinGecko free tier rate-limits (400).
// CMC is emergency-only (charged 1 credit/coin — stays out of the regular 5-min cycle).
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
// MATIC  │ Polygon legacy alias — kept for backward compat; same price as POL
// POL    │ Polygon native token (renamed from MATIC, Sept 2024). Both rate:MATIC
//          and rate:POL are written every cycle so all lookup paths resolve.
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
  POL:   'matic-network',  // POL = renamed MATIC (same CoinGecko slug, backward-compat)
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
  MATIC: 'MATICUSDT',  // legacy — may be delisted; POL below is primary
  POL:   'POLUSDT',    // Polygon native renamed MATIC→POL (Sept 2024)
  TON:  'TONUSDT',
  SUI:  'SUIUSDT',
  APT:  'APTUSDT',
  NEAR: 'NEARUSDT',
  USDC: 'USDCUSDT',
}

// Kraken pairs — MUST use Kraken's canonical internal pair names, NOT aliases.
// When you request 'ETHUSD', Kraken returns the key 'XETHZUSD' in its response.
// The matching logic does k.includes(pair), so 'XETHZUSD'.includes('ETHUSD') = FALSE.
// Using the canonical name ensures exact matching.
// Kraken canonical names: BTC=XXBTZUSD, ETH=XETHZUSD. Newer coins (SOL/AVAX/USDC) use simple names.
// Kraken does NOT list BNB or TRX — those are handled by dedicated fetchers.
const KRAKEN_PAIRS: Record<string, string> = {
  BTC:  'XXBTZUSD',
  ETH:  'XETHZUSD',
  SOL:  'SOLUSD',
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
  MATIC: 'MATICUSDT',  // legacy — may be delisted; POL below is primary
  POL:   'POLUSDT',    // Polygon native renamed MATIC→POL (Sept 2024)
  TON:  'TONUSDT',
  SUI:  'SUIUSDT',
  APT:  'APTUSDT',
  NEAR: 'NEARUSDT',
  USDC: 'USDCUSDT',
}

// FreeCryptoApi symbol map — their API uses uppercase ticker symbols directly.
// Endpoint: GET https://api.freecryptoapi.com/v1/getData?symbol=BTC,ETH,...
// Auth: Authorization: {apiKey} header
// Response: { data: { BTC: { price: number }, ETH: { price: number }, ... } }
const FREECRYPTOAPI_SYMBOLS: Record<string, string> = {
  BTC:  'BTC',
  ETH:  'ETH',
  BNB:  'BNB',
  SOL:  'SOL',
  TRX:  'TRX',
  AVAX: 'AVAX',
  MATIC: 'MATIC',
  POL:   'POL',   // Polygon native renamed MATIC→POL (Sept 2024)
  TON:  'TON',
  SUI:  'SUI',
  APT:  'APT',
  NEAR: 'NEAR',
  USDC: 'USDC',
}

async function fetchPricesFromFreeCryptoApi(): Promise<Record<string, number>> {
  if (!env.FREECRYPTOAPI_KEY) throw new Error('FREECRYPTOAPI_KEY not set — skipping')
  const symbols = Object.values(FREECRYPTOAPI_SYMBOLS).join(',')
  const res = await fetch(
    `https://api.freecryptoapi.com/v1/getData?symbol=${symbols}`,
    {
      headers: { Authorization: env.FREECRYPTOAPI_KEY },
      signal: AbortSignal.timeout(8000),
    },
  )
  if (!res.ok) throw new Error(`FreeCryptoApi returned ${res.status}`)

  const body = (await res.json()) as { data?: Record<string, { price?: number }> }
  if (!body.data) throw new Error('FreeCryptoApi: unexpected response shape (no data field)')

  const priceMap: Record<string, number> = {}
  for (const [coin, sym] of Object.entries(FREECRYPTOAPI_SYMBOLS)) {
    const price = body.data[sym]?.price
    if (price && price > 0) priceMap[coin] = price
  }
  if (Object.keys(priceMap).length === 0) throw new Error('FreeCryptoApi returned empty price map')
  return priceMap
}

// ── CoinStats ─────────────────────────────────────────────────────────────────
// Endpoint: GET https://openapi.coinstats.app/public/v1/coins?currency=USD&limit=250
// Auth: X-API-KEY header
// Response: { coins: [{ symbol: string, price: number }] }
// Free tier: 20,000 requests/month. At 288 runs/day × 30 = 8,640/month — well within.
const COINSTATS_SYMBOLS = new Set(['BTC','ETH','BNB','SOL','TRX','AVAX','MATIC','POL','TON','SUI','APT','NEAR','USDC'])

async function fetchPricesFromCoinStats(): Promise<Record<string, number>> {
  if (!env.COINSTATS_API_KEY) throw new Error('COINSTATS_API_KEY not set — skipping')
  const res = await fetch(
    'https://openapi.coinstats.app/public/v1/coins?currency=USD&limit=250',
    {
      headers: { 'X-API-KEY': env.COINSTATS_API_KEY },
      signal: AbortSignal.timeout(8000),
    },
  )
  if (!res.ok) throw new Error(`CoinStats returned ${res.status}`)
  const body = (await res.json()) as { coins?: Array<{ symbol: string; price: number }> }
  if (!body.coins?.length) throw new Error('CoinStats: empty coins array')

  const priceMap: Record<string, number> = {}
  for (const coin of body.coins) {
    const sym = coin.symbol?.toUpperCase()
    if (sym && COINSTATS_SYMBOLS.has(sym) && coin.price > 0) {
      priceMap[sym] = coin.price
    }
  }
  if (Object.keys(priceMap).length === 0) throw new Error('CoinStats: no matching coins found in response')
  return priceMap
}

// ── CoinMarketCap — emergency-only ────────────────────────────────────────────
// 1 credit charged per coin per call. Free plan = 10,000 credits/month.
// At 12 coins × 288 runs/day this burns 103,680 credits — far over the limit.
// Therefore: used ONLY when ALL bulk sources fail, not in the regular 5-min chain.
// Endpoint: GET https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=BTC,ETH,...
// Auth: X-CMC_PRO_API_KEY header
// Response: { data: { BTC: { quote: { USD: { price: number } } } } }
const CMC_SYMBOLS = ['BTC','ETH','BNB','SOL','TRX','AVAX','MATIC','POL','TON','SUI','APT','NEAR','USDC']

async function fetchPricesFromCoinMarketCap(): Promise<Record<string, number>> {
  if (!env.CMC_API_KEY) throw new Error('CMC_API_KEY not set — skipping')
  const symbols = CMC_SYMBOLS.join(',')
  const res = await fetch(
    `https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=${symbols}&convert=USD`,
    {
      headers: { 'X-CMC_PRO_API_KEY': env.CMC_API_KEY, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    },
  )
  if (!res.ok) throw new Error(`CoinMarketCap returned ${res.status}`)
  const body = (await res.json()) as {
    data?: Record<string, { quote?: { USD?: { price?: number } } }>
  }
  if (!body.data) throw new Error('CoinMarketCap: unexpected response (no data field)')

  const priceMap: Record<string, number> = {}
  for (const sym of CMC_SYMBOLS) {
    const price = body.data[sym]?.quote?.USD?.price
    if (price && price > 0) priceMap[sym] = price
  }
  if (Object.keys(priceMap).length === 0) throw new Error('CoinMarketCap: no prices in response')
  return priceMap
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

// ─── Dedicated single-coin fetchers ──────────────────────────────────────────
// Return { price, source } so the caller can record the exact data origin.
// Called after the bulk source wins but is missing a specific coin.

type DedicatedResult = { price: number; source: string }

// CoinPaprika ticker helper (reused by both TRX and BNB fetchers)
async function fetchCoinPaprikaTicker(paprikaId: string): Promise<number> {
  const res = await fetch(`https://api.coinpaprika.com/v1/tickers/${paprikaId}`, {
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`CoinPaprika HTTP ${res.status}`)
  const data = (await res.json()) as { quotes?: { USD?: { price?: number } } }
  const price = data.quotes?.USD?.price
  if (!price) throw new Error(`CoinPaprika: no price in response for ${paprikaId}`)
  return price
}

// CoinGecko single-coin helper (reused by both fetchers)
async function fetchCoinGeckoSingle(geckoId: string): Promise<number> {
  const isPro = !!env.COINGECKO_API_KEY
  const base = isPro ? 'https://pro-api.coingecko.com/api/v3' : 'https://api.coingecko.com/api/v3'
  const headers: Record<string, string> = isPro ? { 'x-cg-pro-api-key': env.COINGECKO_API_KEY! } : {}
  const res = await fetch(`${base}/simple/price?ids=${geckoId}&vs_currencies=usd`, {
    headers, signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`CoinGecko single HTTP ${res.status}`)
  const data = (await res.json()) as Record<string, { usd?: number }>
  const price = data[geckoId]?.usd
  if (!price) throw new Error(`CoinGecko single: no price for ${geckoId}`)
  return price
}

async function fetchTrxUsdPrice(): Promise<DedicatedResult | null> {
  const attempts: Array<{ name: string; fn: () => Promise<number> }> = [
    { name: 'coinpaprika',     fn: () => fetchCoinPaprikaTicker('trx-tron') },
    { name: 'cryptocompare',   fn: async () => {
        const res = await fetch('https://min-api.cryptocompare.com/data/price?fsym=TRX&tsyms=USD', { signal: AbortSignal.timeout(8000) })
        if (!res.ok) throw new Error(`CryptoCompare HTTP ${res.status}`)
        const data = (await res.json()) as { USD?: number }
        if (!data.USD) throw new Error('CryptoCompare: no TRX price')
        return data.USD
      },
    },
    { name: 'coingecko-single', fn: () => fetchCoinGeckoSingle('tron') },
  ]
  for (const { name, fn } of attempts) {
    try {
      const price = await fn()
      logger.info({ source: name, coin: 'TRX', price }, 'TRX price from dedicated fetcher')
      return { price, source: name }
    } catch (err) {
      logger.warn({ source: name, err: err instanceof Error ? err.message : String(err) }, 'TRX dedicated fetcher failed — trying next')
    }
  }
  logger.error('All dedicated TRX fetchers failed — rate:TRX will not be updated this cycle')
  return null
}

async function fetchBnbUsdPrice(): Promise<DedicatedResult | null> {
  const attempts: Array<{ name: string; fn: () => Promise<number> }> = [
    { name: 'coinpaprika',      fn: () => fetchCoinPaprikaTicker('bnb-binance-coin') },
    { name: 'cryptocompare',    fn: async () => {
        const res = await fetch('https://min-api.cryptocompare.com/data/price?fsym=BNB&tsyms=USD', { signal: AbortSignal.timeout(8000) })
        if (!res.ok) throw new Error(`CryptoCompare HTTP ${res.status}`)
        const data = (await res.json()) as { USD?: number }
        if (!data.USD) throw new Error('CryptoCompare: no BNB price')
        return data.USD
      },
    },
    { name: 'coingecko-single', fn: () => fetchCoinGeckoSingle('binancecoin') },
  ]
  for (const { name, fn } of attempts) {
    try {
      const price = await fn()
      logger.info({ source: name, coin: 'BNB', price }, 'BNB price from dedicated fetcher')
      return { price, source: name }
    } catch (err) {
      logger.warn({ source: name, err: err instanceof Error ? err.message : String(err) }, 'BNB dedicated fetcher failed — trying next')
    }
  }
  logger.error('All dedicated BNB fetchers failed — rate:BNB will not be updated this cycle')
  return null
}

// Fetch a batch of coins not covered by the winning bulk source (e.g. MATIC/TON/SUI/APT/NEAR
// when Kraken wins). Tries CoinGecko batch first, then individual CoinPaprika calls.
// Returns { coin → usdPrice } for coins successfully fetched.
async function fetchMissingCoins(
  missingSymbols: string[],
): Promise<{ prices: Record<string, number>; sources: Record<string, string> }> {
  const prices: Record<string, number> = {}
  const sources: Record<string, string> = {}
  if (missingSymbols.length === 0) return { prices, sources }

  // Attempt 1: CoinGecko batch for the missing coins
  const geckoIds = missingSymbols.map(s => COINGECKO_IDS[s]).filter(Boolean)
  if (geckoIds.length > 0) {
    try {
      const isPro = !!env.COINGECKO_API_KEY
      const base = isPro ? 'https://pro-api.coingecko.com/api/v3' : 'https://api.coingecko.com/api/v3'
      const headers: Record<string, string> = isPro ? { 'x-cg-pro-api-key': env.COINGECKO_API_KEY! } : {}
      const res = await fetch(`${base}/simple/price?ids=${geckoIds.join(',')}&vs_currencies=usd`, {
        headers, signal: AbortSignal.timeout(8000),
      })
      if (res.ok) {
        const data = (await res.json()) as Record<string, { usd?: number }>
        for (const sym of missingSymbols) {
          const geckoId = COINGECKO_IDS[sym]
          const price = geckoId ? data[geckoId]?.usd : undefined
          if (price && price > 0) {
            prices[sym] = price
            sources[sym] = 'coingecko-fallback'
          }
        }
        const found = Object.keys(prices)
        if (found.length > 0) logger.info({ found, source: 'coingecko-fallback' }, 'Missing coins patched via CoinGecko fallback batch')
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'CoinGecko fallback batch for missing coins failed')
    }
  }

  // Attempt 2: FreeCryptoApi for any still-missing coins (avoids per-coin rate limits)
  const stillMissingAfterGecko = missingSymbols.filter(s => !prices[s])
  if (stillMissingAfterGecko.length > 0 && env.FREECRYPTOAPI_KEY) {
    try {
      const symbols = stillMissingAfterGecko.map(s => FREECRYPTOAPI_SYMBOLS[s]).filter(Boolean).join(',')
      const res = await fetch(`https://api.freecryptoapi.com/v1/getData?symbol=${symbols}`, {
        headers: { Authorization: env.FREECRYPTOAPI_KEY },
        signal: AbortSignal.timeout(8000),
      })
      if (res.ok) {
        const body = (await res.json()) as { data?: Record<string, { price?: number }> }
        for (const sym of stillMissingAfterGecko) {
          const fcaSym = FREECRYPTOAPI_SYMBOLS[sym]
          const price = fcaSym ? body.data?.[fcaSym]?.price : undefined
          if (price && price > 0) {
            prices[sym] = price
            sources[sym] = 'freecryptoapi-fallback'
          }
        }
        const found = stillMissingAfterGecko.filter(s => prices[s])
        if (found.length > 0) logger.info({ found }, 'Missing coins patched via FreeCryptoApi fallback')
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'FreeCryptoApi fallback for missing coins failed')
    }
  }

  // Attempt 3: CoinPaprika individual calls for any still-missing coins
  const PAPRIKA_IDS: Record<string, string> = {
    MATIC: 'matic-network',
    POL:   'matic-network',  // POL = renamed MATIC; same CoinPaprika ID
    TON:   'ton-the-open-network',
    SUI:   'sui-sui',
    APT:   'apt-aptos',
    NEAR:  'near-near-protocol',
    SOL:   'sol-solana',
    AVAX:  'avax-avalanche',
  }
  const stillMissing = missingSymbols.filter(s => !prices[s])
  for (const sym of stillMissing) {
    const paprikaId = PAPRIKA_IDS[sym]
    if (!paprikaId) continue
    try {
      const price = await fetchCoinPaprikaTicker(paprikaId)
      prices[sym] = price
      sources[sym] = 'coinpaprika-fallback'
      logger.info({ coin: sym, price, source: 'coinpaprika-fallback' }, 'Missing coin patched via CoinPaprika')
    } catch (err) {
      logger.warn({ coin: sym, err: err instanceof Error ? err.message : String(err) }, 'CoinPaprika fallback failed for missing coin')
    }
  }

  return { prices, sources }
}

// Try each source in order; return first non-empty priceMap with source label.
// Sources are accepted even if they are missing some coins (e.g. Kraken has no
// TRX pairs). Missing gas-critical coins are patched in separately afterwards
// by fetchTrxUsdPrice, so we never reject a whole source just because it lacks TRX.
async function fetchPricesWithFallback(): Promise<{ priceMap: Record<string, number>; source: string }> {
  // Source priority (all are batch requests — one HTTP call per source):
  // 1. CoinGecko   — best data quality; rate-limited on free Railway tier
  // 2. FreeCryptoApi — 100K/month free; reliable fallback
  // 3. CoinStats   — 20K/month free; wide coverage
  // 4. Bybit       — exchange ticker; geo-accessible on Railway
  // 5. Kraken      — exchange ticker; geo-accessible; missing BNB/TRX
  // 6. Binance     — geo-blocked on Railway (451); last resort
  const sources: Array<{ name: string; fn: () => Promise<Record<string, number>> }> = [
    { name: 'coingecko',     fn: fetchPricesFromCoinGecko },
    { name: 'freecryptoapi', fn: fetchPricesFromFreeCryptoApi },
    { name: 'coinstats',     fn: fetchPricesFromCoinStats },
    { name: 'bybit',         fn: fetchPricesFromBybit },
    { name: 'kraken',        fn: fetchPricesFromKraken },
    { name: 'binance',       fn: fetchPricesFromBinance },
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

  // CMC emergency attempt — only reached when ALL bulk sources fail.
  // Costs 1 credit per coin requested (12 coins = 12 credits per call).
  // Keeping it here (not in the regular chain) preserves the 10K/month free quota.
  if (env.CMC_API_KEY) {
    try {
      const cmcMap = await fetchPricesFromCoinMarketCap()
      logger.warn({ coins: Object.keys(cmcMap) }, 'All bulk sources failed — using CoinMarketCap emergency fallback')
      return { priceMap: cmcMap, source: 'coinmarketcap-emergency' }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn({ err: msg }, 'CoinMarketCap emergency fallback also failed')
      errors.push(`coinmarketcap-emergency: ${msg}`)
    }
  }

  // All live sources failed — try stale Redis cache.
  // Redis stores { rate: pkrRate, usdPrice: number } per coin. We read usdPrice
  // directly (new format) and fall back to pkrRate / USD_PKR for old-format keys.
  logger.warn('All price sources failed — attempting stale Redis cache')
  const coins = Object.keys(COINGECKO_IDS)
  const priceMap: Record<string, number> = {}
  for (const coin of coins) {
    const cached = await redis.get(`rate:${coin}`)
    if (cached) {
      const parsed = JSON.parse(cached) as { rate: number; usdPrice?: number }
      if (parsed.usdPrice !== undefined && parsed.usdPrice > 0) {
        priceMap[coin] = parsed.usdPrice
        // Legacy format (no usdPrice) intentionally ignored: dividing an old PKR rate
        // by a changed USD/PKR rate yields wrong USD prices. Let it expire.
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
    const HARDCODED_USD_PKR = 278.5
    let usdPkr = HARDCODED_USD_PKR
    let usingHardcodedPkr = false
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
      logger.warn({ err: e }, 'ExchangeRate API failed — checking Redis cache for USD/PKR')
      const cached = await redis.get('rate:USD_PKR')
      if (cached) {
        usdPkr = parseFloat(cached)
        logger.warn({ usdPkr }, 'USD/PKR loaded from Redis cache')
      } else {
        usingHardcodedPkr = true
        logger.error({ usdPkr: HARDCODED_USD_PKR }, 'USD/PKR ExchangeRate API failed AND no Redis cache — using hardcoded fallback')
        sendAdminAlertEmail(
          'USD/PKR Rate: Using Hardcoded Fallback',
          `The ExchangeRate API failed and no cached USD/PKR rate was found in Redis.\n\nAll gas fee prices and trade rate calculations are currently using the hardcoded fallback value of ${HARDCODED_USD_PKR} PKR/USD.\n\nThis will produce incorrect prices if the real rate has changed significantly. Check the ExchangeRate API key and connectivity immediately.`,
        ).catch((alertErr: unknown) => logger.error({ err: alertErr }, 'Failed to send USD/PKR fallback alert email'))
      }
    }
    if (usingHardcodedPkr) {
      logger.warn({ usdPkr }, 'Rate cycle proceeding with hardcoded USD/PKR — prices may be inaccurate')
    }

    // 2. Fetch crypto prices with multi-source fallback chain
    const { priceMap, source: priceSource } = await fetchPricesWithFallback()

    // Per-coin source tracking: starts with the bulk source for all coins that came
    // from it; overwritten for any coin patched by a dedicated fetcher below.
    const coinSources: Record<string, string> = {}
    for (const sym of Object.keys(priceMap)) coinSources[sym] = priceSource

    // 2b. Patch gas-critical coins missing from the bulk source.
    // Kraken (common winner on Railway) lacks BNB and TRX — fetch them individually.
    if (!priceMap['TRX']) {
      logger.warn({ source: priceSource }, 'TRX missing from bulk — running dedicated TRX fetcher')
      const result = await fetchTrxUsdPrice()
      if (result) { priceMap['TRX'] = result.price; coinSources['TRX'] = result.source }
    }
    if (!priceMap['BNB']) {
      logger.warn({ source: priceSource }, 'BNB missing from bulk — running dedicated BNB fetcher')
      const result = await fetchBnbUsdPrice()
      if (result) { priceMap['BNB'] = result.price; coinSources['BNB'] = result.source }
    }

    // 2c. Patch any remaining coins still missing (e.g. MATIC/TON/SUI/APT/NEAR when
    // Kraken wins). Uses CoinGecko targeted batch → CoinPaprika per-coin fallback.
    const missingAfterDedicated = Object.keys(COINGECKO_IDS).filter(s => !priceMap[s])
    if (missingAfterDedicated.length > 0) {
      logger.warn({ missingAfterDedicated, source: priceSource }, 'Coins still missing after dedicated fetchers — running bulk fallback patch')
      const { prices: patchedPrices, sources: patchedSources } = await fetchMissingCoins(missingAfterDedicated)
      for (const [sym, price] of Object.entries(patchedPrices)) {
        priceMap[sym] = price
        coinSources[sym] = patchedSources[sym] ?? 'fallback'
      }
    }

    // 2d. POL ↔ MATIC alias: Polygon renamed its native token from MATIC to POL in
    // Sept 2024. Exchanges are migrating from MATICUSDT to POLUSDT. Mirror prices
    // between the two keys so all lookup paths resolve regardless of which symbol the
    // winning source returned.
    const polOrMatic = priceMap['POL'] ?? priceMap['MATIC']
    if (polOrMatic !== undefined) {
      if (!priceMap['POL'])   { priceMap['POL']   = polOrMatic; coinSources['POL']   = coinSources['MATIC'] ?? 'matic-pol-alias' }
      if (!priceMap['MATIC']) { priceMap['MATIC'] = polOrMatic; coinSources['MATIC'] = coinSources['POL']   ?? 'matic-pol-alias' }
    }
    logger.debug({ polPrice: priceMap['POL'], maticPrice: priceMap['MATIC'] }, '[POL/MATIC] alias mirror applied')

    // 3. Calculate PKR rates and write to Redis + DB
    const now = new Date().toISOString()
    const updates: Array<{ key: string; value: string }> = []

    updates.push({ key: 'rate_USDT_PKR', value: String(usdPkr.toFixed(2)) })
    await redis.set('rate:USDT', JSON.stringify({ rate: usdPkr, usdPrice: 1.0, updatedAt: now, source: priceSource }), 'EX', 3600)

    const skippedCoins: string[] = []
    const ttlExtendedCoins: string[] = []
    const legacyDroppedCoins: string[] = []
    for (const coin of Object.keys(COINGECKO_IDS)) {
      const usdPrice = priceMap[coin]
      if (!usdPrice) {
        // Coin missing from this bulk source cycle.
        // Only extend TTL for keys that already carry a valid usdPrice field.
        // Legacy keys ({rate: pkrRate} without usdPrice) must NOT be extended —
        // dividing an old PKR rate by a changed USD/PKR yields wrong USD prices,
        // which is the root cause of inflated ETH/BNB stale prices.
        const existing = await redis.get(`rate:${coin}`)
        if (existing) {
          const parsedExisting = JSON.parse(existing) as { usdPrice?: number }
          if (parsedExisting.usdPrice !== undefined && parsedExisting.usdPrice > 0) {
            await redis.set(`rate:${coin}`, existing, 'EX', 3600)
            ttlExtendedCoins.push(coin)
          } else {
            legacyDroppedCoins.push(coin)
            logger.warn({ coin }, 'Legacy Redis key (no usdPrice) — NOT extending TTL; will expire to force fresh fetch next cycle')
          }
        } else {
          skippedCoins.push(coin)
        }
        continue
      }
      const pkrRate = (usdPrice * usdPkr).toFixed(2)
      const redisKey = `rate:${coin}`
      const coinSource = coinSources[coin] ?? priceSource
      // Store usdPrice (raw market) + PKR rate + which source provided this price.
      const redisValue = JSON.stringify({ rate: parseFloat(pkrRate), usdPrice, updatedAt: now, source: coinSource })
      updates.push({ key: `rate_${coin}_PKR`, value: pkrRate })
      logger.debug({ key: redisKey, usdPrice, pkrRate, source: coinSource }, 'Setting coin rate in Redis')
      await redis.set(redisKey, redisValue, 'EX', 3600)
    }

    if (ttlExtendedCoins.length > 0) {
      logger.info({ ttlExtendedCoins, source: priceSource }, 'Extended Redis TTL for coins not in current bulk source — prices preserved')
    }
    if (legacyDroppedCoins.length > 0) {
      logger.warn({ legacyDroppedCoins, source: priceSource }, 'Legacy Redis keys dropped (no usdPrice field) — will be refreshed next successful cycle')
    }
    if (skippedCoins.length > 0) {
      logger.warn({ skippedCoins, source: priceSource }, 'Some coins missing from priceMap AND no cached value — Redis keys NOT written')
    }

    // Don't cache the hardcoded fallback — writing 278.5 would silence future alerts
    // by making the next failure look like a cache hit.
    if (!usingHardcodedPkr) {
      await redis.set('rate:USD_PKR', String(usdPkr), 'EX', 3600)
      logger.debug({ key: 'rate:USD_PKR', usdPkr }, 'Redis SET rate:USD_PKR confirmed')
    }

    await Promise.all(
      updates.map(({ key, value }) =>
        db.platformConfig.upsert({ where: { key }, create: { key, value }, update: { value } }),
      ),
    )

    await redis.del('rate_update_fail_count')

    logger.info(
      { coinsUpdated: updates.length, skippedCoins, legacyDroppedCoins, usdPkr, bulkSource: priceSource, coinSources },
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
