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
  /**
   * Maker collateral bond (non-custodial Phase 5). When ON, opening a trade
   * locks a USDT bond (default 10% of trade size) from the maker's deposited
   * balance; it is released on a clean close and seized to the victim if the
   * maker loses a dispute. OFF (default) = no bond, current behavior.
   */
  MAKER_BOND: 'maker_bond_enabled',
  /**
   * Gas-Payment promo/referral system master switch. When ON, promo codes and
   * referral rewards may be applied to gas orders — but ONLY ever drawing from
   * the platform margin, never the base gas cost. OFF (default) = no promo/
   * referral logic runs; gas orders behave exactly as they do today.
   */
  GAS_PROMO: 'gas_promo_enabled',
  /**
   * Admin-issued free-gas deliveries. When ON, a super-admin can issue a fully
   * platform-funded gas delivery to a specific user (paymentAmount 0, base+margin
   * covered). OFF (default) = the free-deliver endpoint is rejected, so no free gas
   * can be sent even by an admin until this is deliberately enabled.
   */
  GAS_FREE_GRANT: 'gas_free_grant_enabled',
  /**
   * Gas referral program. When ON, a user can get a referral code, a referred user
   * is bound first-touch, and each delivered paid gas order by a referred user
   * accrues referralPct × the realized platform margin to the referrer's balance
   * (paid FROM margin, never base cost; free-grant orders never accrue). OFF
   * (default) = no binding, no accrual; gas orders behave exactly as today.
   */
  GAS_REFERRAL: 'gas_referral_enabled',
  /**
   * Gas giveaway campaigns (KOL draws). When ON, users can enter a KOL campaign
   * with their receiving address and an admin can draw winners — free gas is then
   * delivered to the selected addresses (platform-funded, like a Phase 3 grant).
   * OFF (default) = entry + draw endpoints are rejected; nothing is sent.
   */
  GAS_GIVEAWAY: 'gas_giveaway_enabled',
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

/** Read a numeric PlatformConfig value, falling back when missing/invalid. */
export async function getNumberConfig(key: string, fallback: number): Promise<number> {
  const row = await db.platformConfig.findUnique({ where: { key } })
  if (!row) return fallback
  const n = parseFloat(row.value)
  return Number.isFinite(n) ? n : fallback
}
