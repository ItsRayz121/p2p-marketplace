-- Maker gate (stage 2): maker approval + ad review queue. Additive; the gate
-- itself stays OFF until the maker_gate_enabled flag is set.
ALTER TYPE "AdStatus" ADD VALUE IF NOT EXISTS 'pending_review';
ALTER TYPE "AdStatus" ADD VALUE IF NOT EXISTS 'rejected';
ALTER TYPE "CtmListingStatus" ADD VALUE IF NOT EXISTS 'pending_review';

ALTER TABLE "User" ADD COLUMN "makerStatus" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "User" ADD COLUMN "makerAppliedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "makerApprovedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "makerApprovedBy" TEXT;
ALTER TABLE "User" ADD COLUMN "makerReviewNote" VARCHAR(500);
ALTER TABLE "User" ADD COLUMN "whatsappNumber" VARCHAR(32);

ALTER TABLE "Ad" ADD COLUMN "reviewNote" VARCHAR(500);
ALTER TABLE "Ad" ADD COLUMN "reviewedBy" TEXT;
ALTER TABLE "Ad" ADD COLUMN "reviewedAt" TIMESTAMP(3);

ALTER TABLE "CtmListing" ADD COLUMN "reviewNote" VARCHAR(500);
ALTER TABLE "CtmListing" ADD COLUMN "reviewedBy" TEXT;
ALTER TABLE "CtmListing" ADD COLUMN "reviewedAt" TIMESTAMP(3);

-- Grandfather: anyone who already has an ad or a CTM listing keeps posting without
-- friction. Accounts that are banned, suspended, under review or on a trading hold
-- are deliberately NOT approved, so a problem account has to re-earn it.
UPDATE "User" u SET "makerStatus" = 'approved', "makerApprovedAt" = NOW()
WHERE u."isBanned" = false AND u."isSuspended" = false AND u."underReview" = false AND u."tradingHold" = false
  AND (
    EXISTS (SELECT 1 FROM "Ad" a WHERE a."userId" = u.id)
    OR EXISTS (
      SELECT 1 FROM "CtmMerchantProfile" p
      JOIN "CtmListing" l ON l."merchantProfileId" = p.id
      WHERE p."userId" = u.id
    )
  );
