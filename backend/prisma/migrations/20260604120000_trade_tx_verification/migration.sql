-- AddColumn Trade.txVerificationStatus
ALTER TABLE "Trade" ADD COLUMN IF NOT EXISTS "txVerificationStatus" TEXT;

-- AddColumn Trade.txVerificationDetails
ALTER TABLE "Trade" ADD COLUMN IF NOT EXISTS "txVerificationDetails" JSONB;

-- Index for quick lookup of trades by sellerTxHash (duplicate detection)
CREATE INDEX IF NOT EXISTS "Trade_sellerTxHash_idx" ON "Trade"("sellerTxHash");

-- AddColumn CtmTradeProof.txVerificationStatus
ALTER TABLE "CtmTradeProof" ADD COLUMN IF NOT EXISTS "txVerificationStatus" TEXT;

-- AddColumn CtmTradeProof.txVerificationDetails
ALTER TABLE "CtmTradeProof" ADD COLUMN IF NOT EXISTS "txVerificationDetails" JSONB;
