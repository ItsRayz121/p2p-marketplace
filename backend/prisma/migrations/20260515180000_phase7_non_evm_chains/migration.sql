-- Phase 7: Non-EVM chain architecture (Solana, TON, SUI)

-- Add SUI to the GasChain enum
ALTER TYPE "GasChain" ADD VALUE IF NOT EXISTS 'SUI';

-- Add feature readiness state to GasChainConfig
-- Values: inactive | testing | beta | stable
-- Default 'inactive' ensures new/existing rows stay hidden until explicitly promoted.
ALTER TABLE "GasChainConfig" ADD COLUMN IF NOT EXISTS "readinessState" TEXT NOT NULL DEFAULT 'inactive';

-- Back-fill: promote chains that are already operational to appropriate states.
-- TRON, BSC, ETH are production-proven → stable
UPDATE "GasChainConfig" SET "readinessState" = 'stable'
  WHERE slug IN ('TRON', 'BSC', 'ETH');

-- BASE, ARB, OP, MATIC, AVAX have working delivery → beta
UPDATE "GasChainConfig" SET "readinessState" = 'beta'
  WHERE slug IN ('BASE', 'ARB', 'OP', 'MATIC', 'AVAX');

-- SOL, TON, SUI remain inactive (default) until delivery is fully implemented.
