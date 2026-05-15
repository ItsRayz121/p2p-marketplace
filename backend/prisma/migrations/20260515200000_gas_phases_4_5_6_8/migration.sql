-- Phase 4: Reconciliation engine
-- Phase 5: Risk/fraud flagging
-- Phase 6: Merchant settlement
-- Phase 8: Multi-hot-wallet support (hdIndex + weight on GasHotWallet)

-- Phase 8: GasHotWallet — drop old chain unique, add hdIndex + weight + compound unique
ALTER TABLE "GasHotWallet" DROP CONSTRAINT IF EXISTS "GasHotWallet_chain_key";
ALTER TABLE "GasHotWallet" ADD COLUMN IF NOT EXISTS "hdIndex" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "GasHotWallet" ADD COLUMN IF NOT EXISTS "weight"  INTEGER NOT NULL DEFAULT 100;
ALTER TABLE "GasHotWallet" ADD CONSTRAINT "GasHotWallet_chain_hdIndex_key" UNIQUE ("chain", "hdIndex");

-- Phase 5: riskScore on GasFeeOrder
ALTER TABLE "GasFeeOrder" ADD COLUMN IF NOT EXISTS "riskScore" INTEGER;

-- Phase 4: Reconciliation run
CREATE TABLE IF NOT EXISTS "GasReconciliationRun" (
    "id"               TEXT NOT NULL,
    "ranAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "chain"            "GasChain",
    "totalOrders"      INTEGER NOT NULL DEFAULT 0,
    "ordersChecked"    INTEGER NOT NULL DEFAULT 0,
    "discrepancyCount" INTEGER NOT NULL DEFAULT 0,
    "status"           TEXT NOT NULL,
    "notes"            VARCHAR(1000),
    CONSTRAINT "GasReconciliationRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "GasReconciliationRun_status_idx" ON "GasReconciliationRun"("status");
CREATE INDEX IF NOT EXISTS "GasReconciliationRun_ranAt_idx"  ON "GasReconciliationRun"("ranAt");

-- Phase 4: Reconciliation discrepancies
CREATE TABLE IF NOT EXISTS "GasReconciliationDiscrepancy" (
    "id"          TEXT NOT NULL,
    "runId"       TEXT NOT NULL,
    "orderId"     TEXT,
    "type"        TEXT NOT NULL,
    "description" VARCHAR(1000) NOT NULL,
    "resolvedAt"  TIMESTAMP(3),
    "resolvedBy"  TEXT,
    "adminNote"   VARCHAR(500),
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GasReconciliationDiscrepancy_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "GasReconciliationDiscrepancy_runId_idx"   ON "GasReconciliationDiscrepancy"("runId");
CREATE INDEX IF NOT EXISTS "GasReconciliationDiscrepancy_orderId_idx" ON "GasReconciliationDiscrepancy"("orderId");
CREATE INDEX IF NOT EXISTS "GasReconciliationDiscrepancy_type_idx"    ON "GasReconciliationDiscrepancy"("type");

ALTER TABLE "GasReconciliationDiscrepancy"
    ADD CONSTRAINT "GasReconciliationDiscrepancy_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "GasReconciliationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Phase 5: Flagged orders
CREATE TABLE IF NOT EXISTS "GasFlaggedOrder" (
    "id"         TEXT NOT NULL,
    "orderId"    TEXT NOT NULL,
    "reasons"    TEXT NOT NULL,
    "riskScore"  INTEGER NOT NULL,
    "status"     TEXT NOT NULL DEFAULT 'pending_review',
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "adminNote"  VARCHAR(500),
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GasFlaggedOrder_pkey"    PRIMARY KEY ("id"),
    CONSTRAINT "GasFlaggedOrder_orderId_key" UNIQUE ("orderId")
);

CREATE INDEX IF NOT EXISTS "GasFlaggedOrder_status_idx"    ON "GasFlaggedOrder"("status");
CREATE INDEX IF NOT EXISTS "GasFlaggedOrder_riskScore_idx" ON "GasFlaggedOrder"("riskScore");
CREATE INDEX IF NOT EXISTS "GasFlaggedOrder_createdAt_idx" ON "GasFlaggedOrder"("createdAt");

ALTER TABLE "GasFlaggedOrder"
    ADD CONSTRAINT "GasFlaggedOrder_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "GasFeeOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Phase 6: Merchant settlement account
CREATE TABLE IF NOT EXISTS "GasMerchantAccount" (
    "id"              TEXT NOT NULL,
    "name"            TEXT NOT NULL,
    "apiKeyId"        TEXT NOT NULL,
    "commissionRate"  DECIMAL(5,4) NOT NULL DEFAULT 0,
    "settlementCycle" TEXT NOT NULL DEFAULT 'weekly',
    "payoutAddress"   TEXT,
    "isActive"        BOOLEAN NOT NULL DEFAULT true,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GasMerchantAccount_pkey"         PRIMARY KEY ("id"),
    CONSTRAINT "GasMerchantAccount_apiKeyId_key" UNIQUE ("apiKeyId")
);

CREATE INDEX IF NOT EXISTS "GasMerchantAccount_isActive_idx" ON "GasMerchantAccount"("isActive");

ALTER TABLE "GasMerchantAccount"
    ADD CONSTRAINT "GasMerchantAccount_apiKeyId_fkey"
    FOREIGN KEY ("apiKeyId") REFERENCES "MerchantApiKey"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Phase 6: Merchant settlements
CREATE TABLE IF NOT EXISTS "GasMerchantSettlement" (
    "id"               TEXT NOT NULL,
    "merchantId"       TEXT NOT NULL,
    "periodStart"      TIMESTAMP(3) NOT NULL,
    "periodEnd"        TIMESTAMP(3) NOT NULL,
    "orderCount"       INTEGER NOT NULL DEFAULT 0,
    "grossRevenueUsd"  DECIMAL(18,6) NOT NULL,
    "platformFeeUsd"   DECIMAL(18,6) NOT NULL,
    "merchantShareUsd" DECIMAL(18,6) NOT NULL,
    "status"           TEXT NOT NULL DEFAULT 'pending',
    "payoutTxHash"     TEXT,
    "paidAt"           TIMESTAMP(3),
    "adminNote"        VARCHAR(500),
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GasMerchantSettlement_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "GasMerchantSettlement_merchantId_status_idx"    ON "GasMerchantSettlement"("merchantId", "status");
CREATE INDEX IF NOT EXISTS "GasMerchantSettlement_status_idx"               ON "GasMerchantSettlement"("status");
CREATE INDEX IF NOT EXISTS "GasMerchantSettlement_periodStart_periodEnd_idx" ON "GasMerchantSettlement"("periodStart", "periodEnd");

ALTER TABLE "GasMerchantSettlement"
    ADD CONSTRAINT "GasMerchantSettlement_merchantId_fkey"
    FOREIGN KEY ("merchantId") REFERENCES "GasMerchantAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
