import { getStringConfig } from '../../services/platformFlags.service'

/**
 * Kill switch for the whole Portfolio feature.
 *
 * Stored as the PlatformConfig key `portfolio_enabled` (any case). It is ON by
 * default: only an explicit "false" / "0" / "off" / "no" / "disabled" turns it off, so a missing key never hides the feature.
 * Turning it off never deletes anything; records are kept and come back when it is turned on again.
 * It does not touch the wallet, deposits, withdrawals, trading or any settlement.
 */
export const PORTFOLIO_FLAG_KEY = 'portfolio_enabled'
const OFF_VALUES = new Set(['false', '0', 'off', 'no', 'disabled'])

/** Only an explicit off value (any case, spaces ignored) turns the feature off; anything else leaves it on. */
export function parsePortfolioFlag(raw: string | undefined | null): boolean {
  return !OFF_VALUES.has((raw ?? '').trim().toLowerCase())
}
const TTL_MS = 15_000

let cache: { at: number; value: boolean } | null = null

export async function isPortfolioEnabled(now = Date.now()): Promise<boolean> {
  if (cache && now - cache.at < TTL_MS) return cache.value
  let value = true
  try {
    value = parsePortfolioFlag(await getStringConfig(PORTFOLIO_FLAG_KEY, ''))
  } catch {
    // If the setting cannot be read, keep whatever we last knew rather than flipping the feature.
    value = cache?.value ?? true
  }
  cache = { at: now, value }
  return value
}

/** Test hook / after an admin change. */
export function resetPortfolioFlagCache(): void {
  cache = null
}
