-- Phase 1 of the Gas-Payment promo/referral system: promo codes that discount the
-- platform MARGIN of a gas order (never the base cost). All new tables/relations;
-- nothing existing changes. The feature only runs when flag gas_promo_enabled = true.

-- CreateTable
CREATE TABLE "GasPromoCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "ownerLabel" TEXT NOT NULL,
    "tiers" JSONB NOT NULL DEFAULT '[]',
    "defaultDiscountPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "marginBudgetUsdt" DOUBLE PRECISION NOT NULL,
    "marginSpentUsdt" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalRedemptions" INTEGER NOT NULL DEFAULT 0,
    "perUserLimit" INTEGER NOT NULL DEFAULT 1,
    "minOrderUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GasPromoCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GasPromoRedemption" (
    "id" TEXT NOT NULL,
    "promoCodeId" TEXT NOT NULL,
    "identity" TEXT NOT NULL,
    "userId" TEXT,
    "orderId" TEXT NOT NULL,
    "discountUsdt" DECIMAL(10,4) NOT NULL,
    "marginUsdt" DECIMAL(10,4) NOT NULL,
    "tierIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GasPromoRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GasPromoCode_code_key" ON "GasPromoCode"("code");
CREATE INDEX "GasPromoCode_isActive_idx" ON "GasPromoCode"("isActive");
CREATE UNIQUE INDEX "GasPromoRedemption_orderId_key" ON "GasPromoRedemption"("orderId");
CREATE INDEX "GasPromoRedemption_promoCodeId_idx" ON "GasPromoRedemption"("promoCodeId");
CREATE INDEX "GasPromoRedemption_identity_idx" ON "GasPromoRedemption"("identity");
CREATE INDEX "GasFeeOrder_promoCodeId_idx" ON "GasFeeOrder"("promoCodeId");

-- AddForeignKey
ALTER TABLE "GasFeeOrder" ADD CONSTRAINT "GasFeeOrder_promoCodeId_fkey" FOREIGN KEY ("promoCodeId") REFERENCES "GasPromoCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GasPromoRedemption" ADD CONSTRAINT "GasPromoRedemption_promoCodeId_fkey" FOREIGN KEY ("promoCodeId") REFERENCES "GasPromoCode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GasPromoRedemption" ADD CONSTRAINT "GasPromoRedemption_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "GasFeeOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
