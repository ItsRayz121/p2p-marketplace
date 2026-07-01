-- Airdrop / Points system (Phase 1 — earning engine).
-- Inert until PlatformConfig flag `airdrop_enabled` = 'true'. Append-only ledger
-- with a UNIQUE eventKey (the anti-double-count guard) + cached per-season totals.

-- CreateEnum
CREATE TYPE "AirdropSeasonStatus" AS ENUM ('active', 'closed');

-- CreateEnum
CREATE TYPE "AirdropSource" AS ENUM ('usdt_trade', 'ctm_trade', 'gas_order', 'referral', 'checkin', 'social', 'streak_bonus', 'admin_adjust', 'clawback');

-- CreateTable
CREATE TABLE "AirdropSeason" (
    "id" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "status" "AirdropSeasonStatus" NOT NULL DEFAULT 'active',
    "tokenPool" DECIMAL(38,8),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AirdropSeason_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AirdropAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "totalPoints" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AirdropAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AirdropLedger" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "source" "AirdropSource" NOT NULL,
    "points" DECIMAL(18,4) NOT NULL,
    "eventKey" TEXT NOT NULL,
    "pairKey" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AirdropLedger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AirdropSeason_index_key" ON "AirdropSeason"("index");

-- CreateIndex
CREATE UNIQUE INDEX "AirdropAccount_userId_seasonId_key" ON "AirdropAccount"("userId", "seasonId");

-- CreateIndex
CREATE INDEX "AirdropAccount_seasonId_totalPoints_idx" ON "AirdropAccount"("seasonId", "totalPoints");

-- CreateIndex
CREATE UNIQUE INDEX "AirdropLedger_eventKey_key" ON "AirdropLedger"("eventKey");

-- CreateIndex
CREATE INDEX "AirdropLedger_userId_seasonId_idx" ON "AirdropLedger"("userId", "seasonId");

-- CreateIndex
CREATE INDEX "AirdropLedger_userId_source_createdAt_idx" ON "AirdropLedger"("userId", "source", "createdAt");

-- CreateIndex
CREATE INDEX "AirdropLedger_seasonId_createdAt_idx" ON "AirdropLedger"("seasonId", "createdAt");

-- CreateIndex
CREATE INDEX "AirdropLedger_pairKey_idx" ON "AirdropLedger"("pairKey");

-- Seed Season 1 so earning works the instant the flag is flipped (no admin step
-- needed to bootstrap). Inert while the flag is OFF.
INSERT INTO "AirdropSeason" ("id", "index", "name", "status", "startedAt", "createdAt", "updatedAt")
VALUES ('airdrop-season-1', 1, 'Season 1', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
