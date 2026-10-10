import { env } from './env'

/**
 * Single source of truth for how we call CoinGecko.
 *  - No key            → public endpoint (shared, low limit).
 *  - Key + plan=demo   → public host with the `x-cg-demo-api-key` header (free Demo key; default).
 *  - Key + plan=pro    → pro host with the `x-cg-pro-api-key` header (paid plans).
 */
export function coingeckoAuth(): { base: string; headers: Record<string, string> } {
  const key = env.COINGECKO_API_KEY?.trim()
  if (!key) return { base: 'https://api.coingecko.com/api/v3', headers: {} }
  if (env.COINGECKO_API_PLAN === 'pro') {
    return { base: 'https://pro-api.coingecko.com/api/v3', headers: { 'x-cg-pro-api-key': key } }
  }
  return { base: 'https://api.coingecko.com/api/v3', headers: { 'x-cg-demo-api-key': key } }
}
