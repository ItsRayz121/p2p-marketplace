-- Points → USDT redemption (gift-style cash-out). Inert until PlatformConfig
-- flag `airdrop_usdt_redeem_enabled` = 'true' (in addition to `airdrop_enabled`).
-- Real USDT leaves the platform here (unlike the TGE token-pool split), so it is
-- guarded by AirdropRedemptionBudget's atomic conditional-increment caps rather
-- than a fixed-pool share.

-- AlterEnum
ALTER TYPE "AirdropSource" ADD VALUE IF NOT EXISTS 'redeem';

-- AlterEnum
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'airdrop_redeem';

-- CreateTable
CREATE TABLE "AirdropRedemption" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "pointsBurned" DECIMAL(18,4) NOT NULL,
    "usdtAmount" DECIMAL(18,8) NOT NULL,
    "monthKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AirdropRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AirdropRedemptionBudget" (
    "scope" TEXT NOT NULL,
    "monthKey" TEXT NOT NULL,
    "usedUsdt" DECIMAL(18,8) NOT NULL DEFAULT 0,

    CONSTRAINT "AirdropRedemptionBudget_pkey" PRIMARY KEY ("scope","monthKey")
);

-- CreateIndex
CREATE INDEX "AirdropRedemption_userId_createdAt_idx" ON "AirdropRedemption"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AirdropRedemption_monthKey_idx" ON "AirdropRedemption"("monthKey");
