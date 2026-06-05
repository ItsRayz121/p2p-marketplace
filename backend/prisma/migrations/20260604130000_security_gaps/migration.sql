-- Remove duplicate txHash rows before creating the unique index.
-- Keeps the most recently created proof per txHash; deletes older duplicates.
DELETE FROM "CtmTradeProof"
WHERE "txHash" IS NOT NULL
  AND id NOT IN (
    SELECT DISTINCT ON ("txHash") id
    FROM "CtmTradeProof"
    WHERE "txHash" IS NOT NULL
    ORDER BY "txHash", "createdAt" DESC
  );

-- Unique partial index on CtmTradeProof.txHash prevents the same on-chain
-- transaction from being submitted as proof for more than one CTM trade.
-- NULL values are excluded (PostgreSQL allows multiple NULLs in unique indexes).
CREATE UNIQUE INDEX IF NOT EXISTS "CtmTradeProof_txHash_key"
  ON "CtmTradeProof"("txHash")
  WHERE "txHash" IS NOT NULL;

-- Fast lookup index so cross-table duplicate queries stay O(1).
CREATE INDEX IF NOT EXISTS "CtmTradeProof_txHash_idx"
  ON "CtmTradeProof"("txHash");
