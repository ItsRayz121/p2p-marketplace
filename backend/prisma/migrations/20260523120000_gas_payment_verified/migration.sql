-- AlterEnum: add payment_verified between payment_uploaded and payment_detected
ALTER TYPE "GasFeeOrderStatus" ADD VALUE IF NOT EXISTS 'payment_verified' AFTER 'payment_uploaded';

-- AlterTable GasFeeOrder: add verification metadata fields
ALTER TABLE "GasFeeOrder"
  ADD COLUMN IF NOT EXISTS "paymentVerifiedAt"    TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "verifiedAmount"        DECIMAL(10,4),
  ADD COLUMN IF NOT EXISTS "verifiedAsset"         TEXT,
  ADD COLUMN IF NOT EXISTS "verifiedConfirmations" INTEGER;

-- AlterTable GasLedgerEntry: add ERC20 token tracking fields
ALTER TABLE "GasLedgerEntry"
  ADD COLUMN IF NOT EXISTS "tokenSymbol" TEXT,
  ADD COLUMN IF NOT EXISTS "tokenAmount" DECIMAL(28,10);
