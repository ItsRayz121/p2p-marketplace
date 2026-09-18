-- Lets a channel owner edit a broadcast after sending it (mirrors the existing
-- delete window) instead of only being able to delete and repost.

-- AlterTable
ALTER TABLE "ChannelMessage" ADD COLUMN "editedAt" TIMESTAMP(3);
