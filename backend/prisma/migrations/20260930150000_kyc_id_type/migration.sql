-- KYC accepts a national ID (front + back) or a passport (data page only).
ALTER TABLE "KycSubmission" ADD COLUMN "idType" TEXT NOT NULL DEFAULT 'national_id';
ALTER TABLE "KycSubmission" ALTER COLUMN "backUrl" DROP NOT NULL;
