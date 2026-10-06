-- Active hours: one availability window per user (trade creator / affiliate).
ALTER TABLE "User" ADD COLUMN "activeHoursEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "activeHoursStart" INTEGER;
ALTER TABLE "User" ADD COLUMN "activeHoursEnd" INTEGER;
ALTER TABLE "User" ADD COLUMN "activeHoursTz" TEXT;

-- Two-level affiliate commission: one accrual per (order, level).
ALTER TABLE "GasReferralAccrual" ADD COLUMN "level" INTEGER NOT NULL DEFAULT 1;
DROP INDEX IF EXISTS "GasReferralAccrual_orderId_key";
CREATE UNIQUE INDEX "GasReferralAccrual_orderId_level_key" ON "GasReferralAccrual"("orderId", "level");
