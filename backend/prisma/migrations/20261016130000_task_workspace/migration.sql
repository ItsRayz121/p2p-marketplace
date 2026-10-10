-- Community Tasks workspace: richer task definition, lifecycle and revision-based review.
-- Written to be re-runnable (IF NOT EXISTS / ON CONFLICT) because an earlier attempt failed on
-- "logoUrl", which migration 20261012100000_platform_task_logo had already added.
ALTER TABLE "PlatformTask"
  ADD COLUMN IF NOT EXISTS "logoUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "platform" TEXT,
  ADD COLUMN IF NOT EXISTS "instructions" VARCHAR(2000),
  ADD COLUMN IF NOT EXISTS "proofRequirements" VARCHAR(1000),
  ADD COLUMN IF NOT EXISTS "proofFileRequired" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "isDraft" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "PlatformTaskCompletion"
  ADD COLUMN IF NOT EXISTS "revisionNo" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "taskVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "snapshot" JSONB;

CREATE TABLE IF NOT EXISTS "PlatformTaskRevision" (
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

CREATE UNIQUE INDEX IF NOT EXISTS "PlatformTaskRevision_completionId_number_key" ON "PlatformTaskRevision"("completionId", "number");
CREATE INDEX IF NOT EXISTS "PlatformTaskRevision_decision_submittedAt_idx" ON "PlatformTaskRevision"("decision", "submittedAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PlatformTaskRevision_completionId_fkey') THEN
    ALTER TABLE "PlatformTaskRevision" ADD CONSTRAINT "PlatformTaskRevision_completionId_fkey"
      FOREIGN KEY ("completionId") REFERENCES "PlatformTaskCompletion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Backfill: every existing claim becomes revision 1 so the review history is complete.
INSERT INTO "PlatformTaskRevision" ("id", "completionId", "number", "proof", "submittedAt", "decision", "feedback", "reviewedById", "reviewedAt")
SELECT
  'rev_' || c."id", c."id", 1, LEFT(c."proof", 500), c."createdAt",
  CASE c."status" WHEN 'rejected' THEN 'rejected' WHEN 'completed' THEN 'approved' WHEN 'awaiting_payout' THEN 'approved' ELSE NULL END,
  LEFT(c."rejectionReason", 1000), c."reviewedById", c."reviewedAt"
FROM "PlatformTaskCompletion" c
ON CONFLICT DO NOTHING;
