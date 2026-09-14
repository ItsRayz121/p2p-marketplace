-- Stuck-trade fixes: CTM terminal-step auto-complete no longer gates on merchant
-- trust tier, and both markets get a final pre-deadline warning to the pending
-- confirmer (not just admin). New columns support the reminder/warning sweeps.

ALTER TABLE "Trade" ADD COLUMN "confirmFinalWarnedAt" TIMESTAMP(3);

ALTER TABLE "CtmTrade" ADD COLUMN "confirmReminderSentAt" TIMESTAMP(3);
ALTER TABLE "CtmTrade" ADD COLUMN "confirmFinalWarnedAt" TIMESTAMP(3);

-- Data cleanup: CTM trades whose terminal confirm deadline was previously cleared
-- by the (now-removed) trust-tier gate in runCtmProofDeadline sit at a terminal
-- step with BOTH deadline fields null — invisible to every sweep. Re-arm
-- confirmDeadlineAt to "now" so the fixed, unconditional auto-complete picks them
-- up on its next pass (within 5 minutes) instead of staying stuck forever.
UPDATE "CtmTrade"
SET "confirmDeadlineAt" = NOW()
WHERE "status" = 'proof_submitted'
  AND "proofDeadlineAt" IS NULL
  AND "confirmDeadlineAt" IS NULL;

-- Raise the concurrency cap now that stuck trades stop occupying slots forever
-- (see the two fixes above + the code changes shipped alongside this migration).
UPDATE "PlatformConfig" SET "value" = '8' WHERE "key" = 'max_concurrent_trades';
UPDATE "PlatformConfig" SET "value" = '2' WHERE "key" = 'max_concurrent_trades_with_dispute';

-- Data cleanup: USDT trades disputed before the `dispute_resolved` terminal status
-- existed have their Dispute already `resolved` but the trade itself parked at
-- `disputed` forever with no resume rung (disputeResumeStatus IS NULL) — a dead
-- end no sweep can reach. Move them to the terminal status directly.
UPDATE "Trade"
SET "status" = 'dispute_resolved'
WHERE "status" = 'disputed'
  AND "disputeResumeStatus" IS NULL
  AND EXISTS (
    SELECT 1 FROM "Dispute" d WHERE d."tradeId" = "Trade"."id" AND d."status" = 'resolved'
  );
