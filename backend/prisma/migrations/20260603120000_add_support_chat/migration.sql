-- Live support chat: user-to-admin conversations and messages

CREATE TABLE "SupportConversation" (
    "id"            TEXT NOT NULL,
    "userId"        TEXT NOT NULL,
    "status"        TEXT NOT NULL DEFAULT 'open',
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unreadByAdmin" BOOLEAN NOT NULL DEFAULT false,
    "unreadByUser"  BOOLEAN NOT NULL DEFAULT false,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportConversation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SupportConversation_userId_idx" ON "SupportConversation"("userId");
CREATE INDEX "SupportConversation_status_lastMessageAt_idx" ON "SupportConversation"("status", "lastMessageAt");

ALTER TABLE "SupportConversation" ADD CONSTRAINT "SupportConversation_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SupportMessage" (
    "id"             TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "sender"         TEXT NOT NULL,
    "senderId"       TEXT,
    "body"           TEXT NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SupportMessage_conversationId_createdAt_idx" ON "SupportMessage"("conversationId", "createdAt");

ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "SupportConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
