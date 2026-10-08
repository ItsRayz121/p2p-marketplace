-- Emoji reactions on direct-message thread messages: { userId: emoji }.
ALTER TABLE "ChatThreadMessage" ADD COLUMN "reactions" JSONB;
