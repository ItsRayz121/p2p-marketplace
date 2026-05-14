import { PrismaClient } from '@prisma/client'

// ─── Types ────────────────────────────────────────────────────────────────────

export type RiskFlag =
  | 'FIRST_WITHDRAWAL'   // user has never completed a withdrawal before
  | 'NEW_WALLET'         // destination address not seen in prior completions
  | 'VELOCITY_EXCEEDED'  // too many withdrawal requests in velocity window
  | 'AMOUNT_SPIKE'       // amount is 5× the user's historical average

export interface RiskAssessment {
  tier: 1 | 2 | 3 | 4
  riskScore: number     // 0–100 composite risk score
  riskFlags: RiskFlag[]
  amountUsd: number
  requiresHold: boolean // true when tier 4 or riskScore ≥ 70
}

export interface TierConfig {
  tier1MaxUsd: number           // <=$200 → auto-approve
  tier2MaxUsd: number           // $201–$500 → 1 admin
  tier3MaxUsd: number           // $501–$2000 → 2 admins
  autoApproveEnabled: boolean   // master switch for tier-1 auto-approve
  firstWithdrawalReview: boolean
  newWalletReview: boolean
  velocityWindowMins: number
  velocityMaxCount: number
  coinPricesUsd: Record<string, number>
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULTS: TierConfig = {
  tier1MaxUsd: 200,
  tier2MaxUsd: 500,
  tier3MaxUsd: 2000,
  autoApproveEnabled: true,
  firstWithdrawalReview: true,
  newWalletReview: true,
  velocityWindowMins: 60,
  velocityMaxCount: 3,
  coinPricesUsd: { USDT: 1, USDC: 1, BNB: 600, ETH: 3000, BTC: 60000 },
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
      updatedBy: patch.updatedBy,
    },
  })
  return merged
}

// ─── Core assessment ──────────────────────────────────────────────────────────

function computeBaseTier(amountUsd: number, cfg: TierConfig): 1 | 2 | 3 | 4 {
  if (amountUsd <= cfg.tier1MaxUsd) return 1
  if (amountUsd <= cfg.tier2MaxUsd) return 2
  if (amountUsd <= cfg.tier3MaxUsd) return 3
  return 4
}

export async function assessWithdrawalRisk(
  userId: string,
  amount: number,   // coin units (not USD)
  coin: string,
  toAddress: string,
  prisma: PrismaClient,
  config?: TierConfig,
): Promise<RiskAssessment> {
  const cfg = config ?? (await getWithdrawalTierConfig(prisma))

  const coinPrice = cfg.coinPricesUsd[coin.toUpperCase()] ?? 0
  const amountUsd = amount * coinPrice

  const flags: RiskFlag[] = []
  let riskScore = 0

  // Check 1: first-ever withdrawal for this user
  if (cfg.firstWithdrawalReview) {
    const completedCount = await prisma.withdrawal.count({
      where: {
        userId,
        status: { in: ['sent', 'completed', 'approved', 'auto_approved'] },
      },
    })
    if (completedCount === 0) {
      flags.push('FIRST_WITHDRAWAL')
      riskScore += 25
    }
  }

  // Check 2: destination address never used successfully before
  if (cfg.newWalletReview) {
    const knownAddressCount = await prisma.withdrawal.count({
      where: {
        userId,
        toAddress,
        status: { in: ['sent', 'completed'] },
      },
    })
    if (knownAddressCount === 0) {
      flags.push('NEW_WALLET')
      riskScore += 15
    }
  }

  // Check 3: velocity — too many requests in the rolling window
  const windowStart = new Date(Date.now() - cfg.velocityWindowMins * 60_000)
  const recentCount = await prisma.withdrawal.count({
    where: {
      userId,
      createdAt: { gte: windowStart },
      status: { notIn: ['rejected', 'cancelled'] },
    },
  })
  if (recentCount >= cfg.velocityMaxCount) {
    flags.push('VELOCITY_EXCEEDED')
    riskScore += 30
  }

  // Check 4: amount spike — 5× user's last-10 average
  const prior = await prisma.withdrawal.findMany({
    where: { userId, status: { in: ['sent', 'completed'] } },
    select: { amount: true },
    orderBy: { createdAt: 'desc' },
    take: 10,
  })
  if (prior.length >= 3) {
    const avg = prior.reduce((s, w) => s + parseFloat(w.amount.toString()), 0) / prior.length
    if (amount > avg * 5) {
      flags.push('AMOUNT_SPIKE')
      riskScore += 20
    }
  }

  const baseTier = computeBaseTier(amountUsd, cfg)
  let effectiveTier: 1 | 2 | 3 | 4 = baseTier

  // Risk flags escalate tier — a flagged tier-1 withdrawal needs at least 1 admin
  if (flags.length > 0 && effectiveTier === 1) effectiveTier = 2
  // High composite score requires dual approval
  if (riskScore >= 50 && effectiveTier < 3) effectiveTier = 3

  const requiresHold = baseTier === 4 || riskScore >= 70

  return {
    tier: effectiveTier,
    riskScore: Math.min(riskScore, 100),
    riskFlags: flags,
    amountUsd,
    requiresHold,
  }
}
