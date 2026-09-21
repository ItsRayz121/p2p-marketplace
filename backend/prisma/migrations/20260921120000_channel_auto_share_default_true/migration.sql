-- Channels created from now on default to auto-sharing the owner's own
-- listings/price-updates (see channel.service.ts's autoShareToOwnerChannels).
-- Existing channels are untouched by this DEFAULT change — it only affects
-- rows inserted without an explicit value going forward.

-- AlterTable
ALTER TABLE "Channel" ALTER COLUMN "autoShareListings" SET DEFAULT true;
