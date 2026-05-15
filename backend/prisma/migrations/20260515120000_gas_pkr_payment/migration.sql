-- Add payment_uploaded status to GasFeeOrderStatus enum
ALTER TYPE "GasFeeOrderStatus" ADD VALUE IF NOT EXISTS 'payment_uploaded';

-- Add PKR payment fields to GasFeeOrder
ALTER TABLE "GasFeeOrder"
  ADD COLUMN IF NOT EXISTS "paymentProofUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "pkrPaymentMethod" TEXT,
  ADD COLUMN IF NOT EXISTS "pkrAmount" DECIMAL(12,2);
