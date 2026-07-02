-- Off-platform reward metadata (display-only) + optional entrant-collection toggles.
ALTER TABLE "PromoGiveaway" ADD COLUMN "rewardAmount" TEXT;
ALTER TABLE "PromoGiveaway" ADD COLUMN "rewardToken" TEXT;
ALTER TABLE "PromoGiveaway" ADD COLUMN "rewardChain" TEXT;
ALTER TABLE "PromoGiveaway" ADD COLUMN "collectName" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PromoGiveaway" ADD COLUMN "collectWhatsapp" BOOLEAN NOT NULL DEFAULT false;

-- Optional entrant-supplied contact fields.
ALTER TABLE "PromoGiveawayEntry" ADD COLUMN "entrantName" TEXT;
ALTER TABLE "PromoGiveawayEntry" ADD COLUMN "whatsapp" TEXT;
