-- Opt-in flag for exposing a saved delivery address on the public payment page.
ALTER TABLE "SavedAddress" ADD COLUMN "shared" BOOLEAN NOT NULL DEFAULT false;
