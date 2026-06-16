-- Snapshot of the seller's receiving account, captured at trade creation so the
-- buyer's pay-to details are immutable for the life of the trade (dispute
-- evidence) even if the seller later edits or deletes that payment method.
-- Nullable + additive: legacy trades keep resolving the account at read time.
ALTER TABLE "Trade" ADD COLUMN "sellerPaymentSnapshot" JSONB;
