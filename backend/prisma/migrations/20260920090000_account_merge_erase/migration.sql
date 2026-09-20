-- Admin-approved identity resolution: lets an admin resolve a Telegram/email
-- link conflict between two ESTABLISHED accounts by picking a survivor
-- (mergedIntoId points the retired account at it) instead of the current
-- blanket "never merge" refusal, plus a standalone identity-erase action that
-- frees an account's login identity without designating a survivor.
ALTER TABLE "User" ADD COLUMN "mergedIntoId" TEXT;
ALTER TABLE "User" ADD COLUMN "historyMaskedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "identityErasedAt" TIMESTAMP(3);

CREATE INDEX "User_mergedIntoId_idx" ON "User"("mergedIntoId");

ALTER TABLE "User" ADD CONSTRAINT "User_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
