-- Add chain-level defaults for token inheritance
ALTER TABLE "GasChainConfig" ADD COLUMN "defaultMinAmount" DECIMAL(18,8);
ALTER TABLE "GasChainConfig" ADD COLUMN "defaultMaxUsdValue" DECIMAL(10,4);

-- Add nullable platform fee override on token (null = inherit from chain)
ALTER TABLE "GasTokenConfig" ADD COLUMN "platformFeeUsdt" DOUBLE PRECISION;

-- Make minAmount and maxUsdValue nullable on token (null = inherit from chain default)
-- Existing rows keep their current non-null values; only future tokens can omit them.
ALTER TABLE "GasTokenConfig" ALTER COLUMN "minAmount" DROP NOT NULL;
ALTER TABLE "GasTokenConfig" ALTER COLUMN "minAmount" DROP DEFAULT;
ALTER TABLE "GasTokenConfig" ALTER COLUMN "maxUsdValue" DROP NOT NULL;
ALTER TABLE "GasTokenConfig" ALTER COLUMN "maxUsdValue" DROP DEFAULT;
