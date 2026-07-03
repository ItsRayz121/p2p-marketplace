-- Newsletter subscriber geo capture (best-effort, forward-looking).
ALTER TABLE "NewsletterSubscriber" ADD COLUMN "country" TEXT;
ALTER TABLE "NewsletterSubscriber" ADD COLUMN "ipAddress" TEXT;
