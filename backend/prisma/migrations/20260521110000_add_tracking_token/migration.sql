-- Add trackingToken column for guest order privacy
ALTER TABLE "GasFeeOrder" ADD COLUMN "trackingToken" TEXT;

-- Unique constraint (allows multiple NULLs in PostgreSQL)
CREATE UNIQUE INDEX "GasFeeOrder_trackingToken_key" ON "GasFeeOrder"("trackingToken");
