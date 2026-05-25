-- Add token-quantity order limits; PKR-denominated limits are deprecated but
-- kept nullable for back-compat with any legacy listings.
ALTER TABLE "CtmListing"
  ADD COLUMN "minOrderTokens" DECIMAL(28, 8),
  ADD COLUMN "maxOrderTokens" DECIMAL(28, 8);

-- Backfill from existing PKR limits using pricePerUnit.
UPDATE "CtmListing"
   SET "minOrderTokens" = CASE WHEN "pricePerUnit" > 0 THEN "minOrderPkr" / "pricePerUnit" ELSE 0 END,
       "maxOrderTokens" = CASE WHEN "pricePerUnit" > 0 THEN "maxOrderPkr" / "pricePerUnit" ELSE 0 END
 WHERE "minOrderTokens" IS NULL;

-- Make the new columns NOT NULL once backfilled.
ALTER TABLE "CtmListing"
  ALTER COLUMN "minOrderTokens" SET NOT NULL,
  ALTER COLUMN "maxOrderTokens" SET NOT NULL;

-- PKR limits are now derived (price * tokens); drop NOT NULL constraint.
ALTER TABLE "CtmListing"
  ALTER COLUMN "minOrderPkr" DROP NOT NULL,
  ALTER COLUMN "maxOrderPkr" DROP NOT NULL;
