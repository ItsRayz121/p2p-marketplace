-- Community Token Market (CTM) Phase 1
-- Enums

CREATE TYPE "CtmSettlementType" AS ENUM ('MANUAL', 'ON_CHAIN', 'HYBRID');

CREATE TYPE "CtmTokenStatus" AS ENUM ('pending_review', 'approved', 'rejected', 'delisted', 'restricted');

CREATE TYPE "CtmTokenRiskTier" AS ENUM ('low', 'medium', 'high', 'extreme');

CREATE TYPE "CtmListingStatus" AS ENUM ('active', 'paused', 'completed', 'expired', 'cancelled');

CREATE TYPE "CtmRequestStatus" AS ENUM ('open', 'accepted', 'expired', 'cancelled');

CREATE TYPE "CtmTradeStatus" AS ENUM ('awaiting_payment', 'payment_uploaded', 'payment_confirmed', 'seller_transferring', 'proof_submitted', 'buyer_confirming', 'completed', 'cancelled', 'disputed', 'dispute_resolved', 'expired');

CREATE TYPE "CtmProofType" AS ENUM ('screenshot', 'txhash', 'uid_receipt', 'video', 'other');

CREATE TYPE "CtmDisputeReason" AS ENUM ('proof_fake', 'not_received', 'amount_mismatch', 'wrong_token', 'seller_unresponsive', 'buyer_unresponsive', 'other');

CREATE TYPE "CtmMerchantTier" AS ENUM ('new', 'basic', 'verified', 'elite');

-- CreateTable CtmToken
CREATE TABLE "CtmToken" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" VARCHAR(2000) NOT NULL,
    "logoUrl" TEXT,
    "bannerUrl" TEXT,
    "settlementType" "CtmSettlementType" NOT NULL,
    "network" TEXT,
    "contractAddress" TEXT,
    "explorerUrl" TEXT,
    "officialWebsite" TEXT,
    "officialTwitter" TEXT,
    "officialTelegram" TEXT,
    "whitePaperUrl" TEXT,
    "status" "CtmTokenStatus" NOT NULL DEFAULT 'pending_review',
    "riskTier" "CtmTokenRiskTier" NOT NULL DEFAULT 'high',
    "riskNotes" VARCHAR(1000),
    "riskLabels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "communityVerified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedByAdminId" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "isListingEnabled" BOOLEAN NOT NULL DEFAULT true,
    "maxListingAmount" DECIMAL(28,8),
    "minTradeAmountPkr" DECIMAL(14,2),
    "totalListings" INTEGER NOT NULL DEFAULT 0,
    "totalTrades" INTEGER NOT NULL DEFAULT 0,
    "totalVolumePkr" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "lastTradedAt" TIMESTAMP(3),
    "suggestedByUserId" TEXT,
    "addedByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CtmToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CtmToken_slug_key" ON "CtmToken"("slug");
CREATE INDEX "CtmToken_status_isListingEnabled_idx" ON "CtmToken"("status", "isListingEnabled");
CREATE INDEX "CtmToken_settlementType_idx" ON "CtmToken"("settlementType");
CREATE INDEX "CtmToken_slug_idx" ON "CtmToken"("slug");

-- CreateTable CtmTokenRequest
CREATE TABLE "CtmTokenRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenId" TEXT,
    "tokenName" TEXT NOT NULL,
    "tokenSymbol" TEXT NOT NULL,
    "description" VARCHAR(1000) NOT NULL,
    "officialWebsite" TEXT,
    "evidenceUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "adminNote" VARCHAR(500),
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CtmTokenRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CtmTokenRequest_userId_idx" ON "CtmTokenRequest"("userId");
CREATE INDEX "CtmTokenRequest_status_idx" ON "CtmTokenRequest"("status");

-- CreateTable CtmMerchantProfile
CREATE TABLE "CtmMerchantProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "tier" "CtmMerchantTier" NOT NULL DEFAULT 'new',
    "collateralAmount" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "collateralCoin" TEXT NOT NULL DEFAULT 'USDT',
    "totalCtmTrades" INTEGER NOT NULL DEFAULT 0,
    "completedCtmTrades" INTEGER NOT NULL DEFAULT 0,
    "disputedCtmTrades" INTEGER NOT NULL DEFAULT 0,
    "ctmDisputeRate" DECIMAL(6,4) NOT NULL DEFAULT 0,
    "ctmAvgRating" DECIMAL(3,2) NOT NULL DEFAULT 0,
    "settlementInstructions" JSONB NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "suspendedUntil" TIMESTAMP(3),
    "suspendReason" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CtmMerchantProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CtmMerchantProfile_userId_key" ON "CtmMerchantProfile"("userId");
CREATE UNIQUE INDEX "CtmMerchantProfile_merchantId_key" ON "CtmMerchantProfile"("merchantId");
CREATE INDEX "CtmMerchantProfile_tier_isActive_idx" ON "CtmMerchantProfile"("tier", "isActive");
CREATE INDEX "CtmMerchantProfile_userId_idx" ON "CtmMerchantProfile"("userId");

-- CreateTable CtmListing
CREATE TABLE "CtmListing" (
    "id" TEXT NOT NULL,
    "listingRef" TEXT NOT NULL,
    "merchantProfileId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "side" "AdSide" NOT NULL,
    "settlementType" "CtmSettlementType" NOT NULL,
    "priceType" "PriceType" NOT NULL DEFAULT 'fixed',
    "pricePerUnit" DECIMAL(14,2) NOT NULL,
    "totalAmount" DECIMAL(28,8) NOT NULL,
    "availableAmount" DECIMAL(28,8) NOT NULL,
    "lockedAmount" DECIMAL(28,8) NOT NULL DEFAULT 0,
    "minOrderPkr" DECIMAL(14,2) NOT NULL,
    "maxOrderPkr" DECIMAL(14,2) NOT NULL,
    "settlementMethod" VARCHAR(100) NOT NULL,
    "settlementNote" VARCHAR(1000) NOT NULL,
    "paymentMethods" TEXT[],
    "tradeWindowMins" INTEGER NOT NULL DEFAULT 45,
    "terms" VARCHAR(2000) NOT NULL DEFAULT '',
    "status" "CtmListingStatus" NOT NULL DEFAULT 'active',
    "requiresProof" BOOLEAN NOT NULL DEFAULT true,
    "proofInstructions" VARCHAR(500),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CtmListing_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CtmListing_listingRef_key" ON "CtmListing"("listingRef");
CREATE INDEX "CtmListing_tokenId_side_status_idx" ON "CtmListing"("tokenId", "side", "status");
CREATE INDEX "CtmListing_merchantProfileId_idx" ON "CtmListing"("merchantProfileId");

-- CreateTable CtmRequest
CREATE TABLE "CtmRequest" (
    "id" TEXT NOT NULL,
    "requestRef" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "side" "AdSide" NOT NULL,
    "amount" DECIMAL(28,8) NOT NULL,
    "targetPricePkr" DECIMAL(14,2),
    "paymentMethods" TEXT[],
    "note" VARCHAR(500),
    "status" "CtmRequestStatus" NOT NULL DEFAULT 'open',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedBidId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CtmRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CtmRequest_requestRef_key" ON "CtmRequest"("requestRef");
CREATE UNIQUE INDEX "CtmRequest_acceptedBidId_key" ON "CtmRequest"("acceptedBidId");
CREATE INDEX "CtmRequest_tokenId_side_status_idx" ON "CtmRequest"("tokenId", "side", "status");
CREATE INDEX "CtmRequest_userId_idx" ON "CtmRequest"("userId");

-- CreateTable CtmBid
CREATE TABLE "CtmBid" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "bidderId" TEXT NOT NULL,
    "pricePerUnit" DECIMAL(14,2) NOT NULL,
    "totalPkr" DECIMAL(14,2) NOT NULL,
    "message" VARCHAR(300),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CtmBid_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CtmBid_requestId_status_idx" ON "CtmBid"("requestId", "status");
CREATE INDEX "CtmBid_bidderId_idx" ON "CtmBid"("bidderId");

-- CreateTable CtmTrade
CREATE TABLE "CtmTrade" (
    "id" TEXT NOT NULL,
    "tradeRef" TEXT NOT NULL,
    "listingId" TEXT,
    "requestId" TEXT,
    "buyerId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "settlementType" "CtmSettlementType" NOT NULL,
    "tokenAmount" DECIMAL(28,8) NOT NULL,
    "pricePerUnit" DECIMAL(14,2) NOT NULL,
    "fiatAmount" DECIMAL(14,2) NOT NULL,
    "paymentMethod" TEXT NOT NULL,
    "paymentProofUrl" TEXT,
    "paymentProofHash" TEXT,
    "settlementMethod" VARCHAR(100) NOT NULL,
    "buyerSettlementId" VARCHAR(500),
    "status" "CtmTradeStatus" NOT NULL DEFAULT 'awaiting_payment',
    "proofDeadlineAt" TIMESTAMP(3),
    "confirmDeadlineAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "cancelledBy" TEXT,
    "cancelReason" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CtmTrade_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CtmTrade_tradeRef_key" ON "CtmTrade"("tradeRef");
CREATE UNIQUE INDEX "CtmTrade_requestId_key" ON "CtmTrade"("requestId");
CREATE INDEX "CtmTrade_buyerId_status_idx" ON "CtmTrade"("buyerId", "status");
CREATE INDEX "CtmTrade_sellerId_status_idx" ON "CtmTrade"("sellerId", "status");
CREATE INDEX "CtmTrade_tradeRef_idx" ON "CtmTrade"("tradeRef");
CREATE INDEX "CtmTrade_tokenId_status_idx" ON "CtmTrade"("tokenId", "status");

-- CreateTable CtmTradeProof
CREATE TABLE "CtmTradeProof" (
    "id" TEXT NOT NULL,
    "tradeId" TEXT NOT NULL,
    "uploadedBy" TEXT NOT NULL,
    "proofType" "CtmProofType" NOT NULL,
    "fileUrl" TEXT,
    "fileHash" TEXT,
    "txHash" TEXT,
    "description" VARCHAR(500),
    "isAdminReviewed" BOOLEAN NOT NULL DEFAULT false,
    "adminNote" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CtmTradeProof_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CtmTradeProof_tradeId_idx" ON "CtmTradeProof"("tradeId");

-- CreateTable CtmTradeMessage
CREATE TABLE "CtmTradeMessage" (
    "id" TEXT NOT NULL,
    "tradeId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "message" VARCHAR(1000) NOT NULL,
    "attachmentUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CtmTradeMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CtmTradeMessage_tradeId_idx" ON "CtmTradeMessage"("tradeId");

-- CreateTable CtmDispute
CREATE TABLE "CtmDispute" (
    "id" TEXT NOT NULL,
    "tradeId" TEXT NOT NULL,
    "openedById" TEXT NOT NULL,
    "reason" "CtmDisputeReason" NOT NULL,
    "description" VARCHAR(5000) NOT NULL,
    "status" "DisputeStatus" NOT NULL DEFAULT 'open',
    "resolution" VARCHAR(2000),
    "winner" "DisputeWinner",
    "resolutionType" "DisputeResolutionType",
    "flaggedForTokenReview" BOOLEAN NOT NULL DEFAULT false,
    "escalatedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CtmDispute_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CtmDispute_tradeId_key" ON "CtmDispute"("tradeId");
CREATE INDEX "CtmDispute_status_idx" ON "CtmDispute"("status");

-- CreateTable CtmDisputeMessage
CREATE TABLE "CtmDisputeMessage" (
    "id" TEXT NOT NULL,
    "disputeId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "message" VARCHAR(2000) NOT NULL,
    "evidenceUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CtmDisputeMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CtmDisputeMessage_disputeId_idx" ON "CtmDisputeMessage"("disputeId");

-- CreateTable CtmTradeRating
CREATE TABLE "CtmTradeRating" (
    "id" TEXT NOT NULL,
    "tradeId" TEXT NOT NULL,
    "ratedByUserId" TEXT NOT NULL,
    "ratedUserId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" VARCHAR(500),
    "tags" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CtmTradeRating_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CtmTradeRating_tradeId_ratedByUserId_key" ON "CtmTradeRating"("tradeId", "ratedByUserId");
CREATE INDEX "CtmTradeRating_ratedUserId_idx" ON "CtmTradeRating"("ratedUserId");

-- AddForeignKeys for CtmTokenRequest
ALTER TABLE "CtmTokenRequest" ADD CONSTRAINT "CtmTokenRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CtmTokenRequest" ADD CONSTRAINT "CtmTokenRequest_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "CtmToken"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKeys for CtmMerchantProfile
ALTER TABLE "CtmMerchantProfile" ADD CONSTRAINT "CtmMerchantProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CtmMerchantProfile" ADD CONSTRAINT "CtmMerchantProfile_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKeys for CtmListing
ALTER TABLE "CtmListing" ADD CONSTRAINT "CtmListing_merchantProfileId_fkey" FOREIGN KEY ("merchantProfileId") REFERENCES "CtmMerchantProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CtmListing" ADD CONSTRAINT "CtmListing_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "CtmToken"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKeys for CtmRequest
ALTER TABLE "CtmRequest" ADD CONSTRAINT "CtmRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CtmRequest" ADD CONSTRAINT "CtmRequest_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "CtmToken"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKeys for CtmBid
ALTER TABLE "CtmBid" ADD CONSTRAINT "CtmBid_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "CtmRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CtmBid" ADD CONSTRAINT "CtmBid_bidderId_fkey" FOREIGN KEY ("bidderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKeys for CtmTrade
ALTER TABLE "CtmTrade" ADD CONSTRAINT "CtmTrade_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "CtmListing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CtmTrade" ADD CONSTRAINT "CtmTrade_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "CtmRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CtmTrade" ADD CONSTRAINT "CtmTrade_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CtmTrade" ADD CONSTRAINT "CtmTrade_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CtmTrade" ADD CONSTRAINT "CtmTrade_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "CtmToken"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKeys for CtmTradeProof
ALTER TABLE "CtmTradeProof" ADD CONSTRAINT "CtmTradeProof_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "CtmTrade"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKeys for CtmTradeMessage
ALTER TABLE "CtmTradeMessage" ADD CONSTRAINT "CtmTradeMessage_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "CtmTrade"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKeys for CtmDispute
ALTER TABLE "CtmDispute" ADD CONSTRAINT "CtmDispute_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "CtmTrade"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKeys for CtmDisputeMessage
ALTER TABLE "CtmDisputeMessage" ADD CONSTRAINT "CtmDisputeMessage_disputeId_fkey" FOREIGN KEY ("disputeId") REFERENCES "CtmDispute"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKeys for CtmTradeRating
ALTER TABLE "CtmTradeRating" ADD CONSTRAINT "CtmTradeRating_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "CtmTrade"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
