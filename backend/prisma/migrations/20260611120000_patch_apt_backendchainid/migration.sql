-- Ensure the Aptos GasChainConfig row has backendChainId = 'APT' so it appears
-- in the wallet activity chain filter dropdown (which reads backendChainId).
-- This is idempotent: no-op if already set correctly.
UPDATE "GasChainConfig"
SET "backendChainId" = 'APT'
WHERE "slug" = 'APT'
  AND ("backendChainId" IS NULL OR "backendChainId" != 'APT');
