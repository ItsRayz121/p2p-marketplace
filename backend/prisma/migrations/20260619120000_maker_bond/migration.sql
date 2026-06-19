-- Phase 5: maker collateral bond (non-custodial).
-- Additive only — a new table + two enum values. Safe to deploy; nothing
-- reads/writes it until the maker_bond_enabled flag is flipped ON.
-- NOTE: ALTER TYPE ... ADD VALUE is transaction-safe on PostgreSQL 12+ because
-- the new values are not USED within this migration's transaction.
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'bond_seized';
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'bond_received';

CREATE TABLE "BondHold" (
    "id" TEXT NOT NULL,
    "tradeType" TEXT NOT NULL,
    "tradeId" TEXT NOT NULL,
    "makerId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "amount" DECIMAL(18,8) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'held',
    "victimId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "BondHold_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BondHold_tradeType_tradeId_key" ON "BondHold"("tradeType", "tradeId");
CREATE INDEX "BondHold_makerId_idx" ON "BondHold"("makerId");
CREATE INDEX "BondHold_status_idx" ON "BondHold"("status");

ALTER TABLE "BondHold" ADD CONSTRAINT "BondHold_makerId_fkey"
    FOREIGN KEY ("makerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
