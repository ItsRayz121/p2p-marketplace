-- Mutual trade streaks: one row per unordered pair of users, holding their
-- COMBINED completed-trade count across all pillars (USDT P2P + CTM). userAId is
-- always the lexicographically smaller id so each pair maps to exactly one row.

-- CreateTable
CREATE TABLE "TradeStreak" (
    "id" TEXT NOT NULL,
    "userAId" TEXT NOT NULL,
    "userBId" TEXT NOT NULL,
    "tradeCount" INTEGER NOT NULL DEFAULT 0,
    "firstTradeAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastTradeAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradeStreak_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TradeStreak_userAId_userBId_key" ON "TradeStreak"("userAId", "userBId");

-- CreateIndex
CREATE INDEX "TradeStreak_userAId_idx" ON "TradeStreak"("userAId");

-- CreateIndex
CREATE INDEX "TradeStreak_userBId_idx" ON "TradeStreak"("userBId");

-- AddForeignKey
ALTER TABLE "TradeStreak" ADD CONSTRAINT "TradeStreak_userAId_fkey" FOREIGN KEY ("userAId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeStreak" ADD CONSTRAINT "TradeStreak_userBId_fkey" FOREIGN KEY ("userBId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
