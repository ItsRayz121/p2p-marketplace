-- Gas delivery is now only marked 'delivered' once the chain confirms the tx was mined.
-- Until then the broadcast hash lives here so a retry can rule out a late-landing tx.
ALTER TABLE "GasFeeOrder" ADD COLUMN IF NOT EXISTS "unconfirmedDeliveryTxHash" TEXT;
-- Journal written before broadcast so an earlier attempt can be proven dead before any resend.
ALTER TABLE "GasFeeOrder" ADD COLUMN IF NOT EXISTS "deliveryNonce" INTEGER;
ALTER TABLE "GasFeeOrder" ADD COLUMN IF NOT EXISTS "deliveryAttemptAt" TIMESTAMP(3);
