-- USDT-as-payment-currency in the Community Token Market (flag + code-ready
-- gated — see ctm/ctm.usdtPayment.ts). Every column defaults so existing rows
-- and current behavior stay PKR-only and byte-identical until the feature is
-- QA'd and its readiness + `ctm_usdt_payment_enabled` flag are enabled.

-- AlterTable — CtmListing
ALTER TABLE "CtmListing" ADD COLUMN "paymentCurrency" VARCHAR(10) NOT NULL DEFAULT 'PKR';
ALTER TABLE "CtmListing" ADD COLUMN "usdtPaymentMethods" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "CtmListing" ADD COLUMN "usdtSettlementDestinations" JSONB;

-- AlterTable — CtmTrade
ALTER TABLE "CtmTrade" ADD COLUMN "paymentCurrency" VARCHAR(10) NOT NULL DEFAULT 'PKR';
ALTER TABLE "CtmTrade" ADD COLUMN "usdtDeliveryMethod" VARCHAR(40);
ALTER TABLE "CtmTrade" ADD COLUMN "usdtDeliveryAddress" VARCHAR(200);
ALTER TABLE "CtmTrade" ADD COLUMN "usdtAmount" DECIMAL(28,8);
