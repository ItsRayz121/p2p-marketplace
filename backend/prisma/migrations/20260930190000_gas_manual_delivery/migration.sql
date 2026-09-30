-- Manual gas delivery: an admin sends gas from an external wallet and records the tx
-- hash. deliveryMode distinguishes it from automated hot-wallet delivery (NULL).
ALTER TABLE "GasFeeOrder" ADD COLUMN "deliveryMode" TEXT;
ALTER TABLE "GasFeeOrder" ADD COLUMN "deliveredByAdminId" TEXT;
ALTER TABLE "GasFeeOrder" ADD COLUMN "deliveryNote" VARCHAR(500);
