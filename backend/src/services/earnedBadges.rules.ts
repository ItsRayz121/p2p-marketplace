/** Pure earned-badge rules (no DB access) so they can be unit tested. See earnedBadges.service.ts. */

export interface EarnedBadge {
  key: string
  label: string
  emoji: string
  description: string
}

export const EARLY_MEMBER_LIMIT = 1000

const DEFS = {
  verified_trader: { label: 'Verified Trader', emoji: '✅', description: 'KYC verified with 10 or more completed trades.' },
  fast_releaser: { label: 'Fast Releaser', emoji: '⚡', description: 'Releases funds in 10 minutes or less on average, across 20+ trades.' },
  zero_disputes: { label: 'Clean Record', emoji: '🛡️', description: '50 or more completed trades without losing a dispute.' },
  gas_regular: { label: 'Gas Regular', emoji: '⛽', description: '5 or more gas-fee orders delivered.' },
  multi_chain: { label: 'Multi-chain', emoji: '🔗', description: 'Bought gas on 3 or more different chains.' },
  early_member: { label: 'Early Member', emoji: '🌱', description: `One of the first ${EARLY_MEMBER_LIMIT.toLocaleString('en-US')} members of RupChain.` },
  affiliate: { label: 'Affiliate', emoji: '🤝', description: 'An approved RupChain affiliate.' },
} as const

export type EarnedBadgeKey = keyof typeof DEFS

export interface EarnedBadgeInput {
  userId: string
  createdAt: Date
  kycApproved: boolean
  completedTrades: number
  avgReleaseMinutes: number | null
  disputesLost: number
}

/** Pure rule evaluation, separated from the queries so it is easy to unit test. */
export function evaluateEarnedBadges(
  i: EarnedBadgeInput,
  extra: { gasDelivered: number; gasChains: number; earlyMember: boolean; affiliateApproved: boolean },
): EarnedBadge[] {
  const keys: EarnedBadgeKey[] = []
  if (i.kycApproved && i.completedTrades >= 10) keys.push('verified_trader')
  if (i.completedTrades >= 20 && i.avgReleaseMinutes != null && i.avgReleaseMinutes <= 10) keys.push('fast_releaser')
  if (i.completedTrades >= 50 && i.disputesLost === 0) keys.push('zero_disputes')
  if (extra.gasDelivered >= 5) keys.push('gas_regular')
  if (extra.gasChains >= 3) keys.push('multi_chain')
  if (extra.earlyMember) keys.push('early_member')
  if (extra.affiliateApproved) keys.push('affiliate')
  return keys.map((key) => ({ key, ...DEFS[key] }))
}

