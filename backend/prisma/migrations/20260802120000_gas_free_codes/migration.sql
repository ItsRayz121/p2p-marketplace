-- KOL "100% free gas" codes: self-serve, instant, slot + USDT-budget capped.
-- Unlike GasPromoCode (margin-only discount), a free code waives the ENTIRE
-- order cost (base + margin) for one restricted token/chain. Runs only when
-- gas_free_code_enabled = ON.

-- AlterTable
ALTER TABLE "GasFeeOrder" ADD COLUMN "gasFreeCodeId" TEXT;

-- CreateTable
CREATE TABLE "GasFreeCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "kolLabel" TEXT NOT NULL,
    "gasTokenConfigId" TEXT NOT NULL,
    "slotLimit" INTEGER NOT NULL,
    "redeemedCount" INTEGER NOT NULL DEFAULT 0,
    "budgetUsdt" DOUBLE PRECISION NOT NULL,
    "spentUsdt" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "perUserLimit" INTEGER NOT NULL DEFAULT 1,
    "minOrderUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "maxOrderUsd" DOUBLE PRECISION,
    "expiresAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GasFreeCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GasFreeCodeRedemption" (
    "id" TEXT NOT NULL,
    "freeCodeId" TEXT NOT NULL,
    "identity" TEXT NOT NULL,
    "userId" TEXT,
    "orderId" TEXT NOT NULL,
    "amountUsdt" DECIMAL(10,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GasFreeCodeRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GasFreeCode_code_key" ON "GasFreeCode"("code");
CREATE INDEX "GasFreeCode_isActive_idx" ON "GasFreeCode"("isActive");
CREATE UNIQUE INDEX "GasFreeCodeRedemption_orderId_key" ON "GasFreeCodeRedemption"("orderId");
CREATE INDEX "GasFreeCodeRedemption_freeCodeId_idx" ON "GasFreeCodeRedemption"("freeCodeId");
CREATE INDEX "GasFreeCodeRedemption_identity_idx" ON "GasFreeCodeRedemption"("identity");
CREATE INDEX "GasFeeOrder_gasFreeCodeId_idx" ON "GasFeeOrder"("gasFreeCodeId");

-- AddForeignKey
ALTER TABLE "GasFeeOrder" ADD CONSTRAINT "GasFeeOrder_gasFreeCodeId_fkey" FOREIGN KEY ("gasFreeCodeId") REFERENCES "GasFreeCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GasFreeCodeRedemption" ADD CONSTRAINT "GasFreeCodeRedemption_freeCodeId_fkey" FOREIGN KEY ("freeCodeId") REFERENCES "GasFreeCode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GasFreeCodeRedemption" ADD CONSTRAINT "GasFreeCodeRedemption_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "GasFeeOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
