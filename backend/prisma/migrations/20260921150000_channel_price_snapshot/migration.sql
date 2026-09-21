-- Freeze the price shown on a channel's shared-listing card at post time,
-- instead of always re-resolving to the listing's current live price (see
-- channel.service.ts's postChannelMessage / listChannelMessages). Nullable —
-- rows sent before this migration have no snapshot and keep falling back to
-- the live-resolved price.

-- AlterTable
ALTER TABLE "ChannelMessage" ADD COLUMN "sharedAdPriceSnapshot" DECIMAL(14,2);
ALTER TABLE "ChannelMessage" ADD COLUMN "sharedAdPrevPriceSnapshot" DECIMAL(14,2);
