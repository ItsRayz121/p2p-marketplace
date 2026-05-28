import { PrismaClient } from '@prisma/client'

// ─── Types ────────────────────────────────────────────────────────────────────

export type RiskFlag = string

export interface RiskAssessment {
  tier: 1 | 2 | 3 | 4
  riskScore: number
  riskFlags: RiskFlag[]
  amountUsd: number
  requiresHold: boolean
}

export interface TierConfig {
  tier1MaxUsd: number           // <$100 → instant auto-approve
  tier2MaxUsd: number           // $100+ → 1 admin approval
  tier3MaxUsd: number
  autoApproveEnabled: boolean   // master switch: false forces all to tier 2
  firstWithdrawalReview: boolean
  newWalletReview: boolean
  velocityWindowMins: number
  velocityMaxCount: number
  coinPricesUsd: Record<string, number>
  emailConfirmationEnabled: boolean
  emailConfirmationTtlMins: number
  addressActivationHours: number
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULTS: TierConfig = {
  tier1MaxUsd: 100,
  tier2MaxUsd: 999999,
  tier3MaxUsd: 999999,
  autoApproveEnabled: true,
  firstWithdrawalReview: false,
  newWalletReview: false,
  velocityWindowMins: 60,
  velocityMaxCount: 10,
  coinPricesUsd: { USDT: 1, USDC: 1, BNB: 600, ETH: 3000, BTC: 60000 },
  emailConfirmationEnabled: true,
  emailConfirmationTtlMins: 15,
  addressActivationHours: 24,
}

// ─── Config helpers ───────────────────────────────────────────────────────────

export async function getWithdrawalTierConfig(prisma: PrismaClient): Promise<TierConfig> {
  const row = await prisma.withdrawalTierConfig.findUnique({ where: { id: 1 } })
  if (!row) return { ...DEFAULTS }
  return {
    tier1MaxUsd: parseFloat(row.tier1MaxUsd.toString()),
    tier2MaxUsd: parseFloat(row.tier2MaxUsd.toString()),
    tier3MaxUsd: parseFloat(row.tier3MaxUsd.toString()),
    autoApproveEnabled: row.autoApproveEnabled,
    firstWithdrawalReview: row.firstWithdrawalReview,
    newWalletReview: row.newWalletReview,
    velocityWindowMins: row.velocityWindowMins,
    velocityMaxCount: row.velocityMaxCount,
    coinPricesUsd: (row.coinPricesUsd as Record<string, number>) ?? DEFAULTS.coinPricesUsd,
    emailConfirmationEnabled: row.emailConfirmationEnabled,
    emailConfirmationTtlMins: row.emailConfirmationTtlMins,
    addressActivationHours: row.addressActivationHours,
  }
}

export async function upsertWithdrawalTierConfig(
  prisma: PrismaClient,
  patch: {
    tier1MaxUsd?: number | undefined
    tier2MaxUsd?: number | undefined
    tier3MaxUsd?: number | undefined
    autoApproveEnabled?: boolean | undefined
    firstWithdrawalReview?: boolean | undefined
    newWalletReview?: boolean | undefined
    velocityWindowMins?: number | undefined
    velocityMaxCount?: number | undefined
    coinPricesUsd?: Record<string, number> | undefined
    emailConfirmationEnabled?: boolean | undefined
    emailConfirmationTtlMins?: number | undefined
    addressActivationHours?: number | undefined
    updatedBy: string
  },
): Promise<TierConfig> {
  const current = await getWithdrawalTierConfig(prisma)
  // Strip undefined values from patch before merging so TierConfig stays fully defined
  const definedPatch = Object.fromEntries(
    Object.entries(patch).filter(([k, v]) => k !== 'updatedBy' && v !== undefined),
  ) as Partial<TierConfig>
  const merged: TierConfig = { ...current, ...definedPatch }
  await prisma.withdrawalTierConfig.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      tier1MaxUsd: merged.tier1MaxUsd,
      tier2MaxUsd: merged.tier2MaxUsd,
      tier3MaxUsd: merged.tier3MaxUsd,
      autoApproveEnabled: merged.autoApproveEnabled,
      firstWithdrawalReview: merged.firstWithdrawalReview,
      newWalletReview: merged.newWalletReview,
      velocityWindowMins: merged.velocityWindowMins,
      velocityMaxCount: merged.velocityMaxCount,
      coinPricesUsd: merged.coinPricesUsd,
      emailConfirmationEnabled: merged.emailConfirmationEnabled,
      emailConfirmationTtlMins: merged.emailConfirmationTtlMins,
      addressActivationHours: merged.addressActivationHours,
      updatedBy: patch.updatedBy,
    },
    update: {
      tier1MaxUsd: merged.tier1MaxUsd,
      tier2MaxUsd: merged.tier2MaxUsd,
      tier3MaxUsd: merged.tier3MaxUsd,
      autoApproveEnabled: merged.autoApproveEnabled,
      firstWithdrawalReview: merged.firstWithdrawalReview,
      newWalletReview: merged.newWalletReview,
      velocityWindowMins: merged.velocityWindowMins,
      velocityMaxCount: merged.velocityMaxCount,
      coinPricesUsd: merged.coinPricesUsd,
      emailConfirmationEnabled: merged.emailConfirmationEnabled,
      emailConfirmationTtlMins: merged.emailConfirmationTtlMins,
      addressActivationHours: merged.addressActivationHours,
      updatedBy: patch.updatedBy,
    },
  })
  return merged
}

// ─── Core assessment ──────────────────────────────────────────────────────────

export async function assessWithdrawalRisk(
  _userId: string,
  amount: number,   // coin units (not USD)
  coin: string,
  _toAddress: string,
  prisma: PrismaClient,
  config?: TierConfig,
): Promise<RiskAssessment> {
  const cfg = config ?? (await getWithdrawalTierConfig(prisma))

  const coinPrice = cfg.coinPricesUsd[coin.toUpperCase()] ?? 0
  const amountUsd = coinPrice > 0 ? amount * coinPrice : 999999

  // Simple two-tier rule: under $100 → auto-approve (tier 1), $100+ → 1 admin (tier 2)
  const tier: 1 | 2 = amountUsd < cfg.tier1MaxUsd ? 1 : 2
  const effectiveTier: 1 | 2 = !cfg.autoApproveEnabled && tier === 1 ? 2 : tier

  return {
    tier: effectiveTier,
    riskScore: 0,
    riskFlags: [],
    amountUsd,
    requiresHold: false,
  }
}
