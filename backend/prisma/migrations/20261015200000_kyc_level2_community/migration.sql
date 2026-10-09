-- Level 2 (ad posting) answers collected with the KYC submission.
ALTER TABLE "KycSubmission" ADD COLUMN "whatsappNumber" TEXT;
ALTER TABLE "KycSubmission" ADD COLUMN "communityLinks" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "KycSubmission" ADD COLUMN "referenceUrl" TEXT;
