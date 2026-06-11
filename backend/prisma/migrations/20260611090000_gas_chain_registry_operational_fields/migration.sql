-- Add operational chain-registry fields to GasChainConfig and GasTokenConfig.
-- These fields make the gas system fully expandable from the admin panel:
-- new chains can be configured without any code changes.

-- ── GasChainConfig: operational fields ────────────────────────────────────────

-- Chain protocol type — drives dispatch in fee calculator, balance monitor, poller.
ALTER TABLE "GasChainConfig" ADD COLUMN "chainType" TEXT NOT NULL DEFAULT 'EVM';

-- RPC endpoints for balance fetching and fee estimation.
ALTER TABLE "GasChainConfig" ADD COLUMN "rpcUrl" TEXT;
ALTER TABLE "GasChainConfig" ADD COLUMN "rpcUrlFallback" TEXT;

-- Fee estimation method and fixed fallback.
ALTER TABLE "GasChainConfig" ADD COLUMN "feeMethod" TEXT NOT NULL DEFAULT 'EVM_RPC';
ALTER TABLE "GasChainConfig" ADD COLUMN "fixedFeeUsd" DECIMAL(10,6);

-- CoinGecko coin ID for the native token price feed.
ALTER TABLE "GasChainConfig" ADD COLUMN "coingeckoId" TEXT;

-- Payment reception capability.
ALTER TABLE "GasChainConfig" ADD COLUMN "isPaymentEnabled" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "GasChainConfig" ADD COLUMN "depositAddressOverride" TEXT;
ALTER TABLE "GasChainConfig" ADD COLUMN "usdtContractAddress" TEXT;
ALTER TABLE "GasChainConfig" ADD COLUMN "usdtDecimals" INTEGER NOT NULL DEFAULT 6;

-- ── GasTokenConfig: per-token CoinGecko override ──────────────────────────────
ALTER TABLE "GasTokenConfig" ADD COLUMN "coingeckoId" TEXT;

-- ── Seed existing chains with their operational config ─────────────────────────

-- TRON (TRC20)
UPDATE "GasChainConfig" SET
  "chainType"           = 'TRON',
  "feeMethod"           = 'TRON_API',
  "coingeckoId"         = 'tron',
  "isPaymentEnabled"    = TRUE,
  "usdtContractAddress" = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  "usdtDecimals"        = 6
WHERE "slug" = 'TRON';

-- BSC (BEP20)
UPDATE "GasChainConfig" SET
  "chainType"           = 'EVM',
  "feeMethod"           = 'EVM_RPC',
  "coingeckoId"         = 'binancecoin',
  "isPaymentEnabled"    = TRUE,
  "usdtContractAddress" = '0x55d398326f99059fF775485246999027B3197955',
  "usdtDecimals"        = 18
WHERE "slug" = 'BSC';

-- Ethereum (ERC20)
UPDATE "GasChainConfig" SET
  "chainType"           = 'EVM',
  "feeMethod"           = 'EVM_RPC',
  "coingeckoId"         = 'ethereum',
  "isPaymentEnabled"    = TRUE,
  "usdtContractAddress" = '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  "usdtDecimals"        = 6
WHERE "slug" = 'ETH';

-- Arbitrum
UPDATE "GasChainConfig" SET
  "chainType"     = 'EVM',
  "feeMethod"     = 'EVM_RPC',
  "coingeckoId"   = 'ethereum'
WHERE "slug" = 'ARB';

-- Optimism
UPDATE "GasChainConfig" SET
  "chainType"     = 'EVM',
  "feeMethod"     = 'EVM_RPC',
  "coingeckoId"   = 'ethereum'
WHERE "slug" = 'OP';

-- Base
UPDATE "GasChainConfig" SET
  "chainType"     = 'EVM',
  "feeMethod"     = 'EVM_RPC',
  "coingeckoId"   = 'ethereum'
WHERE "slug" = 'BASE';

-- Polygon (MATIC / POL)
UPDATE "GasChainConfig" SET
  "chainType"     = 'EVM',
  "feeMethod"     = 'EVM_RPC',
  "coingeckoId"   = 'matic-network'
WHERE "slug" IN ('MATIC', 'POL');

-- Avalanche
UPDATE "GasChainConfig" SET
  "chainType"     = 'EVM',
  "feeMethod"     = 'EVM_RPC',
  "coingeckoId"   = 'avalanche-2'
WHERE "slug" = 'AVAX';

-- Solana
UPDATE "GasChainConfig" SET
  "chainType"     = 'SOLANA',
  "feeMethod"     = 'SOLANA_API',
  "coingeckoId"   = 'solana'
WHERE "slug" = 'SOL';

-- TON
UPDATE "GasChainConfig" SET
  "chainType"     = 'TON',
  "feeMethod"     = 'TON_API',
  "coingeckoId"   = 'the-open-network'
WHERE "slug" = 'TON';

-- SUI
UPDATE "GasChainConfig" SET
  "chainType"     = 'SUI',
  "feeMethod"     = 'CUSTOM',
  "coingeckoId"   = 'sui'
WHERE "slug" = 'SUI';

-- Aptos (APT) — insert if not already present
INSERT INTO "GasChainConfig" (
  "id", "name", "slug", "symbol", "logoUrl", "category", "networkLabel",
  "addressType", "explorerBase", "backendChainId",
  "platformFeeUsdt", "isActive", "isVisibleToUsers", "readinessState", "displayOrder",
  "chainType", "feeMethod", "coingeckoId",
  "isPaymentEnabled", "usdtContractAddress", "usdtDecimals",
  "createdAt", "updatedAt"
) VALUES (
  gen_random_uuid()::text,
  'Aptos', 'APT', 'APT',
  'https://s2.coinmarketcap.com/static/img/coins/64x64/21794.png',
  'aptos', 'Aptos', 'APTOS',
  'https://explorer.aptoslabs.com/account/', 'APT',
  0.10, TRUE, TRUE, 'stable', 99,
  'APTOS', 'APTOS_API', 'aptos',
  TRUE, '0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b', 6,
  NOW(), NOW()
) ON CONFLICT ("slug") DO UPDATE SET
  "chainType"           = 'APTOS',
  "feeMethod"           = 'APTOS_API',
  "coingeckoId"         = 'aptos',
  "isPaymentEnabled"    = TRUE,
  "usdtContractAddress" = '0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b',
  "usdtDecimals"        = 6,
  "readinessState"      = COALESCE("GasChainConfig"."readinessState", 'stable');
