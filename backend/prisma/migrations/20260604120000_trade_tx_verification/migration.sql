-- AddColumn Trade.txVerificationStatus
ALTER TABLE "Trade" ADD COLUMN IF NOT EXISTS "txVerificationStatus" TEXT;

-- AddColumn Trade.txVerificationDetails
ALTER TABLE "Trade" ADD COLUMN IF NOT EXISTS "txVerificationDetails" JSONB;

-- Unique constraint on sellerTxHash prevents replay: same on-chain tx cannot
-- credit two different trades. NULL values are excluded from uniqueness (PostgreSQL
-- allows multiple NULLs in a unique index).
CREATE UNIQUE INDEX IF NOT EXISTS "Trade_sellerTxHash_key" ON "Trade"("sellerTxHash")
  WHERE "sellerTxHash" IS NOT NULL;

-- AddColumn CtmTradeProof.txVerificationStatus
ALTER TABLE "CtmTradeProof" ADD COLUMN IF NOT EXISTS "txVerificationStatus" TEXT;

-- AddColumn CtmTradeProof.txVerificationDetails
ALTER TABLE "CtmTradeProof" ADD COLUMN IF NOT EXISTS "txVerificationDetails" JSONB;
