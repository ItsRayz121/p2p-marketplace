ALTER TABLE "GasFeeOrder" ADD COLUMN "shareRewardId" TEXT;

CREATE TABLE "GasShareReward" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceOrderId" TEXT NOT NULL,
    "postUrl" TEXT NOT NULL,
    "postKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "discountPct" DOUBLE PRECISION,
    "reservedOrderId" TEXT,
    "rejectionReason" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GasShareReward_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GasShareReward_sourceOrderId_key" ON "GasShareReward"("sourceOrderId");
CREATE UNIQUE INDEX "GasShareReward_postKey_key" ON "GasShareReward"("postKey");
CREATE INDEX "GasShareReward_status_idx" ON "GasShareReward"("status");
CREATE INDEX "GasShareReward_userId_status_idx" ON "GasShareReward"("userId", "status");

ALTER TABLE "GasShareReward" ADD CONSTRAINT "GasShareReward_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
