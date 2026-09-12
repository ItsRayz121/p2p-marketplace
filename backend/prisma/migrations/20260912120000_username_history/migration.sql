-- Permanent username reservation ledger.
--
-- User.username was unique, but only for the CURRENT name — the moment an
-- account renamed, the old handle became free for anyone (including a
-- scammer) to grab and trade on that person's reputation/contacts. Every
-- username a user has ever held (their current one included) now gets a
-- permanent row here. A username is available to claim only if no row
-- exists, or the existing row belongs to the SAME user (so they can freely
-- switch back to a name they used to have).

-- CreateTable
CREATE TABLE "UsernameHistory" (
    "id"        TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "username"  TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsernameHistory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UsernameHistory_username_key" ON "UsernameHistory"("username");
CREATE INDEX "UsernameHistory_userId_idx" ON "UsernameHistory"("userId");

ALTER TABLE "UsernameHistory" ADD CONSTRAINT "UsernameHistory_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: reserve every user's CURRENT username retroactively, so existing
-- handles are protected the instant this ships (id built without needing a
-- server-side uuid extension).
INSERT INTO "UsernameHistory" ("id", "userId", "username", "createdAt")
SELECT 'uh_' || substr(md5(random()::text || clock_timestamp()::text || "id"), 1, 24), "id", "username", CURRENT_TIMESTAMP
FROM "User"
ON CONFLICT ("username") DO NOTHING;

-- Username search lets any user start a conversation with any other user (no
-- shared trade required — a deliberate relaxation of ChatThread's old
-- trade-gate). BlockedUser is the counterbalance: either side can end
-- unwanted contact from a stranger found this way.
CREATE TABLE "BlockedUser" (
    "id"        TEXT NOT NULL,
    "blockerId" TEXT NOT NULL,
    "blockedId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlockedUser_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BlockedUser_blockerId_blockedId_key" ON "BlockedUser"("blockerId", "blockedId");
CREATE INDEX "BlockedUser_blockedId_idx" ON "BlockedUser"("blockedId");

ALTER TABLE "BlockedUser" ADD CONSTRAINT "BlockedUser_blockerId_fkey"
    FOREIGN KEY ("blockerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BlockedUser" ADD CONSTRAINT "BlockedUser_blockedId_fkey"
    FOREIGN KEY ("blockedId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
