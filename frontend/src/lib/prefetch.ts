// Warm the in-memory cache for the screens people open most, while the browser
// is idle after sign-in. The first tap on Marketplace or Orders then paints from
// cache (see swrCache) instead of waiting out a Singapore round trip.
//
// Deliberately small: two requests, once per session, skipped on Data Saver and
// slow connections, and always after the page the user actually opened.
import { marketplaceApi, tradesApi } from './api'
import { swrGet, swrSet, userKey } from './swrCache'

/** Must match the marketplace page's initial filters — its cache key is derived from them. */
export const DEFAULT_MARKET_FILTERS = {
  side: 'buy',
  network: '',
  paymentMethod: '',
  minAmount: '',
  maxAmount: '',
  seller: '',
} as const

export const marketAdsCacheKey = (f: object): string => `mkt:ads:${JSON.stringify(f)}`
export const ordersFirstPageKey = (userId: string | undefined): string => userKey(userId, 'orders:first')

export const MARKET_PAGE_SIZE = 20
export const ORDERS_PAGE_SIZE = 20

let startedFor: string | null = null

function connectionIsTight(): boolean {
  const c = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection
  return !!c && (c.saveData === true || c.effectiveType === 'slow-2g' || c.effectiveType === '2g')
}

async function warm(userId: string | undefined): Promise<void> {
  const adsKey = marketAdsCacheKey(DEFAULT_MARKET_FILTERS)
  const ordersKey = ordersFirstPageKey(userId)
  await Promise.allSettled([
    swrGet(adsKey) === undefined
      ? marketplaceApi
          .getAds({ type: 'sell', coin: 'USDT', page: 1, limit: MARKET_PAGE_SIZE })
          .then((res) => swrSet(adsKey, { ads: res.ads, total: res.total }))
      : null,
    userId && swrGet(ordersKey) === undefined
      ? tradesApi
          .getMyTrades({ page: 1, limit: ORDERS_PAGE_SIZE })
          .then((res) => swrSet(ordersKey, { trades: res.trades, total: res.total }))
      : null,
  ])
}

/** Call once the user is known. Safe to call repeatedly — it runs once per signed-in user. */
export function prefetchCommonScreens(userId: string | undefined): void {
  if (typeof window === 'undefined' || startedFor === (userId ?? '') || connectionIsTight()) return
  startedFor = userId ?? ''
  const run = () => { void warm(userId) }
  if ('requestIdleCallback' in window) window.requestIdleCallback(run, { timeout: 4000 })
  else setTimeout(run, 2000)
}
