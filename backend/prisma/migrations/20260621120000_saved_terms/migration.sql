-- Saveable / reusable listing terms templates.
-- Additive only — a single new table. Safe to deploy.
CREATE TABLE "SavedTerms" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavedTerms_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SavedTerms_userId_createdAt_idx" ON "SavedTerms"("userId", "createdAt");

ALTER TABLE "SavedTerms" ADD CONSTRAINT "SavedTerms_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
