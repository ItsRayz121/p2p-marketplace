-- CTM Phase 2: escrow fields on ctm_trades for ON_CHAIN settlement support

ALTER TABLE "ctm_trades" ADD COLUMN IF NOT EXISTS "escrow_address"      VARCHAR(200);
ALTER TABLE "ctm_trades" ADD COLUMN IF NOT EXISTS "escrow_amount"       DECIMAL(28,8);
ALTER TABLE "ctm_trades" ADD COLUMN IF NOT EXISTS "escrow_currency"     VARCHAR(20);
ALTER TABLE "ctm_trades" ADD COLUMN IF NOT EXISTS "escrow_tx_hash"      VARCHAR(200);
ALTER TABLE "ctm_trades" ADD COLUMN IF NOT EXISTS "escrow_confirmed_at" TIMESTAMP(3);
