-- AlterTable: add USD threshold columns (nullable — populated below per chain)
ALTER TABLE "GasChainConfig"
  ADD COLUMN "alertThresholdUsd" DOUBLE PRECISION,
  ADD COLUMN "pauseThresholdUsd" DOUBLE PRECISION;

-- Populate sensible defaults for known chains
UPDATE "GasChainConfig" SET "alertThresholdUsd" = 20,  "pauseThresholdUsd" = 5   WHERE slug = 'TRON';
UPDATE "GasChainConfig" SET "alertThresholdUsd" = 50,  "pauseThresholdUsd" = 10  WHERE slug = 'BSC';
UPDATE "GasChainConfig" SET "alertThresholdUsd" = 100, "pauseThresholdUsd" = 25  WHERE slug IN ('ETH', 'BASE', 'ARB', 'OP');
UPDATE "GasChainConfig" SET "alertThresholdUsd" = 25,  "pauseThresholdUsd" = 5   WHERE slug = 'MATIC';
UPDATE "GasChainConfig" SET "alertThresholdUsd" = 40,  "pauseThresholdUsd" = 10  WHERE slug IN ('AVAX', 'SOL');
UPDATE "GasChainConfig" SET "alertThresholdUsd" = 20,  "pauseThresholdUsd" = 5   WHERE slug = 'SUI';
