-- Add tokenDeliveryType and settlementMethod to Ad model
ALTER TABLE "Ad" ADD COLUMN IF NOT EXISTS "tokenDeliveryType" VARCHAR(20);
ALTER TABLE "Ad" ADD COLUMN IF NOT EXISTS "settlementMethod" VARCHAR(500);
