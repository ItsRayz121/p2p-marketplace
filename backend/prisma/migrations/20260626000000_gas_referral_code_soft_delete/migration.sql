-- Soft-delete for self-service custom referral links.
-- A deleted custom link keeps attributing past + future signups to its OWNER (old
-- shared links never break), but is excluded from the owner's active-link cap and
-- no longer carries a buyer discount. Existing bindings to it keep earning commission.
ALTER TABLE "GasReferralCode" ADD COLUMN "deletedAt" TIMESTAMP(3);
