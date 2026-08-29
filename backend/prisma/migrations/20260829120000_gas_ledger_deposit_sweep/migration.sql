-- New ledger entry type for the Aptos (and future) deposit → hot-wallet sweep.
-- When per-user deposit addresses hold the actual on-chain USDT (Aptos credits
-- the internal balance but leaves the token on the per-user address), the sweep
-- moves that USDT into the shared hot wallet so withdrawals can be paid from one
-- funded place. Each sweep writes a `deposit_sweep` entry (USDT token inflow,
-- no native movement) — distinct from `order_payment` so gas-revenue rollups are
-- not polluted by liability-backing transfers.
ALTER TYPE "GasLedgerEntryType" ADD VALUE IF NOT EXISTS 'deposit_sweep';
