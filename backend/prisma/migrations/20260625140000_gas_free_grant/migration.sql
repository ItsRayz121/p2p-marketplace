-- Phase 3 of the Gas-Payment promo/referral system: admin-issued free-gas
-- deliveries. A free order has paymentAmount = 0 and the platform funds the full
-- cost (base + margin); it is created already in payment_detected so it routes
-- through the normal delivery worker. Additive, default false -> no existing order
-- changes, and the feature only runs when flag gas_free_grant_enabled is ON.
ALTER TABLE "GasFeeOrder" ADD COLUMN "isFreeGrant" BOOLEAN NOT NULL DEFAULT false;
