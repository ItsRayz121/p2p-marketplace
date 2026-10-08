-- Emoji reactions on channel broadcasts: { userId: emoji }.
ALTER TABLE "ChannelMessage" ADD COLUMN "reactions" JSONB;
