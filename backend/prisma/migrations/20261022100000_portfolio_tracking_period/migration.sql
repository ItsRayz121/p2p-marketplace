-- Portfolio: versioned tracking periods, opening baseline holdings and value snapshots.
-- Additive only: no existing row is changed or deleted by this migration. The data cutover itself (which
-- creates the first period per user and archives earlier entries) is a separate, reversible script
-- (scripts/portfolio-cutover.ts), never run by `prisma migrate deploy`.

-- AlterTable
ALTER TABLE "PortfolioEvent" ADD COLUMN     "archivedInPeriodId" VARCHAR(40);

-- CreateTable
CREATE TABLE "PortfolioTrackingPeriod" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'active',
    "reason" VARCHAR(16) NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "timezone" VARCHAR(40) NOT NULL,
    "fxUsdtPkr" DECIMAL(46,18),
    "fxSource" VARCHAR(24),
    "reconciliation" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rolledBackAt" TIMESTAMP(3),

    CONSTRAINT "PortfolioTrackingPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortfolioOpeningHolding" (
    "id" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "quantity" DECIMAL(46,18) NOT NULL,
    "lots" JSONB NOT NULL,
    "marketPrice" DECIMAL(46,18),
    "marketQuote" VARCHAR(4),
    "marketSource" VARCHAR(16),
    "marketObservedAt" TIMESTAMP(3),

    CONSTRAINT "PortfolioOpeningHolding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortfolioSnapshot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "takenAt" TIMESTAMP(3) NOT NULL,
    "bucket" TIMESTAMP(3) NOT NULL,
    "valuePkr" DECIMAL(46,18),
    "fxUsdtPkr" DECIMAL(46,18),
    "heldCount" INTEGER NOT NULL,
    "pricedCount" INTEGER NOT NULL,
    "staleCount" INTEGER NOT NULL DEFAULT 0,
    "trigger" VARCHAR(10) NOT NULL,

    CONSTRAINT "PortfolioSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PortfolioEvent_userId_archivedInPeriodId_idx" ON "PortfolioEvent"("userId", "archivedInPeriodId");

-- CreateIndex
CREATE INDEX "PortfolioTrackingPeriod_userId_status_idx" ON "PortfolioTrackingPeriod"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PortfolioTrackingPeriod_userId_version_key" ON "PortfolioTrackingPeriod"("userId", "version");

-- CreateIndex
CREATE INDEX "PortfolioOpeningHolding_userId_periodId_idx" ON "PortfolioOpeningHolding"("userId", "periodId");

-- CreateIndex
CREATE UNIQUE INDEX "PortfolioOpeningHolding_periodId_assetId_key" ON "PortfolioOpeningHolding"("periodId", "assetId");

-- CreateIndex
CREATE INDEX "PortfolioSnapshot_userId_takenAt_idx" ON "PortfolioSnapshot"("userId", "takenAt");

-- CreateIndex
CREATE UNIQUE INDEX "PortfolioSnapshot_periodId_bucket_key" ON "PortfolioSnapshot"("periodId", "bucket");

-- AddForeignKey
ALTER TABLE "PortfolioTrackingPeriod" ADD CONSTRAINT "PortfolioTrackingPeriod_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortfolioOpeningHolding" ADD CONSTRAINT "PortfolioOpeningHolding_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "PortfolioTrackingPeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortfolioOpeningHolding" ADD CONSTRAINT "PortfolioOpeningHolding_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "PortfolioAsset"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortfolioSnapshot" ADD CONSTRAINT "PortfolioSnapshot_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "PortfolioTrackingPeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;
