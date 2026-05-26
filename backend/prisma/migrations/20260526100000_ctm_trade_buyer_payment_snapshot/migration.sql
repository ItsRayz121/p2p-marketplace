-- Add buyerPaymentSnapshot to CtmTrade
-- Stores a snapshot of the buyer's "pay from" payment account for SELL listing trades.
-- NULL for BUY listing trades (buyer pays from their own account determined at trade time).
ALTER TABLE "CtmTrade" ADD COLUMN "buyerPaymentSnapshot" JSONB;
