-- Quote-reply references for DM threads and channel broadcasts (soft reference, nullable).
ALTER TABLE "ChatThreadMessage" ADD COLUMN "replyToId" TEXT;
ALTER TABLE "ChannelMessage" ADD COLUMN "replyToId" TEXT;
