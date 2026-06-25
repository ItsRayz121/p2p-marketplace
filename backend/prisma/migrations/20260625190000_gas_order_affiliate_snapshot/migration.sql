-- Phase 5 follow-up: persist the affiliate buyer-discount snapshot on each gas order so
-- the checkout/tracking screens can show "X% off courtesy of <referrer>" after a refresh.
-- Additive; defaults preserve current behavior (0 discount, no referrer).

ALTER TABLE "GasFeeOrder" ADD COLUMN "affiliateDiscountUsdt" DECIMAL(10,4) NOT NULL DEFAULT 0;
ALTER TABLE "GasFeeOrder" ADD COLUMN "affiliateReferrer" TEXT;
