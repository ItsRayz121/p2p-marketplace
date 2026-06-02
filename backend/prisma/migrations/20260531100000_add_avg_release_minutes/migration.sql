-- Add avg release time (payment_confirmed → crypto_released) to TradeStats
ALTER TABLE "TradeStats" ADD COLUMN "avgReleaseMinutes" INTEGER;
