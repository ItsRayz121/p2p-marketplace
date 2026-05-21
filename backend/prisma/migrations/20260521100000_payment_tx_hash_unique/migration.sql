-- Nullify duplicate paymentTxHash values before adding unique constraint.
-- Keeps the earliest order (by createdAt) for each hash; nulls out the rest.
UPDATE "GasFeeOrder"
SET "paymentTxHash" = NULL
WHERE id NOT IN (
  SELECT DISTINCT ON ("paymentTxHash") id
  FROM "GasFeeOrder"
  WHERE "paymentTxHash" IS NOT NULL
  ORDER BY "paymentTxHash", "createdAt" ASC
)
AND "paymentTxHash" IS NOT NULL;

-- Drop the old non-unique index on paymentTxHash
DROP INDEX IF EXISTS "GasFeeOrder_paymentTxHash_idx";

-- Add a unique constraint (also serves as the lookup index)
ALTER TABLE "GasFeeOrder" ADD CONSTRAINT "GasFeeOrder_paymentTxHash_key" UNIQUE ("paymentTxHash");
