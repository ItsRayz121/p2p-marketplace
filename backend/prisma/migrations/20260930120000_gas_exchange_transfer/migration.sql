-- "Exchange transfer" gas payment: customers send USDT between exchange accounts
-- (internal transfer) and submit their UID + transfer order id for manual review.
ALTER TABLE "GasFeeOrder" ADD COLUMN "exchangeName" TEXT;
ALTER TABLE "GasFeeOrder" ADD COLUMN "exchangeAccountUid" TEXT;
ALTER TABLE "GasFeeOrder" ADD COLUMN "exchangeUserUid" TEXT;
ALTER TABLE "GasFeeOrder" ADD COLUMN "exchangeOrderId" TEXT;
CREATE UNIQUE INDEX "GasFeeOrder_exchangeOrderId_key" ON "GasFeeOrder"("exchangeOrderId");

CREATE TABLE "GasExchangeAccount" (
    "id" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "accountUid" TEXT NOT NULL,
    "note" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GasExchangeAccount_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "GasExchangeAccount_isActive_sortOrder_idx" ON "GasExchangeAccount"("isActive", "sortOrder");
