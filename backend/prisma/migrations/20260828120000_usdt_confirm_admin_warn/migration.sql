-- USDT final-confirmation deadline, round 2.
--
-- 1. The badge gate is gone: usdtTradeDeadline.job now auto-completes EVERY trade
--    still sitting in crypto_sent past its confirmDeadlineAt, not just those whose
--    seller carries a trusted badge. USDT is non-custodial — "complete" only marks
--    status + stats + releases the maker bond; the buyer's real protection is the
--    dispute button, which moves the trade off crypto_sent and out of the sweep.
--
-- 2. confirmAdminWarnedAt tracks the one-time "this trade auto-completes in ~6h"
--    heads-up sent to admin for NON-trusted sellers, so a human still gets a
--    window to catch obvious fraud before the deadline fires. Fires once per
--    trade instead of every 30-minute sweep.
ALTER TABLE "Trade" ADD COLUMN IF NOT EXISTS "confirmAdminWarnedAt" TIMESTAMP(3);

-- Backfill: trades that reached crypto_sent BEFORE the deadline machinery existed
-- (migration 20260827120000) have a NULL confirmDeadlineAt and would never be
-- swept — they'd occupy both parties' concurrent-trade slots forever. Anchor a
-- deadline to their last update: already-stale ones (updatedAt > 24h ago) fire on
-- the very next sweep, fresher ones still get whatever remains of a 24h window.
UPDATE "Trade"
SET "confirmDeadlineAt" = "updatedAt" + INTERVAL '24 hours'
WHERE "status" = 'crypto_sent' AND "confirmDeadlineAt" IS NULL;
