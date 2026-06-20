-- Anchor timestamp for the post-completion rating window.
-- Additive only — a single nullable column. Safe to deploy.
ALTER TABLE "Trade" ADD COLUMN "releasedAt" TIMESTAMP(3);

-- Backfill existing completed trades so their rating window is anchored to a
-- sensible time (the last update, which for a released trade is the release).
UPDATE "Trade" SET "releasedAt" = "updatedAt" WHERE "status" = 'crypto_released' AND "releasedAt" IS NULL;
