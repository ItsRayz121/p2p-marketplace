-- Per-token "delivery live" gate for non-native token delivery (USDT/USDC).
-- Default false: a token becomes orderable only after a super-admin funds the hot
-- wallet and explicitly flips it live (and the chain family has a delivery impl).
ALTER TABLE "GasTokenConfig" ADD COLUMN "deliveryLive" BOOLEAN NOT NULL DEFAULT false;
