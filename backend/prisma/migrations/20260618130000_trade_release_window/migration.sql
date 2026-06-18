-- Phase 3b: non-custodial release window
-- Additive + nullable — safe, no backfill. Only populated when the
-- noncustodial_p2p_enabled flag is ON.
ALTER TABLE "Trade" ADD COLUMN "releaseDeadlineAt" TIMESTAMP(3);
