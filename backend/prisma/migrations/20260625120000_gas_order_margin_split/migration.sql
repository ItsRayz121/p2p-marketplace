-- Phase 0 of the Gas-Payment promo/referral system: record the platform-margin
-- component of every gas order separately from the base gas cost, so later phases
-- can apply discounts/referrals to the MARGIN ONLY (never the base cost).
--
-- All columns are additive and safe:
--   * platformMarginUsdt is nullable (orders created before this migration stay null;
--     the margin is still recoverable as paymentAmount - gasAmountUSD).
--   * discountUsdt defaults to 0 -> existing and new orders behave exactly as today.
--   * promoCodeId is nullable and unused until Phase 1.
ALTER TABLE "GasFeeOrder" ADD COLUMN "platformMarginUsdt" DECIMAL(10,4);
ALTER TABLE "GasFeeOrder" ADD COLUMN "discountUsdt" DECIMAL(10,4) NOT NULL DEFAULT 0;
ALTER TABLE "GasFeeOrder" ADD COLUMN "promoCodeId" TEXT;
