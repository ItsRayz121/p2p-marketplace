-- WhatsApp-style delivered/read receipts for the per-trade room chat
-- (TradeMessage = USDT trades, CtmTradeMessage = CTM trades). Mirrors
-- 20260915070000_chat_message_receipts, which added the same columns to
-- ChatThreadMessage for the persistent Messages inbox.

ALTER TABLE "TradeMessage" ADD COLUMN "deliveredAt" TIMESTAMP(3);
ALTER TABLE "TradeMessage" ADD COLUMN "readAt" TIMESTAMP(3);

ALTER TABLE "CtmTradeMessage" ADD COLUMN "deliveredAt" TIMESTAMP(3);
ALTER TABLE "CtmTradeMessage" ADD COLUMN "readAt" TIMESTAMP(3);
