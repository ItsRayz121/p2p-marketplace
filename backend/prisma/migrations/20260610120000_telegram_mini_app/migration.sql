-- Telegram Mini App identity + pending-referral attribution.
--
-- Adds the Telegram identity columns to "User" (nullable — only populated for
-- accounts created/linked through the Mini App) and a standalone table holding
-- referral codes captured at bot `/start ref_<code>` time, before an account
-- row exists.

-- AlterTable
ALTER TABLE "User"
  ADD COLUMN "telegramId"       BIGINT,
  ADD COLUMN "telegramUsername" TEXT,
  ADD COLUMN "telegramPhotoUrl" TEXT,
  ADD COLUMN "telegramAuthAt"   TIMESTAMP(3);

-- CreateIndex (unique — one account per Telegram id)
CREATE UNIQUE INDEX "User_telegramId_key" ON "User"("telegramId");

-- CreateTable
CREATE TABLE "TelegramPendingReferral" (
    "telegramId"   BIGINT NOT NULL,
    "referralCode" TEXT NOT NULL,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramPendingReferral_pkey" PRIMARY KEY ("telegramId")
);
