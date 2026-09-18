-- Lets the channel owner attach one image per broadcast (client-side compressed
-- before upload; served off Cloudinary's CDN so it's cache hits, not repeated
-- storage/transform cost, as the message fans out to members).

-- AlterTable
ALTER TABLE "ChannelMessage" ADD COLUMN "attachmentUrl" TEXT;
