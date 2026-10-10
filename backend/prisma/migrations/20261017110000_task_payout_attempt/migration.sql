-- Manual USDT payout tracking: processing / failed, separate from the claim status.
ALTER TABLE "PlatformTaskCompletion" ADD COLUMN IF NOT EXISTS "payoutAttempt" TEXT;
ALTER TABLE "PlatformTaskCompletion" ADD COLUMN IF NOT EXISTS "payoutAttemptNote" VARCHAR(300);
ALTER TABLE "PlatformTaskCompletion" ADD COLUMN IF NOT EXISTS "payoutAttemptAt" TIMESTAMP(3);
ALTER TABLE "PlatformTaskCompletion" ADD COLUMN IF NOT EXISTS "payoutAttemptById" TEXT;
