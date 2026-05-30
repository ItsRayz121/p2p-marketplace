-- Add response time tracking fields to Trade
ALTER TABLE "Trade" ADD COLUMN "paymentUploadedAt" TIMESTAMP(3);
ALTER TABLE "Trade" ADD COLUMN "paymentConfirmedAt" TIMESTAMP(3);

-- Add pre-calculated avg response time to TradeStats
ALTER TABLE "TradeStats" ADD COLUMN "avgResponseMinutes" INTEGER;
