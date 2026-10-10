-- Points-purchased boost for Community Token listings (same behaviour as USDT ads).
ALTER TABLE "CtmListing" ADD COLUMN IF NOT EXISTS "boostedUntil" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "CtmListing_status_boostedUntil_idx" ON "CtmListing"("status", "boostedUntil");
