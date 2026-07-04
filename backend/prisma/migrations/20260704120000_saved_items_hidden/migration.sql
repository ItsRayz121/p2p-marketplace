-- Reversible per-user hide flag for saved payment methods and delivery addresses.
-- Distinct from PaymentMethod.isActive (which is a hard remove / soft-delete).
ALTER TABLE "PaymentMethod" ADD COLUMN "hidden" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SavedAddress" ADD COLUMN "hidden" BOOLEAN NOT NULL DEFAULT false;
