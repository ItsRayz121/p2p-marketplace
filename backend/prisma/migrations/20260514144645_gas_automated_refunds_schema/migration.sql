-- AlterEnum
ALTER TYPE "GasFeeOrderStatus" ADD VALUE 'refund_pending';

-- AlterTable
ALTER TABLE "GasFeeOrder" ADD COLUMN     "paymentSenderAddress" TEXT,
ADD COLUMN     "refundAmount" DECIMAL(10,4),
ADD COLUMN     "refundTxHash" TEXT;
