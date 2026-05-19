-- Replace percentage-based platform fee with a fixed USDT amount per chain
ALTER TABLE "GasChainConfig"
  ADD COLUMN IF NOT EXISTS "platformFeeUsdt" DOUBLE PRECISION NOT NULL DEFAULT 0.25;

-- Set sensible defaults per chain (admin can override via admin panel)
UPDATE "GasChainConfig" SET "platformFeeUsdt" = 0.05  WHERE slug = 'TRON';
UPDATE "GasChainConfig" SET "platformFeeUsdt" = 0.10  WHERE slug = 'BSC';
UPDATE "GasChainConfig" SET "platformFeeUsdt" = 0.25  WHERE slug IN ('ETH', 'BASE', 'ARB', 'OP');
UPDATE "GasChainConfig" SET "platformFeeUsdt" = 0.10  WHERE slug IN ('MATIC', 'AVAX');
UPDATE "GasChainConfig" SET "platformFeeUsdt" = 0.05  WHERE slug IN ('SOL', 'TON', 'SUI');

-- Drop the old percentage column
ALTER TABLE "GasChainConfig" DROP COLUMN IF EXISTS "platformFeePercent";
