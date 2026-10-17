-- CreateTable
CREATE TABLE "TelegramSentMessage" (
    "id" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "messageId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "refKey" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramSentMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TelegramSentMessage_kind_refKey_idx" ON "TelegramSentMessage"("kind", "refKey");

-- CreateIndex
CREATE INDEX "TelegramSentMessage_sentAt_idx" ON "TelegramSentMessage"("sentAt");
