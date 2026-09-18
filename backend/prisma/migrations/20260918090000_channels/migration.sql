-- Telegram-style broadcast Channels tab: owner posts text-only updates, members
-- read. Separate from ChatThread (always a 2-person DM) — this is one-to-many
-- broadcast messaging, text-only by design (no attachment column at all).

-- CreateTable
CREATE TABLE "Channel" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "description" VARCHAR(300),
    "slug" TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'public',
    "avatarUrl" TEXT,
    "memberCount" INTEGER NOT NULL DEFAULT 1,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelMember" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'subscriber',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelMessage" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "body" VARCHAR(4000) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clientId" TEXT,
    "sharedAdMarket" TEXT,
    "sharedAdId" TEXT,

    CONSTRAINT "ChannelMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Channel_slug_key" ON "Channel"("slug");

-- CreateIndex
CREATE INDEX "Channel_visibility_lastMessageAt_idx" ON "Channel"("visibility", "lastMessageAt");

-- CreateIndex
CREATE INDEX "Channel_ownerId_idx" ON "Channel"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelMember_channelId_userId_key" ON "ChannelMember"("channelId", "userId");

-- CreateIndex
CREATE INDEX "ChannelMember_userId_idx" ON "ChannelMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelMessage_channelId_senderId_clientId_key" ON "ChannelMessage"("channelId", "senderId", "clientId");

-- CreateIndex
CREATE INDEX "ChannelMessage_channelId_createdAt_idx" ON "ChannelMessage"("channelId", "createdAt");

-- AddForeignKey
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelMember" ADD CONSTRAINT "ChannelMember_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelMember" ADD CONSTRAINT "ChannelMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelMessage" ADD CONSTRAINT "ChannelMessage_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
