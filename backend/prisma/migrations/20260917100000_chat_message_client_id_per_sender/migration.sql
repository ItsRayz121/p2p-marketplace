-- The clientId retry-idempotency key (20260915073000_chat_message_client_id)
-- was scoped only to (threadId, clientId), not per sender. A clientId
-- collision between the thread's two DIFFERENT participants would make
-- postThreadMessage's P2002 fallback return the OTHER participant's message
-- instead of creating the second sender's own — rescope to include senderId
-- so a collision can only ever reuse a sender's own prior send.

DROP INDEX "ChatThreadMessage_threadId_clientId_key";
CREATE UNIQUE INDEX "ChatThreadMessage_threadId_senderId_clientId_key" ON "ChatThreadMessage"("threadId", "senderId", "clientId");
