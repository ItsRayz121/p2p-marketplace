-- Community / influencer task-gated giveaways (off-platform reward; creator distributes)

CREATE TABLE "PromoGiveaway" (
    "id"            TEXT NOT NULL,
    "code"          TEXT NOT NULL,
    "title"         TEXT NOT NULL,
    "description"   TEXT,
    "thumbnailUrl"  TEXT,
    "tasks"         JSONB,
    "addressLabel"  TEXT,
    "winnerCount"   INTEGER NOT NULL DEFAULT 0,
    "rewardAll"     BOOLEAN NOT NULL DEFAULT false,
    "requireKyc"    BOOLEAN NOT NULL DEFAULT false,
    "entryDeadline" TIMESTAMP(3),
    "status"        TEXT NOT NULL DEFAULT 'open',
    "isActive"      BOOLEAN NOT NULL DEFAULT true,
    "createdById"   TEXT NOT NULL,
    "createdByRole" TEXT NOT NULL,
    "createdByName" TEXT,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromoGiveaway_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PromoGiveaway_code_key" ON "PromoGiveaway"("code");
CREATE INDEX "PromoGiveaway_isActive_status_idx" ON "PromoGiveaway"("isActive", "status");
CREATE INDEX "PromoGiveaway_createdById_idx" ON "PromoGiveaway"("createdById");

CREATE TABLE "PromoGiveawayEntry" (
    "id"               TEXT NOT NULL,
    "giveawayId"       TEXT NOT NULL,
    "userId"           TEXT NOT NULL,
    "username"         TEXT,
    "email"            TEXT,
    "receivingAddress" TEXT NOT NULL,
    "ackTasks"         JSONB,
    "status"           TEXT NOT NULL DEFAULT 'entered',
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromoGiveawayEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PromoGiveawayEntry_giveawayId_userId_key" ON "PromoGiveawayEntry"("giveawayId", "userId");
CREATE INDEX "PromoGiveawayEntry_giveawayId_status_idx" ON "PromoGiveawayEntry"("giveawayId", "status");

ALTER TABLE "PromoGiveawayEntry" ADD CONSTRAINT "PromoGiveawayEntry_giveawayId_fkey"
    FOREIGN KEY ("giveawayId") REFERENCES "PromoGiveaway"("id") ON DELETE CASCADE ON UPDATE CASCADE;
