-- One-tap "share my listing" into a chat thread: a message can reference the
-- sender's own Ad (usdt) or CtmListing (ctm) by id. No FK — the referenced
-- row can later be edited/deleted, so its current state is resolved live on
-- read rather than snapshotted here.

ALTER TABLE "ChatThreadMessage" ADD COLUMN "sharedAdMarket" TEXT;
ALTER TABLE "ChatThreadMessage" ADD COLUMN "sharedAdId" TEXT;
