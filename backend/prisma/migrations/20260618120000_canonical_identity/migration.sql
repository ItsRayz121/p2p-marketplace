-- Phase 1: canonical identity (non-custodial P2P)
-- Additive + nullable only — safe, no backfill, no behavior change until the
-- noncustodial_p2p_enabled flag is turned on.

-- Legal name as printed on the CNIC, captured at submission for reviewer comparison.
ALTER TABLE "KycSubmission" ADD COLUMN "legalName" TEXT;

-- Marks that the user's fullName has been locked to their CNIC legal name on KYC approval.
ALTER TABLE "User" ADD COLUMN "legalNameLockedAt" TIMESTAMP(3);
