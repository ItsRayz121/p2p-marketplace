-- Add dispute win/loss tracking to TradeStats
ALTER TABLE "TradeStats" ADD COLUMN "disputesWon" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "TradeStats" ADD COLUMN "disputesLost" INTEGER NOT NULL DEFAULT 0;
