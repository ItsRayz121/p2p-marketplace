-- USDT final-confirmation deadline. Mirrors CTM's confirmDeadlineAt: set when a
-- trade reaches the crypto_sent rung so usdtTradeDeadline.job can nudge the
-- pending confirmer and, if the deadline passes, auto-complete (trusted
-- deliverer) or flag for admin review (untrusted) instead of leaving the trade
-- stuck forever and eating both parties' concurrent-trade slots.

ALTER TABLE "Trade" ADD COLUMN IF NOT EXISTS "confirmDeadlineAt" TIMESTAMP(3);
ALTER TABLE "Trade" ADD COLUMN IF NOT EXISTS "confirmReminderSentAt" TIMESTAMP(3);
