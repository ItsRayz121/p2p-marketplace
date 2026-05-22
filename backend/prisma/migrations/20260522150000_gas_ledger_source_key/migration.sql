-- Add idempotency key to GasLedgerEntry.
-- NULL values are permitted (multiple NULLs are allowed by Postgres unique index).
-- Webhook entries set: MORALIS:{chain}:{txHash}:{toAddress}
-- Balance-diff entries set: BALANCE_DIFF:{chain}:{address}:{symbol}:{2min-bucket}
ALTER TABLE "GasLedgerEntry" ADD COLUMN "sourceKey" TEXT;
CREATE UNIQUE INDEX "GasLedgerEntry_sourceKey_key" ON "GasLedgerEntry"("sourceKey");
CREATE INDEX "GasLedgerEntry_txHash_idx" ON "GasLedgerEntry"("txHash");
