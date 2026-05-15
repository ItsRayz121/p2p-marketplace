-- AlterTable
ALTER TABLE "GasFeeOrder" ADD COLUMN     "gasTokenConfigId" TEXT,
ALTER COLUMN "tier" DROP NOT NULL;

-- CreateTable
CREATE TABLE "GasChainConfig" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "logoUrl" TEXT,
    "category" TEXT NOT NULL,
    "networkLabel" TEXT NOT NULL,
    "addressType" TEXT NOT NULL,
    "explorerBase" TEXT,
    "backendChainId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GasChainConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GasTokenConfig" (
    "id" TEXT NOT NULL,
    "chainConfigId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "tokenType" TEXT NOT NULL,
    "contractAddress" TEXT,
    "logoUrl" TEXT,
    "priceSymbol" TEXT NOT NULL,
    "minAmount" DECIMAL(18,8) NOT NULL DEFAULT 0.1,
    "maxUsdValue" DECIMAL(10,4) NOT NULL DEFAULT 10,
    "presetAmounts" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GasTokenConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GasChainConfig_slug_key" ON "GasChainConfig"("slug");

-- CreateIndex
CREATE INDEX "GasTokenConfig_chainConfigId_isActive_idx" ON "GasTokenConfig"("chainConfigId", "isActive");

-- AddForeignKey
ALTER TABLE "GasFeeOrder" ADD CONSTRAINT "GasFeeOrder_gasTokenConfigId_fkey" FOREIGN KEY ("gasTokenConfigId") REFERENCES "GasTokenConfig"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GasTokenConfig" ADD CONSTRAINT "GasTokenConfig_chainConfigId_fkey" FOREIGN KEY ("chainConfigId") REFERENCES "GasChainConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;
