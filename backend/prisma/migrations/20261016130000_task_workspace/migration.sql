-- Community Tasks workspace: richer task definition, lifecycle and revision-based review.
ALTER TABLE "PlatformTask"
  ADD COLUMN "logoUrl" TEXT,
  ADD COLUMN "platform" TEXT,
  ADD COLUMN "instructions" VARCHAR(2000),
  ADD COLUMN "proofRequirements" VARCHAR(1000),
  ADD COLUMN "proofFileRequired" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "isDraft" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "archivedAt" TIMESTAMP(3),
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "PlatformTaskCompletion"
  ADD COLUMN "revisionNo" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "taskVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "snapshot" JSONB;

CREATE TABLE "PlatformTaskRevision" (
  "id" TEXT NOT NULL,
  "completionId" TEXT NOT NULL,
  "number" INTEGER NOT NULL,
  "proof" VARCHAR(500),
  "links" JSONB,
  "attachments" JSONB,
  "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decision" TEXT,
  "feedback" VARCHAR(1000),
  "internalNote" VARCHAR(1000),
  "checks" JSONB,
  "reviewedById" TEXT,
  "reviewedAt" TIMESTAMP(3),
  CONSTRAINT "PlatformTaskRevision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlatformTaskRevision_completionId_number_key" ON "PlatformTaskRevision"("completionId", "number");
CREATE INDEX "PlatformTaskRevision_decision_submittedAt_idx" ON "PlatformTaskRevision"("decision", "submittedAt");
ALTER TABLE "PlatformTaskRevision" ADD CONSTRAINT "PlatformTaskRevision_completionId_fkey"
  FOREIGN KEY ("completionId") REFERENCES "PlatformTaskCompletion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every existing claim becomes revision 1 so the review history is complete.
INSERT INTO "PlatformTaskRevision" ("id", "completionId", "number", "proof", "submittedAt", "decision", "feedback", "reviewedById", "reviewedAt")
SELECT
  'rev_' || c."id", c."id", 1, LEFT(c."proof", 500), c."createdAt",
  CASE c."status" WHEN 'rejected' THEN 'rejected' WHEN 'completed' THEN 'approved' WHEN 'awaiting_payout' THEN 'approved' ELSE NULL END,
  c."rejectionReason", c."reviewedById", c."reviewedAt"
FROM "PlatformTaskCompletion" c;
