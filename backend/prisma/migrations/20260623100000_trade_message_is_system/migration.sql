-- Add isSystem flag to trade chat messages (USDT + CTM) so platform step-transition
-- messages can be rendered as centered status lines instead of a party's bubble.
ALTER TABLE "TradeMessage" ADD COLUMN "isSystem" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CtmTradeMessage" ADD COLUMN "isSystem" BOOLEAN NOT NULL DEFAULT false;
