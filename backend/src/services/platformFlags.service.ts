import { db } from '../lib/prisma'

/**
 * Centralized boolean feature flags backed by the PlatformConfig key/value store.
 *
 * Every flag defaults to the SAFE / current-production behavior, so a missing
 * key NEVER changes how production behaves. A flag only takes effect once a
 * super-admin explicitly sets it via `PATCH /admin/config { key, value:"true" }`.
 *
 * This is how the non-custodial P2P rebuild ships incrementally: each phase
 * lands behind a flag that is OFF by default, so pushing to main / auto-deploy
 * does not alter live trading until the flag is flipped.
 */
export const FLAGS = {
  /**
   * Non-custodial P2P mode. When ON, the platform stops requiring/locking
   * on-platform USDT for sell ads and relies on KYC + identity + reputation +
   * dispute for protection instead. OFF (default) = current custodial escrow.
   */
  NONCUSTODIAL_P2P: 'noncustodial_p2p_enabled',
} as const

export type FlagKey = (typeof FLAGS)[keyof typeof FLAGS]

// Small in-memory TTL cache so hot paths don't hit the DB on every check.
// 15s is short enough that an admin flag flip propagates almost immediately.
const TTL_MS = 15_000
const cache = new Map<string, { value: boolean; expires: number }>()

/** A config value counts as "true" when it is exactly "true" or "1". */
function parseFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  return value === 'true' || value === '1'
}

export async function isFlagEnabled(key: FlagKey, fallback = false): Promise<boolean> {
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && hit.expires > now) return hit.value

  const row = await db.platformConfig.findUnique({ where: { key } })
  const value = parseFlag(row?.value, fallback)
  cache.set(key, { value, expires: now + TTL_MS })
  return value
}

/** Drop the in-memory cache (call after an admin flag flip, or in tests). */
export function clearFlagCache(): void {
  cache.clear()
}
