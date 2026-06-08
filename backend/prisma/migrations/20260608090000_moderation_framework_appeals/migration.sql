-- Admin Audit Phase 1 — User Management & Enforcement framework.
-- Adds duration/classification to moderation, an immutable action log, and appeals.
-- isBanned / isSuspended remain the authoritative enforcement flags.

-- ── Appeal status enum ──
CREATE TYPE "AppealStatus" AS ENUM ('pending', 'approved', 'rejected', 'more_info_requested');

-- ── New moderation columns on User ──
ALTER TABLE "User" ADD COLUMN     "suspendedUntil" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN     "bannedUntil" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN     "banType" TEXT;
ALTER TABLE "User" ADD COLUMN     "underReview" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN     "moderationReason" VARCHAR(1000);

-- Backfill: existing banned/suspended users get classified + carry their reason.
UPDATE "User" SET "banType" = 'permanent', "moderationReason" = "suspendReason"
  WHERE "isBanned" = true;
UPDATE "User" SET "moderationReason" = "suspendReason"
  WHERE "isSuspended" = true AND "isBanned" = false;

-- ── ModerationAction (immutable audit of moderation) ──
CREATE TABLE "ModerationAction" (
    "id" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "moderatorId" TEXT,
    "action" TEXT NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "previousStatus" TEXT NOT NULL,
    "newStatus" TEXT NOT NULL,
    "durationLabel" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModerationAction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ModerationAction_targetUserId_createdAt_idx" ON "ModerationAction"("targetUserId", "createdAt");
CREATE INDEX "ModerationAction_moderatorId_idx" ON "ModerationAction"("moderatorId");
CREATE INDEX "ModerationAction_action_idx" ON "ModerationAction"("action");

ALTER TABLE "ModerationAction" ADD CONSTRAINT "ModerationAction_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ModerationAction" ADD CONSTRAINT "ModerationAction_moderatorId_fkey" FOREIGN KEY ("moderatorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Appeal ──
CREATE TABLE "Appeal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "AppealStatus" NOT NULL DEFAULT 'pending',
    "subjectStatus" TEXT NOT NULL,
    "explanation" VARCHAR(2000) NOT NULL,
    "evidenceUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "decisionNote" VARCHAR(1000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Appeal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Appeal_status_createdAt_idx" ON "Appeal"("status", "createdAt");
CREATE INDEX "Appeal_userId_createdAt_idx" ON "Appeal"("userId", "createdAt");

ALTER TABLE "Appeal" ADD CONSTRAINT "Appeal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Appeal" ADD CONSTRAINT "Appeal_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
