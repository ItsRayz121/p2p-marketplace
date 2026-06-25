-- Phase 4 of the Gas-Payment promo/referral system: KOL referrals. A referrer gets
-- a code; a referred user is bound first-touch (permanent). Each delivered, paid gas
-- order by a referred user accrues referralPct × realized margin to the referrer.
-- All new tables; nothing existing changes. Runs only when gas_referral_enabled = ON.

-- CreateTable
CREATE TABLE "GasReferralCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "referralPct" DOUBLE PRECISION NOT NULL DEFAULT 5,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GasReferralCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GasReferral" (
    "id" TEXT NOT NULL,
    "referredId" TEXT NOT NULL,
    "referrerId" TEXT NOT NULL,
    "codeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GasReferral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GasReferralAccrual" (
    "id" TEXT NOT NULL,
    "referrerId" TEXT NOT NULL,
    "referredId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "marginUsdt" DECIMAL(10,4) NOT NULL,
    "amountUsdt" DECIMAL(10,4) NOT NULL,
    "pct" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'available',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GasReferralAccrual_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GasReferralCode_code_key" ON "GasReferralCode"("code");
CREATE INDEX "GasReferralCode_ownerId_idx" ON "GasReferralCode"("ownerId");
CREATE UNIQUE INDEX "GasReferral_referredId_key" ON "GasReferral"("referredId");
CREATE INDEX "GasReferral_referrerId_idx" ON "GasReferral"("referrerId");
CREATE UNIQUE INDEX "GasReferralAccrual_orderId_key" ON "GasReferralAccrual"("orderId");
CREATE INDEX "GasReferralAccrual_referrerId_status_idx" ON "GasReferralAccrual"("referrerId", "status");

-- AddForeignKey
ALTER TABLE "GasReferralCode" ADD CONSTRAINT "GasReferralCode_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GasReferral" ADD CONSTRAINT "GasReferral_referredId_fkey" FOREIGN KEY ("referredId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GasReferral" ADD CONSTRAINT "GasReferral_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GasReferral" ADD CONSTRAINT "GasReferral_codeId_fkey" FOREIGN KEY ("codeId") REFERENCES "GasReferralCode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GasReferralAccrual" ADD CONSTRAINT "GasReferralAccrual_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GasReferralAccrual" ADD CONSTRAINT "GasReferralAccrual_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "GasFeeOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
