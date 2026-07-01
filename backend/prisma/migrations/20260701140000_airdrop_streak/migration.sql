-- Airdrop Phase 3 — streak state on the per-(user, season) account.
ALTER TABLE "AirdropAccount"
    ADD COLUMN "streakCount" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "longestStreak" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "lastActiveDay" TIMESTAMP(3),
    ADD COLUMN "freezes" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "streakBrokenAt" TIMESTAMP(3),
    ADD COLUMN "preBreakStreak" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "repairsUsed" INTEGER NOT NULL DEFAULT 0;
