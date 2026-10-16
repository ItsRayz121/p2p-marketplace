-- Portfolio: user-scoped, manually tracked assets (analytical only; no balances, no custody link).
-- Purely additive. name / symbol / sourceUrl are intentionally NOT unique so same-named tokens never merge.
CREATE TABLE "PortfolioAsset" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "symbol" VARCHAR(16),
    "sourceUrl" VARCHAR(2048),
    "network" VARCHAR(40),
    "contractAddress" VARCHAR(128),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PortfolioAsset_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PortfolioAsset_userId_createdAt_idx" ON "PortfolioAsset"("userId", "createdAt");

ALTER TABLE "PortfolioAsset" ADD CONSTRAINT "PortfolioAsset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
