-- One-tap "share gas fees" — mirrors sharedAdMarket/sharedAdId, but a gas
-- chain is identified purely by slug (no market split, no ownership).

-- AlterTable
ALTER TABLE "ChatThreadMessage" ADD COLUMN "sharedGasChainSlug" TEXT;

-- AlterTable
ALTER TABLE "ChannelMessage" ADD COLUMN "sharedGasChainSlug" TEXT;
