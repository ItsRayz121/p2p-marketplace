-- Migration: add buyerDeliveryMethod and buyerDeliveryAddress to Trade
-- Also relax buyerWalletAddress to allow empty string (already defaulted to "" in schema)

ALTER TABLE "Trade"
  ADD COLUMN IF NOT EXISTS "buyerDeliveryMethod"  TEXT,
  ADD COLUMN IF NOT EXISTS "buyerDeliveryAddress" TEXT;

-- Allow existing rows: buyerWalletAddress stays as-is (non-null)
-- New rows supply either buyerWalletAddress OR buyerDeliveryAddress
