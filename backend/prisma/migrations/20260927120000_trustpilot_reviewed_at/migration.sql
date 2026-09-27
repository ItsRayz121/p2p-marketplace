-- Tracks a self-reported Trustpilot review so the review-nudge (bell +
-- "RupChain Official" support-thread message) never shows again once set.
ALTER TABLE "User" ADD COLUMN "trustpilotReviewedAt" TIMESTAMP(3);
