-- Trading hold (scam/dispute control) + trusted accounts. Additive only.
ALTER TABLE "User" ADD COLUMN "tradingHold" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "tradingHoldReason" VARCHAR(1000);
ALTER TABLE "User" ADD COLUMN "tradingHoldSince" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "tradingHoldBy" TEXT;
ALTER TABLE "User" ADD COLUMN "isTrusted" BOOLEAN NOT NULL DEFAULT false;

