import type { CtmMerchantTier } from '@prisma/client'

/**
 * Per-trade PKR cap by merchant tier. Raised 2026-06-21 — the old `new` cap of
 * PKR 5,000 (~$18) was too small for a realistic first trade and frustrated
 * legitimate onboarding. Tiers are climbed automatically via `computeMerchantTier`.
 */
export const TIER_CAPS: Record<string, number> = {
  new: 25_000,
  basic: 75_000,
  verified: 300_000,
  elite: 1_000_000,
}

// Ordered low → high so promotion can compare ranks and never demote.
const TIER_ORDER: CtmMerchantTier[] = ['new', 'basic', 'verified', 'elite']

// Completed-trade thresholds to EARN each tier. A merchant climbs as they build a
// clean track record (Binance/Paxful-style), instead of being stuck behind a wall.
const PROMOTION_MIN_COMPLETED: Record<string, number> = {
  basic: 3,
  verified: 25,
  elite: 100,
}

// A high dispute rate freezes promotion regardless of trade count (5% ceiling).
const MAX_DISPUTE_RATE_FOR_PROMOTION = 0.05

/**
 * Compute the tier a merchant has earned from their record. Promotion ONLY — the
 * returned tier is never lower than the current one, so this can't demote a
 * merchant an admin manually elevated. A dispute rate above the ceiling blocks
 * any promotion.
 */
export function computeMerchantTier(input: {
  completedCtmTrades: number
  disputedCtmTrades: number
  totalCtmTrades: number
  currentTier: CtmMerchantTier
}): CtmMerchantTier {
  const { completedCtmTrades, disputedCtmTrades, totalCtmTrades, currentTier } = input
  const disputeRate = totalCtmTrades > 0 ? disputedCtmTrades / totalCtmTrades : 0

  let earned: CtmMerchantTier = 'new'
  if (disputeRate <= MAX_DISPUTE_RATE_FOR_PROMOTION) {
    if (completedCtmTrades >= PROMOTION_MIN_COMPLETED.elite!) earned = 'elite'
    else if (completedCtmTrades >= PROMOTION_MIN_COMPLETED.verified!) earned = 'verified'
    else if (completedCtmTrades >= PROMOTION_MIN_COMPLETED.basic!) earned = 'basic'
  }

  return TIER_ORDER.indexOf(earned) > TIER_ORDER.indexOf(currentTier) ? earned : currentTier
}

/**
 * Effective per-trade cap. A KYC Level 2 (enhanced) merchant starts at the `basic`
 * cap even while their tier is still `new`, so a fully-verified identity isn't
 * gated to micro-trades on day one.
 */
export function effectiveCapForTier(tier: string, kycLevel?: string | null): number {
  const base = TIER_CAPS[tier] ?? TIER_CAPS.new!
  if (kycLevel === 'enhanced') return Math.max(base, TIER_CAPS.basic!)
  return base
}
