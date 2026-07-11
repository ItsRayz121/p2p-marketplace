-- Support chat: image attachments + soft delete (retain for admin/dispute review)
ALTER TABLE "SupportMessage" ADD COLUMN "attachmentUrl" TEXT;
ALTER TABLE "SupportMessage" ADD COLUMN "deletedAt" TIMESTAMP(3);

-- Counterparty messaging: soft delete (attachmentUrl already exists)
ALTER TABLE "ChatThreadMessage" ADD COLUMN "deletedAt" TIMESTAMP(3);
