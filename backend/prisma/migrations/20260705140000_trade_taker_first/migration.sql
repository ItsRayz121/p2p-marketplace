-- Taker-first settlement (Phase 1) marker. Records whether a trade used the
-- reordered BUY-ad flow (taker sends first). Defaults false = classic flow, so
-- existing rows and current behavior are unchanged until the feature is built +
-- its per-market readiness + flag are enabled.

-- AlterTable
ALTER TABLE "Trade" ADD COLUMN "takerFirst" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "CtmTrade" ADD COLUMN "takerFirst" BOOLEAN NOT NULL DEFAULT false;
