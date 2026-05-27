-- AlterTable
ALTER TABLE "Trade" ADD COLUMN "adBidId" TEXT;

-- CreateTable
CREATE TABLE "AdBid" (
    "id" TEXT NOT NULL,
    "adId" TEXT NOT NULL,
    "bidderId" TEXT NOT NULL,
    "pricePerUnit" DECIMAL(14,2) NOT NULL,
    "usdtAmount" DECIMAL(18,8) NOT NULL,
    "fiatAmount" DECIMAL(14,2) NOT NULL,
    "message" VARCHAR(300),
    "paymentMethod" TEXT,
    "buyerUsdtAddress" VARCHAR(300),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdBid_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdBid_adId_status_idx" ON "AdBid"("adId", "status");

-- CreateIndex
CREATE INDEX "AdBid_bidderId_idx" ON "AdBid"("bidderId");

-- CreateIndex
CREATE UNIQUE INDEX "Trade_adBidId_key" ON "Trade"("adBidId");

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_adBidId_fkey" FOREIGN KEY ("adBidId") REFERENCES "AdBid"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdBid" ADD CONSTRAINT "AdBid_adId_fkey" FOREIGN KEY ("adId") REFERENCES "Ad"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdBid" ADD CONSTRAINT "AdBid_bidderId_fkey" FOREIGN KEY ("bidderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
