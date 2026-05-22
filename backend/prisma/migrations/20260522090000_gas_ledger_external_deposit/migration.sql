-- Add external_hot_wallet_deposit to GasLedgerEntryType enum
ALTER TYPE "GasLedgerEntryType" ADD VALUE IF NOT EXISTS 'external_hot_wallet_deposit';
