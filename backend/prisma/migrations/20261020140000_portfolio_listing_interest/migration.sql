-- Portfolio: optional, withdrawable listing-interest consent (additive).
-- CreateTable
CREATE TABLE "PortfolioListingInterest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "identityKey" VARCHAR(200) NOT NULL,
    "displayName" VARCHAR(80) NOT NULL,
    "consentedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawnAt" TIMESTAMP(3),

    CONSTRAINT "PortfolioListingInterest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PortfolioListingInterest_identityKey_withdrawnAt_idx" ON "PortfolioListingInterest"("identityKey", "withdrawnAt");

-- CreateIndex
CREATE INDEX "PortfolioListingInterest_assetId_idx" ON "PortfolioListingInterest"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "PortfolioListingInterest_userId_identityKey_key" ON "PortfolioListingInterest"("userId", "identityKey");

-- AddForeignKey
ALTER TABLE "PortfolioListingInterest" ADD CONSTRAINT "PortfolioListingInterest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortfolioListingInterest" ADD CONSTRAINT "PortfolioListingInterest_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "PortfolioAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
