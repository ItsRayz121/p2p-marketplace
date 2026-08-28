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
-- deadline to their last update (updatedAt + 24h), but floor it at 6h from now so
-- even a weeks-old stuck trade still gets the runUsdtConfirmAdminWarning heads-up
-- before it auto-completes, rather than the whole backlog completing on the first
-- sweep with no human in the loop. NOW() AT TIME ZONE 'UTC' matches how Prisma
-- stores these tz-naive TIMESTAMP columns (UTC wall time).
UPDATE "Trade"
SET "confirmDeadlineAt" = GREATEST("updatedAt" + INTERVAL '24 hours', (NOW() AT TIME ZONE 'UTC') + INTERVAL '6 hours')
WHERE "status" = 'crypto_sent' AND "confirmDeadlineAt" IS NULL;
