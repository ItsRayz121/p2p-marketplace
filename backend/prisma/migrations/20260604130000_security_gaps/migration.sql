-- Unique partial index on CtmTradeProof.txHash prevents the same on-chain
-- transaction from being submitted as proof for more than one CTM trade.
-- NULL values are excluded (PostgreSQL allows multiple NULLs in unique indexes).
CREATE UNIQUE INDEX IF NOT EXISTS "CtmTradeProof_txHash_key"
  ON "CtmTradeProof"("txHash")
  WHERE "txHash" IS NOT NULL;

-- Fast lookup index so cross-table duplicate queries stay O(1).
CREATE INDEX IF NOT EXISTS "CtmTradeProof_txHash_idx"
  ON "CtmTradeProof"("txHash");
