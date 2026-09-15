-- Send-retry idempotency for the Messages inbox: a client-generated id lets a
-- retried POST after a lost response reuse the same key instead of creating a
-- duplicate message. Postgres treats NULLs as distinct, so existing rows (and
-- future system/legacy messages with no clientId) never collide on this index.

ALTER TABLE "ChatThreadMessage" ADD COLUMN "clientId" TEXT;
CREATE UNIQUE INDEX "ChatThreadMessage_threadId_clientId_key" ON "ChatThreadMessage"("threadId", "clientId");
