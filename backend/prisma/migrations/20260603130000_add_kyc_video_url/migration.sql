-- Enhanced KYC (Level 2): short video verification upload
ALTER TABLE "KycSubmission" ADD COLUMN "videoUrl" TEXT;
