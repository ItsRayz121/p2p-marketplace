-- Lets a maker archive a terminal (cancelled/completed/expired) Ad or CtmListing
-- so it drops out of the default "My Ads" list without being deleted.
ALTER TABLE "Ad" ADD COLUMN "archived" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Ad" ADD COLUMN "archivedAt" TIMESTAMP(3);

ALTER TABLE "CtmListing" ADD COLUMN "archived" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CtmListing" ADD COLUMN "archivedAt" TIMESTAMP(3);
