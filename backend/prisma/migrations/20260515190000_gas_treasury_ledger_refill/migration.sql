-- CreateEnum
CREATE TYPE "GasLedgerEntryType" AS ENUM ('order_payment', 'gas_delivery', 'delivery_refund', 'refill_hot_from_treasury', 'drain_hot_to_treasury', 'platform_fee');

-- CreateEnum
CREATE TYPE "GasRefillRequestStatus" AS ENUM ('pending_approval', 'approved', 'executing', 'completed', 'failed', 'cancelled');

-- CreateTable
CREATE TABLE "GasTreasuryWallet" (
    "id" TEXT NOT NULL,
    "chain" "GasChain" NOT NULL,
    "chainFamily" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "derivationIndex" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastBalanceRefreshAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GasTreasuryWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GasLedgerEntry" (
    "id" TEXT NOT NULL,
    "entryType" "GasLedgerEntryType" NOT NULL,
    "chain" "GasChain" NOT NULL,
    "nativeAmount" DECIMAL(28,10) NOT NULL,
    "nativeSymbol" TEXT NOT NULL,
    "usdAmount" DECIMAL(18,6) NOT NULL,
    "txHash" TEXT,
    "fromAddress" TEXT,
    "toAddress" TEXT,
    "relatedOrderId" TEXT,
    "relatedRefillId" TEXT,
    "notes" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GasLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GasRefillThreshold" (
    "id" TEXT NOT NULL,
    "chain" "GasChain" NOT NULL,
    "triggerBelowNative" DECIMAL(18,8) NOT NULL,
    "refillTargetNative" DECIMAL(18,8) NOT NULL,
    "maxRefillNative" DECIMAL(18,8) NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GasRefillThreshold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GasRefillRequest" (
    "id" TEXT NOT NULL,
    "chain" "GasChain" NOT NULL,
    "fromWalletId" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "toAddress" TEXT NOT NULL,
    "nativeAmount" DECIMAL(18,8) NOT NULL,
    "nativeSymbol" TEXT NOT NULL,
    "usdAmount" DECIMAL(18,6) NOT NULL,
    "status" "GasRefillRequestStatus" NOT NULL DEFAULT 'pending_approval',
    "triggerBalance" DECIMAL(18,8),
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledBy" TEXT,
    "executedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "txHash" TEXT,
    "failureReason" VARCHAR(500),
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GasRefillRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GasTreasuryWallet_chain_key" ON "GasTreasuryWallet"("chain");

-- CreateIndex
CREATE UNIQUE INDEX "GasTreasuryWallet_address_key" ON "GasTreasuryWallet"("address");

-- CreateIndex
CREATE INDEX "GasTreasuryWallet_chainFamily_isActive_idx" ON "GasTreasuryWallet"("chainFamily", "isActive");

-- CreateIndex
CREATE INDEX "GasLedgerEntry_chain_entryType_idx" ON "GasLedgerEntry"("chain", "entryType");

-- CreateIndex
CREATE INDEX "GasLedgerEntry_relatedOrderId_idx" ON "GasLedgerEntry"("relatedOrderId");

-- CreateIndex
CREATE INDEX "GasLedgerEntry_relatedRefillId_idx" ON "GasLedgerEntry"("relatedRefillId");

-- CreateIndex
CREATE INDEX "GasLedgerEntry_createdAt_idx" ON "GasLedgerEntry"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "GasRefillThreshold_chain_key" ON "GasRefillThreshold"("chain");

-- CreateIndex
CREATE INDEX "GasRefillThreshold_isEnabled_idx" ON "GasRefillThreshold"("isEnabled");

-- CreateIndex
CREATE INDEX "GasRefillRequest_chain_status_idx" ON "GasRefillRequest"("chain", "status");

-- CreateIndex
CREATE INDEX "GasRefillRequest_status_idx" ON "GasRefillRequest"("status");

-- CreateIndex
CREATE INDEX "GasRefillRequest_createdAt_idx" ON "GasRefillRequest"("createdAt");

-- AddForeignKey
ALTER TABLE "GasLedgerEntry" ADD CONSTRAINT "GasLedgerEntry_relatedOrderId_fkey" FOREIGN KEY ("relatedOrderId") REFERENCES "GasFeeOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GasLedgerEntry" ADD CONSTRAINT "GasLedgerEntry_relatedRefillId_fkey" FOREIGN KEY ("relatedRefillId") REFERENCES "GasRefillRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GasRefillRequest" ADD CONSTRAINT "GasRefillRequest_fromWalletId_fkey" FOREIGN KEY ("fromWalletId") REFERENCES "GasTreasuryWallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
