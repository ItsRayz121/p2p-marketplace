-- WhatsApp-style delivered/read receipts for the persistent Messages inbox
-- (ChatThreadMessage only — the per-trade room chat is untouched).

ALTER TABLE "ChatThreadMessage" ADD COLUMN "deliveredAt" TIMESTAMP(3);
ALTER TABLE "ChatThreadMessage" ADD COLUMN "readAt" TIMESTAMP(3);
