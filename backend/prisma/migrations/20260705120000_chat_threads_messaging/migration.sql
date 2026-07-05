-- Persistent counterparty messaging (Phase 4).
-- One permanent ChatThread per unordered user pair (canonical userAId < userBId),
-- reused across every trade. Each trade is a TradeEpisode marker within the thread.
-- Trade-gated (a thread only exists once the pair has traded). Modeled on
-- SupportConversation.

-- CreateTable
CREATE TABLE "ChatThread" (
    "id" TEXT NOT NULL,
    "userAId" TEXT NOT NULL,
    "userBId" TEXT NOT NULL,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unreadByA" BOOLEAN NOT NULL DEFAULT false,
    "unreadByB" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatThreadMessage" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "body" VARCHAR(2000) NOT NULL,
    "attachmentUrl" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatThreadMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradeEpisode" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "tradeId" TEXT NOT NULL,
    "tradeRef" TEXT NOT NULL,
    "outcome" TEXT NOT NULL DEFAULT 'active',
    "fiatAmount" DECIMAL(14,2),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TradeEpisode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChatThread_userAId_userBId_key" ON "ChatThread"("userAId", "userBId");

-- CreateIndex
CREATE INDEX "ChatThread_userAId_lastMessageAt_idx" ON "ChatThread"("userAId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "ChatThread_userBId_lastMessageAt_idx" ON "ChatThread"("userBId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "ChatThreadMessage_threadId_createdAt_idx" ON "ChatThreadMessage"("threadId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TradeEpisode_market_tradeId_key" ON "TradeEpisode"("market", "tradeId");

-- CreateIndex
CREATE INDEX "TradeEpisode_threadId_startedAt_idx" ON "TradeEpisode"("threadId", "startedAt");

-- AddForeignKey
ALTER TABLE "ChatThread" ADD CONSTRAINT "ChatThread_userAId_fkey" FOREIGN KEY ("userAId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatThread" ADD CONSTRAINT "ChatThread_userBId_fkey" FOREIGN KEY ("userBId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatThreadMessage" ADD CONSTRAINT "ChatThreadMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ChatThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeEpisode" ADD CONSTRAINT "TradeEpisode_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ChatThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
