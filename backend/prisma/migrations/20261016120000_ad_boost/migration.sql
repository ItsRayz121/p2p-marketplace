-- Points-purchased listing boost: boosted ads sort above the rest until this time.
ALTER TABLE "Ad" ADD COLUMN "boostedUntil" TIMESTAMP(3);
CREATE INDEX "Ad_status_boostedUntil_idx" ON "Ad"("status", "boostedUntil");
