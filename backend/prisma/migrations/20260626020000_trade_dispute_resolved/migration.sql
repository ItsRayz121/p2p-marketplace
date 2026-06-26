-- Add a terminal "dispute_resolved" status for USDT trades so a trade no longer
-- shows as "Disputed" forever after an admin resolves the dispute (mirrors the
-- CtmTradeStatus enum, which already has dispute_resolved). Additive + idempotent.
ALTER TYPE "TradeStatus" ADD VALUE IF NOT EXISTS 'dispute_resolved';
