-- Multi-method receiving for BUY ads: a maker can offer one receiving destination
-- per network/exchange (each {method, network, address}). settlementMethod stays as
-- the primary destination's address for back-compat.
ALTER TABLE "Ad" ADD COLUMN "settlementDestinations" JSONB;
