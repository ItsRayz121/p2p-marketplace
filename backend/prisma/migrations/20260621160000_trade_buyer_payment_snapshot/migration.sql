-- Buy-ad trades record the buyer/lister's pay-FROM account(s) so the seller can
-- see where the PKR payment will arrive from. Additive nullable column.
ALTER TABLE "Trade" ADD COLUMN "buyerPaymentSnapshot" JSONB;
