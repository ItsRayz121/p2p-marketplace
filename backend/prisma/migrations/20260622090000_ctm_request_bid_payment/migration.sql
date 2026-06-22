-- Request→trade flow: capture real payment accounts so request-based trades show
-- proper account details instead of "(account details not provided)". Additive.
ALTER TABLE "CtmBid" ADD COLUMN "paymentMethods" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "CtmBid" ADD COLUMN "buyerSettlementId" VARCHAR(500);
ALTER TABLE "CtmBid" ADD COLUMN "buyerPaymentMethodId" VARCHAR(100);
