-- Add isVisibleToUsers to GasChainConfig and GasTokenConfig
-- Allows admin to hide chains/tokens from users without deleting them.
-- Default true so all existing records remain visible.

ALTER TABLE "GasChainConfig" ADD COLUMN IF NOT EXISTS "isVisibleToUsers" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "GasTokenConfig" ADD COLUMN IF NOT EXISTS "isVisibleToUsers" BOOLEAN NOT NULL DEFAULT true;
