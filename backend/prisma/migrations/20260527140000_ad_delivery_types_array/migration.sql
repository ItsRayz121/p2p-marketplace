-- Replace single tokenDeliveryType with array tokenDeliveryTypes
ALTER TABLE "Ad" DROP COLUMN IF EXISTS "tokenDeliveryType";
ALTER TABLE "Ad" ADD COLUMN IF NOT EXISTS "tokenDeliveryTypes" TEXT[] NOT NULL DEFAULT '{}';
