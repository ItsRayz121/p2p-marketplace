-- Rework GasFreeCode to give a FIXED native gas amount per redemption (e.g.
-- 0.00001 BNB to each of the first 20 users) instead of waiving whatever amount
-- the user typed. minOrderUsd/maxOrderUsd no longer apply once the amount is
-- fixed by the admin. Table has no rows yet (feature just shipped, flag OFF).

-- AlterTable
ALTER TABLE "GasFreeCode" ADD COLUMN "amountNative" DECIMAL(18,8) NOT NULL DEFAULT 0;
ALTER TABLE "GasFreeCode" ALTER COLUMN "amountNative" DROP DEFAULT;
ALTER TABLE "GasFreeCode" DROP COLUMN "minOrderUsd";
ALTER TABLE "GasFreeCode" DROP COLUMN "maxOrderUsd";
