-- When ON, the owner's new USDT ads / CTM listings (and price edits on them)
-- auto-post into the channel as a shared-listing broadcast.

-- AlterTable
ALTER TABLE "Channel" ADD COLUMN "autoShareListings" BOOLEAN NOT NULL DEFAULT false;
