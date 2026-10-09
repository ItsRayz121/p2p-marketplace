-- Optional one-to-one restriction: only this user may redeem the promo code.
ALTER TABLE "GasPromoCode" ADD COLUMN "allowedUserId" TEXT;
