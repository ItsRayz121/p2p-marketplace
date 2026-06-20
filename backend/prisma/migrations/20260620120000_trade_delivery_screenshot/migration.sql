-- Optional crypto-transfer screenshot for USDT marketplace trades (CTM-style
-- dual proof). Additive, nullable column — safe to deploy; existing trades are
-- unaffected. Manual / exchange-UID deliveries can now use a screenshot as the
-- transfer proof instead of (or alongside) an on-chain tx hash.
ALTER TABLE "Trade" ADD COLUMN IF NOT EXISTS "sellerDeliveryProofUrl" TEXT;
