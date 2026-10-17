-- Share & Earn: automated X post verification results (read-only provider lookup).
ALTER TABLE "GasShareReward" ADD COLUMN IF NOT EXISTS "verifyStatus" TEXT;
ALTER TABLE "GasShareReward" ADD COLUMN IF NOT EXISTS "verifyIssues" JSONB;
ALTER TABLE "GasShareReward" ADD COLUMN IF NOT EXISTS "verifyCheckedAt" TIMESTAMP(3);
ALTER TABLE "GasShareReward" ADD COLUMN IF NOT EXISTS "verifyAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "GasShareReward" ADD COLUMN IF NOT EXISTS "postAuthor" TEXT;
ALTER TABLE "GasShareReward" ADD COLUMN IF NOT EXISTS "postCreatedAt" TIMESTAMP(3);
