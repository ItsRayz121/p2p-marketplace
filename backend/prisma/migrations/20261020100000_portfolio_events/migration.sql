-- Portfolio: manually recorded events and manual price observations (analytical only, additive).
CREATE TABLE "PortfolioEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "type" VARCHAR(10) NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "quantity" DECIMAL(46,18) NOT NULL,
    "consideration" DECIMAL(46,18),
    "fee" DECIMAL(46,18),
    "basis" DECIMAL(46,18),
    "zeroCost" BOOLEAN NOT NULL DEFAULT false,
    "note" VARCHAR(200),
    "clientRequestId" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortfolioEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PortfolioPriceObservation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "price" DECIMAL(46,18) NOT NULL,
    "source" VARCHAR(16) NOT NULL DEFAULT 'manual',
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortfolioPriceObservation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PortfolioEvent_userId_clientRequestId_key" ON "PortfolioEvent"("userId", "clientRequestId");
CREATE INDEX "PortfolioEvent_userId_assetId_occurredAt_idx" ON "PortfolioEvent"("userId", "assetId", "occurredAt");
CREATE INDEX "PortfolioPriceObservation_userId_assetId_observedAt_idx" ON "PortfolioPriceObservation"("userId", "assetId", "observedAt");

ALTER TABLE "PortfolioEvent" ADD CONSTRAINT "PortfolioEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PortfolioEvent" ADD CONSTRAINT "PortfolioEvent_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "PortfolioAsset"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "PortfolioPriceObservation" ADD CONSTRAINT "PortfolioPriceObservation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PortfolioPriceObservation" ADD CONSTRAINT "PortfolioPriceObservation_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "PortfolioAsset"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
