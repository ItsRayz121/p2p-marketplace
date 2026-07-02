-- Per-entry fulfillment status + creator note, and a public proof sheet URL.
ALTER TABLE "PromoGiveaway" ADD COLUMN "resultsSheetUrl" TEXT;
ALTER TABLE "PromoGiveawayEntry" ADD COLUMN "note" TEXT;
