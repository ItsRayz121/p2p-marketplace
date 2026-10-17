-- Document-level KYC review: Basic and Enhanced are decided separately, and each document / answer
-- can be approved or sent back on its own. Additive and backwards compatible.

ALTER TABLE "KycSubmission" ADD COLUMN "basicState" VARCHAR(20) NOT NULL DEFAULT 'pending';
ALTER TABLE "KycSubmission" ADD COLUMN "enhancedState" VARCHAR(20) NOT NULL DEFAULT 'not_requested';

-- Backfill from the existing single status so nobody is downgraded or re-queued:
--   approved stays approved, rejected stays rejected, pending stays pending.
UPDATE "KycSubmission" SET "basicState" = CASE "status"::text WHEN 'approved' THEN 'approved' WHEN 'rejected' THEN 'rejected' ELSE 'pending' END;
UPDATE "KycSubmission" SET "enhancedState" = CASE WHEN "tier"::text = 'enhanced'
  THEN (CASE "status"::text WHEN 'approved' THEN 'approved' WHEN 'rejected' THEN 'rejected' ELSE 'pending' END)
  ELSE 'not_requested' END;
-- A pending Enhanced submission that reuses an identity the same user already had approved: its
-- identity part was decided before.
UPDATE "KycSubmission" s SET "basicState" = 'approved'
  WHERE s."tier"::text = 'enhanced' AND s."status"::text = 'pending'
    AND EXISTS (SELECT 1 FROM "KycSubmission" o WHERE o."userId" = s."userId" AND o."status"::text = 'approved' AND o."cnicNumberHash" = s."cnicNumberHash" AND o."id" <> s."id");

CREATE TABLE "KycItemReview" (
  "id" TEXT NOT NULL,
  "submissionId" TEXT NOT NULL,
  "item" VARCHAR(30) NOT NULL,
  "status" VARCHAR(20) NOT NULL,
  "reason" VARCHAR(300),
  "previousValue" TEXT,
  "actorId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KycItemReview_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "KycItemReview_submissionId_item_createdAt_idx" ON "KycItemReview"("submissionId", "item", "createdAt");

ALTER TABLE "KycItemReview" ADD CONSTRAINT "KycItemReview_submissionId_fkey"
  FOREIGN KEY ("submissionId") REFERENCES "KycSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
