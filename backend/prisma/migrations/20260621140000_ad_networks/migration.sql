-- Multi-network ads: a wallet-delivery ad can offer more than one on-chain
-- network (e.g. BEP20 + Aptos). Additive only — one array column with a default.
-- `network` is retained as the primary/first network for back-compat.
ALTER TABLE "Ad" ADD COLUMN "networks" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Backfill existing ads so their full network set mirrors their single network.
UPDATE "Ad" SET "networks" = ARRAY["network"] WHERE array_length("networks", 1) IS NULL;
