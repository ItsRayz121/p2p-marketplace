-- Portfolio: read-only import of settled RupChain CTM trades (additive; existing rows are manual).
-- AlterTable
ALTER TABLE "PortfolioAsset" ADD COLUMN     "ctmTokenId" VARCHAR(40);

-- AlterTable
ALTER TABLE "PortfolioEvent" ADD COLUMN     "source" VARCHAR(12) NOT NULL DEFAULT 'manual',
ADD COLUMN     "sourceRef" VARCHAR(64),
ADD COLUMN     "voidReason" VARCHAR(40),
ADD COLUMN     "voidedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "PortfolioAsset_userId_ctmTokenId_key" ON "PortfolioAsset"("userId", "ctmTokenId");

-- CreateIndex
CREATE UNIQUE INDEX "PortfolioEvent_userId_source_sourceRef_key" ON "PortfolioEvent"("userId", "source", "sourceRef");
