-- Phase 5 of the Gas-Payment promo/referral system: self-service AFFILIATES.
-- Extends gas referrals: a user applies (GasAffiliate), an admin approves + sets margin
-- caps, and the user's referral codes gain a per-link buyer discount split. Buyer auto-
-- discount + affiliate commission are both margin-only. Inert unless gas_affiliate_enabled.

-- AlterTable: per-link affiliate split fields on the existing referral code table.
ALTER TABLE "GasReferralCode" ADD COLUMN "userDiscountPct" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "GasReferralCode" ADD COLUMN "label" TEXT;

-- CreateTable: affiliate profile (one per user).
CREATE TABLE "GasAffiliate" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "socials" JSONB,
    "applicantNote" TEXT,
    "rejectionReason" TEXT,
    "maxMarginPct" DOUBLE PRECISION NOT NULL DEFAULT 20,
    "minUserDiscountPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "maxLinks" INTEGER NOT NULL DEFAULT 2,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GasAffiliate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GasAffiliate_userId_key" ON "GasAffiliate"("userId");
CREATE INDEX "GasAffiliate_status_idx" ON "GasAffiliate"("status");

-- AddForeignKey
ALTER TABLE "GasAffiliate" ADD CONSTRAINT "GasAffiliate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
