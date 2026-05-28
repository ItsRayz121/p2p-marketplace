-- Add platform_fee_sweep to GasLedgerEntryType enum
ALTER TYPE "GasLedgerEntryType" ADD VALUE IF NOT EXISTS 'platform_fee_sweep';
