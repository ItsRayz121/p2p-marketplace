-- Phase 4: non-custodial concurrency / anti-griefing
-- Additive only; tradeAbandonCount defaults to 0, cooldown nullable. Safe.
ALTER TABLE "User" ADD COLUMN "tradeAbandonCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "tradeCooldownUntil" TIMESTAMP(3);
