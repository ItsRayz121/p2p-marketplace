-- Telegram ban-safety: track users the bot may NOT message (blocked the bot, or
-- never started it → "can't initiate conversation"). While set, all bot sends
-- skip them. Continuing to DM blocked users is the top Telegram ban trigger.
ALTER TABLE "User" ADD COLUMN "telegramBlockedAt" TIMESTAMP(3);
