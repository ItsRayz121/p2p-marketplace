-- Add a ledger entry type for withdrawing platform-owned funds from the hot
-- wallet to an external wallet (real payout, distinct from the internal
-- platform_fee_sweep which historically targeted the derived treasury address).
ALTER TYPE "GasLedgerEntryType" ADD VALUE IF NOT EXISTS 'platform_revenue_withdrawal';
