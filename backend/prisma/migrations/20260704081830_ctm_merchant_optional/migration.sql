-- Self-service CTM makers: decouple CtmMerchantProfile from the legacy Merchant
-- funnel so any KYC-approved user can be auto-provisioned an active profile when
-- they create their first CTM listing. Existing rows keep their merchantId.
-- (Unique index is preserved; Postgres permits multiple NULLs under UNIQUE.)
ALTER TABLE "CtmMerchantProfile" ALTER COLUMN "merchantId" DROP NOT NULL;
