-- Dispute-resume: let both parties keep settling a trade while a dispute is open.
--
-- `status` stays parked at 'disputed' (so every existing admin list, filter,
-- dashboard and concurrency check keeps working untouched) while the new column
-- carries the REAL ladder rung. It advances as the parties act. The dispute only
-- closes itself — as `settled_by_parties` — when the trade actually COMPLETES.

-- No-fault resolution type for a dispute the parties finished themselves.
ALTER TYPE "DisputeResolutionType" ADD VALUE IF NOT EXISTS 'settled_by_parties';

ALTER TABLE "Trade"    ADD COLUMN IF NOT EXISTS "disputeResumeStatus" "TradeStatus";
ALTER TABLE "CtmTrade" ADD COLUMN IF NOT EXISTS "disputeResumeStatus" "CtmTradeStatus";
