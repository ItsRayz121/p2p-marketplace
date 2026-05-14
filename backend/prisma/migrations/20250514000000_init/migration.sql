-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('user', 'merchant', 'kyc_reviewer', 'dispute_agent', 'admin', 'super_admin');

-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('none', 'pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "KycLevel" AS ENUM ('none', 'basic', 'enhanced');

-- CreateEnum
CREATE TYPE "AdSide" AS ENUM ('buy', 'sell');

-- CreateEnum
CREATE TYPE "PriceType" AS ENUM ('fixed', 'float');

-- CreateEnum
CREATE TYPE "AdStatus" AS ENUM ('active', 'paused', 'completed');

-- CreateEnum
CREATE TYPE "TradeStatus" AS ENUM ('payment_pending', 'payment_uploaded', 'payment_confirmed', 'crypto_sent', 'crypto_released', 'cancelled', 'disputed');

-- CreateEnum
CREATE TYPE "InstantBuyStatus" AS ENUM ('payment_pending', 'payment_uploaded', 'admin_review', 'completed', 'rejected', 'expired');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('pending_layer1', 'layer1_passed', 'layer1_failed', 'layer2_approved', 'layer2_rejected');

-- CreateEnum
CREATE TYPE "PaymentMode" AS ENUM ('pkr', 'crypto');

-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('open', 'under_review', 'escalated', 'awaiting_evidence', 'resolved');

-- CreateEnum
CREATE TYPE "DisputeWinner" AS ENUM ('buyer', 'seller');

-- CreateEnum
CREATE TYPE "DisputeResolutionType" AS ENUM ('buyer_wins', 'seller_wins', 'split');

-- CreateEnum
CREATE TYPE "PaymentMethodType" AS ENUM ('jazzcash', 'easypaisa', 'bank_transfer');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('deposit', 'withdrawal', 'trade', 'fee', 'referral_reward', 'gas_fee_payment');

-- CreateEnum
CREATE TYPE "ReferralRewardStatus" AS ENUM ('pending', 'paid');

-- CreateEnum
CREATE TYPE "MerchantStatus" AS ENUM ('pending', 'pending_collateral', 'approved', 'rejected', 'suspended');

-- CreateEnum
CREATE TYPE "MerchantRank" AS ENUM ('bronze', 'silver', 'gold', 'platinum');

-- CreateEnum
CREATE TYPE "CollateralStatus" AS ENUM ('locked', 'unlocked', 'seized');

-- CreateEnum
CREATE TYPE "WithdrawalStatus" AS ENUM ('email_pending', 'pending', 'first_approved', 'approved', 'auto_approved', 'on_hold', 'sent', 'completed', 'rejected', 'cancelled');

-- CreateEnum
CREATE TYPE "FraudSeverity" AS ENUM ('low', 'medium', 'high');

-- CreateEnum
CREATE TYPE "FraudFlagStatus" AS ENUM ('open', 'reviewed');

-- CreateEnum
CREATE TYPE "TraderBadge" AS ENUM ('new', 'active', 'trusted', 'top', 'elite');

-- CreateEnum
CREATE TYPE "GasChain" AS ENUM ('TRON', 'BSC', 'ETH', 'SOL', 'MATIC', 'ARB', 'BASE', 'TON');

-- CreateEnum
CREATE TYPE "GasFeeTier" AS ENUM ('SMALL', 'MEDIUM', 'LARGE');

-- CreateEnum
CREATE TYPE "GasFeeOrderStatus" AS ENUM ('created', 'payment_pending', 'payment_detected', 'sending', 'delivered', 'expired', 'failed', 'refunded');

-- CreateEnum
CREATE TYPE "RateAlertDirection" AS ENUM ('above', 'below');

-- CreateEnum
CREATE TYPE "RateAlertStatus" AS ENUM ('active', 'triggered', 'cancelled');

-- CreateEnum
CREATE TYPE "KycSubmissionTier" AS ENUM ('basic', 'enhanced');

-- CreateEnum
CREATE TYPE "BusinessProofType" AS ENUM ('ntn', 'bank_statement', 'trade_license');

-- CreateEnum
CREATE TYPE "SessionType" AS ENUM ('refresh');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'user',
    "intendedRole" TEXT NOT NULL DEFAULT 'user',
    "kycStatus" "KycStatus" NOT NULL DEFAULT 'none',
    "kycLevel" "KycLevel" NOT NULL DEFAULT 'none',
    "referralCode" TEXT NOT NULL,
    "referredById" TEXT,
    "twoFaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "twoFaSecret" TEXT,
    "withdrawalLockedUntil" TIMESTAMP(3),
    "withdrawalLockReason" VARCHAR(200),
    "isEmailVerified" BOOLEAN NOT NULL DEFAULT false,
    "isSuspended" BOOLEAN NOT NULL DEFAULT false,
    "isBanned" BOOLEAN NOT NULL DEFAULT false,
    "suspendReason" TEXT,
    "dailyBuyUsed" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "dailyBuyReset" TIMESTAMP(3),
    "monthlyBuyUsed" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "monthlyBuyReset" TIMESTAMP(3),
    "dailyBuyLimit" DECIMAL(14,2) NOT NULL DEFAULT 50000,
    "dailySellLimit" DECIMAL(14,2) NOT NULL DEFAULT 50000,
    "completedSellTrades" INTEGER NOT NULL DEFAULT 0,
    "firstTradeBonusPaid" BOOLEAN NOT NULL DEFAULT false,
    "marketingEmailsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "socialLinks" JSONB NOT NULL DEFAULT '{}',
    "socialLinksPublic" BOOLEAN NOT NULL DEFAULT false,
    "termsAcceptedAt" TIMESTAMP(3),
    "termsVersion" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "coin" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "balance" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "lockedBalance" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "depositAddress" TEXT,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "type" "TransactionType" NOT NULL,
    "amount" DECIMAL(18,8) NOT NULL,
    "fee" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "txHash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Withdrawal" (
    "id" TEXT NOT NULL,
    "orderRef" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "coin" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "amount" DECIMAL(18,8) NOT NULL,
    "fee" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "toAddress" TEXT NOT NULL,
    "status" "WithdrawalStatus" NOT NULL DEFAULT 'pending',
    "tier" INTEGER NOT NULL DEFAULT 3,
    "riskScore" INTEGER NOT NULL DEFAULT 0,
    "riskFlags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "amountUsd" DECIMAL(18,2),
    "txHash" TEXT,
    "firstApprovedBy" TEXT,
    "secondApprovedBy" TEXT,
    "rejectedBy" TEXT,
    "rejectionReason" VARCHAR(500),
    "adminNote" VARCHAR(500),
    "onHoldBy" TEXT,
    "onHoldReason" VARCHAR(500),
    "riskOverride" BOOLEAN NOT NULL DEFAULT false,
    "riskOverrideBy" TEXT,
    "riskOverrideNote" VARCHAR(500),
    "confirmationChannel" TEXT NOT NULL DEFAULT 'email',
    "confirmationSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Withdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WithdrawalTierConfig" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "tier1MaxUsd" DECIMAL(10,2) NOT NULL DEFAULT 200,
    "tier2MaxUsd" DECIMAL(10,2) NOT NULL DEFAULT 500,
    "tier3MaxUsd" DECIMAL(10,2) NOT NULL DEFAULT 2000,
    "autoApproveEnabled" BOOLEAN NOT NULL DEFAULT true,
    "firstWithdrawalReview" BOOLEAN NOT NULL DEFAULT true,
    "newWalletReview" BOOLEAN NOT NULL DEFAULT true,
    "velocityWindowMins" INTEGER NOT NULL DEFAULT 60,
    "velocityMaxCount" INTEGER NOT NULL DEFAULT 3,
    "coinPricesUsd" JSONB NOT NULL DEFAULT '{"USDT":1,"USDC":1,"BNB":600,"ETH":3000,"BTC":60000}',
    "emailConfirmationEnabled" BOOLEAN NOT NULL DEFAULT true,
    "emailConfirmationTtlMins" INTEGER NOT NULL DEFAULT 15,
    "addressActivationHours" INTEGER NOT NULL DEFAULT 24,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "WithdrawalTierConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ad" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "side" "AdSide" NOT NULL,
    "coin" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "priceType" "PriceType" NOT NULL DEFAULT 'fixed',
    "price" DECIMAL(14,2) NOT NULL,
    "floatOffset" DECIMAL(6,4) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(18,8) NOT NULL,
    "availableAmount" DECIMAL(18,8) NOT NULL,
    "lockedAmount" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "minOrder" DECIMAL(14,2) NOT NULL,
    "maxOrder" DECIMAL(14,2) NOT NULL,
    "paymentMethods" TEXT[],
    "tradeWindow" INTEGER NOT NULL DEFAULT 30,
    "terms" VARCHAR(2000) NOT NULL DEFAULT '',
    "status" "AdStatus" NOT NULL DEFAULT 'active',
    "lastPriceUpdate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ad_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" TEXT NOT NULL,
    "orderRef" TEXT NOT NULL,
    "adId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "coin" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "amount" DECIMAL(18,8) NOT NULL,
    "price" DECIMAL(14,2) NOT NULL,
    "fiatAmount" DECIMAL(14,2) NOT NULL,
    "paymentMethod" TEXT NOT NULL,
    "status" "TradeStatus" NOT NULL DEFAULT 'payment_pending',
    "paymentProofUrl" TEXT,
    "buyerWalletAddress" TEXT NOT NULL,
    "sellerTxHash" TEXT,
    "escrowReleased" BOOLEAN NOT NULL DEFAULT false,
    "cancelledBy" TEXT,
    "cancelReason" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Trade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradeMessage" (
    "id" TEXT NOT NULL,
    "tradeId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "message" VARCHAR(500) NOT NULL,
    "attachmentUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TradeMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Dispute" (
    "id" TEXT NOT NULL,
    "tradeId" TEXT NOT NULL,
    "openedById" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "description" VARCHAR(5000) NOT NULL,
    "status" "DisputeStatus" NOT NULL DEFAULT 'open',
    "resolution" VARCHAR(2000),
    "winner" "DisputeWinner",
    "resolutionType" "DisputeResolutionType",
    "escalatedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Dispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DisputeMessage" (
    "id" TEXT NOT NULL,
    "disputeId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "message" VARCHAR(2000) NOT NULL,
    "evidenceUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DisputeMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradeRating" (
    "id" TEXT NOT NULL,
    "tradeId" TEXT NOT NULL,
    "ratedByUserId" TEXT NOT NULL,
    "ratedUserId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" VARCHAR(500),
    "tags" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TradeRating_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstantBuyOrder" (
    "id" TEXT NOT NULL,
    "orderRef" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "coin" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "paymentMode" "PaymentMode" NOT NULL,
    "fiatAmount" DECIMAL(14,2),
    "coinAmount" DECIMAL(18,8) NOT NULL,
    "rate" DECIMAL(14,2) NOT NULL,
    "fee" DECIMAL(14,4) NOT NULL,
    "status" "InstantBuyStatus" NOT NULL DEFAULT 'payment_pending',
    "verificationStatus" "VerificationStatus" NOT NULL DEFAULT 'pending_layer1',
    "paymentProofUrl" TEXT,
    "paymentProofHash" TEXT,
    "incomingTxHash" TEXT,
    "toAddress" TEXT NOT NULL,
    "quoteExpiresAt" TIMESTAMP(3) NOT NULL,
    "rejectionReason" VARCHAR(500),
    "ocrConfidence" INTEGER,
    "ocrExtractedAmount" DECIMAL(14,2),
    "resubmitCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InstantBuyOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KycSubmission" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "KycStatus" NOT NULL DEFAULT 'pending',
    "tier" "KycSubmissionTier" NOT NULL DEFAULT 'basic',
    "frontUrl" TEXT NOT NULL,
    "backUrl" TEXT NOT NULL,
    "selfieUrl" TEXT NOT NULL,
    "cnicNumberHash" TEXT NOT NULL,
    "socialLinks" JSONB NOT NULL DEFAULT '[]',
    "rejectionReason" VARCHAR(500),
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KycSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MerchantKycSubmission" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "businessName" TEXT NOT NULL,
    "businessDescription" VARCHAR(1000) NOT NULL,
    "contactPhone" TEXT NOT NULL,
    "businessProofType" "BusinessProofType" NOT NULL,
    "cnicFrontUrl" TEXT NOT NULL,
    "cnicBackUrl" TEXT NOT NULL,
    "selfieUrl" TEXT NOT NULL,
    "businessProofUrl" TEXT NOT NULL,
    "socialLinks" JSONB NOT NULL DEFAULT '[]',
    "status" "KycStatus" NOT NULL DEFAULT 'pending',
    "rejectionReason" VARCHAR(500),
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MerchantKycSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentMethod" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "PaymentMethodType" NOT NULL,
    "displayName" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "mobileNumber" TEXT,
    "bankName" TEXT,
    "ibanNumber" TEXT,
    "accountNumber" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentMethod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedAddress" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "coin" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "label" TEXT NOT NULL,

    CONSTRAINT "SavedAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrustedWithdrawalAddress" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "coin" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "activatesAt" TIMESTAMP(3) NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "TrustedWithdrawalAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollateralLock" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "coin" TEXT NOT NULL DEFAULT 'USDT',
    "amount" DECIMAL(18,8) NOT NULL,
    "status" "CollateralStatus" NOT NULL DEFAULT 'locked',
    "lockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unlockedAt" TIMESTAMP(3),
    "seizedAt" TIMESTAMP(3),
    "seizeReason" TEXT,

    CONSTRAINT "CollateralLock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Merchant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "businessName" TEXT NOT NULL,
    "status" "MerchantStatus" NOT NULL DEFAULT 'pending',
    "spreadBps" INTEGER NOT NULL DEFAULT 0,
    "approvedAt" TIMESTAMP(3),
    "rank" "MerchantRank" NOT NULL DEFAULT 'bronze',
    "rankUpdatedAt" TIMESTAMP(3),
    "disputeRate" DECIMAL(6,4) NOT NULL DEFAULT 0,
    "socialLinks" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Merchant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MerchantInventory" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "coin" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "availableAmount" DECIMAL(18,8) NOT NULL,
    "pricePerUnit" DECIMAL(14,2) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchantInventory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralReward" (
    "id" TEXT NOT NULL,
    "referrerId" TEXT NOT NULL,
    "referredId" TEXT NOT NULL,
    "status" "ReferralRewardStatus" NOT NULL DEFAULT 'pending',
    "rewardAmount" DECIMAL(14,2) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralReward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "keys" JSONB NOT NULL,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "template" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'sent',
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OtpCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OtpCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "SessionType" NOT NULL DEFAULT 'refresh',
    "token" TEXT NOT NULL,
    "userAgent" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformConfig" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminNote" (
    "id" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "authorAdminId" TEXT NOT NULL,
    "note" VARCHAR(2000) NOT NULL,
    "isInternal" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FraudFlag" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "severity" "FraudSeverity" NOT NULL DEFAULT 'low',
    "status" "FraudFlagStatus" NOT NULL DEFAULT 'open',
    "reviewedAt" TIMESTAMP(3),
    "actionTaken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FraudFlag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SanctionedEntity" (
    "id" TEXT NOT NULL,
    "nameHash" TEXT NOT NULL,
    "listSource" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,

    CONSTRAINT "SanctionedEntity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradeStats" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "totalTrades" INTEGER NOT NULL DEFAULT 0,
    "completedTrades" INTEGER NOT NULL DEFAULT 0,
    "cancelledTrades" INTEGER NOT NULL DEFAULT 0,
    "completionRate" DECIMAL(5,4) NOT NULL DEFAULT 0,
    "avgRating" DECIMAL(3,2) NOT NULL DEFAULT 0,
    "totalReviews" INTEGER NOT NULL DEFAULT 0,
    "totalVolumePKR" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "trustScore" INTEGER NOT NULL DEFAULT 0,
    "badge" "TraderBadge" NOT NULL DEFAULT 'new',
    "badgeLabel" TEXT NOT NULL DEFAULT 'New Trader',
    "lastUpdated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradeStats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateAlert" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "coin" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "direction" "RateAlertDirection" NOT NULL,
    "targetRate" DECIMAL(14,2) NOT NULL,
    "status" "RateAlertStatus" NOT NULL DEFAULT 'active',
    "triggeredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RateAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GasFeeOrder" (
    "id" TEXT NOT NULL,
    "orderRef" TEXT NOT NULL,
    "userId" TEXT,
    "ipAddress" TEXT,
    "chain" "GasChain" NOT NULL,
    "tier" "GasFeeTier" NOT NULL,
    "gasAmountNative" DECIMAL(18,8) NOT NULL,
    "gasAmountUSD" DECIMAL(10,4) NOT NULL,
    "priceAtOrder" DECIMAL(18,8) NOT NULL,
    "paymentCoin" TEXT NOT NULL DEFAULT 'USDT',
    "paymentNetwork" TEXT NOT NULL,
    "paymentAmount" DECIMAL(10,4) NOT NULL,
    "paymentTxHash" TEXT,
    "toAddress" TEXT NOT NULL,
    "fromHotWallet" TEXT,
    "deliveryTxHash" TEXT,
    "deliveryConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "status" "GasFeeOrderStatus" NOT NULL DEFAULT 'created',
    "failureReason" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deliveredAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),

    CONSTRAINT "GasFeeOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GasHotWallet" (
    "id" TEXT NOT NULL,
    "chain" "GasChain" NOT NULL,
    "address" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GasHotWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepositAddress" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chainFamily" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "derivationIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DepositAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MoralisStreamSubscription" (
    "id" TEXT NOT NULL,
    "depositAddressId" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "streamId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastAttemptAt" TIMESTAMP(3),
    "subscribedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MoralisStreamSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deposit" (
    "id" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "toAddress" TEXT NOT NULL,
    "amount" DECIMAL(38,18) NOT NULL,
    "confirmations" INTEGER NOT NULL DEFAULT 0,
    "userId" TEXT,
    "walletId" TEXT,
    "creditedTransactionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'detected',
    "rejectionReason" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creditedAt" TIMESTAMP(3),

    CONSTRAINT "Deposit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_referralCode_key" ON "User"("referralCode");

-- CreateIndex
CREATE INDEX "User_email_idx" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_username_idx" ON "User"("username");

-- CreateIndex
CREATE INDEX "User_referralCode_idx" ON "User"("referralCode");

-- CreateIndex
CREATE INDEX "Wallet_userId_idx" ON "Wallet"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_userId_coin_network_key" ON "Wallet"("userId", "coin", "network");

-- CreateIndex
CREATE INDEX "Transaction_walletId_idx" ON "Transaction"("walletId");

-- CreateIndex
CREATE INDEX "Transaction_txHash_idx" ON "Transaction"("txHash");

-- CreateIndex
CREATE UNIQUE INDEX "Withdrawal_orderRef_key" ON "Withdrawal"("orderRef");

-- CreateIndex
CREATE INDEX "Withdrawal_userId_status_idx" ON "Withdrawal"("userId", "status");

-- CreateIndex
CREATE INDEX "Withdrawal_status_idx" ON "Withdrawal"("status");

-- CreateIndex
CREATE INDEX "Withdrawal_orderRef_idx" ON "Withdrawal"("orderRef");

-- CreateIndex
CREATE INDEX "Ad_side_coin_status_idx" ON "Ad"("side", "coin", "status");

-- CreateIndex
CREATE INDEX "Ad_userId_idx" ON "Ad"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Trade_orderRef_key" ON "Trade"("orderRef");

-- CreateIndex
CREATE INDEX "Trade_buyerId_status_idx" ON "Trade"("buyerId", "status");

-- CreateIndex
CREATE INDEX "Trade_sellerId_status_idx" ON "Trade"("sellerId", "status");

-- CreateIndex
CREATE INDEX "Trade_orderRef_idx" ON "Trade"("orderRef");

-- CreateIndex
CREATE INDEX "TradeMessage_tradeId_idx" ON "TradeMessage"("tradeId");

-- CreateIndex
CREATE UNIQUE INDEX "Dispute_tradeId_key" ON "Dispute"("tradeId");

-- CreateIndex
CREATE INDEX "Dispute_status_idx" ON "Dispute"("status");

-- CreateIndex
CREATE INDEX "DisputeMessage_disputeId_idx" ON "DisputeMessage"("disputeId");

-- CreateIndex
CREATE INDEX "TradeRating_ratedUserId_idx" ON "TradeRating"("ratedUserId");

-- CreateIndex
CREATE UNIQUE INDEX "TradeRating_tradeId_ratedByUserId_key" ON "TradeRating"("tradeId", "ratedByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "InstantBuyOrder_orderRef_key" ON "InstantBuyOrder"("orderRef");

-- CreateIndex
CREATE INDEX "InstantBuyOrder_userId_status_idx" ON "InstantBuyOrder"("userId", "status");

-- CreateIndex
CREATE INDEX "InstantBuyOrder_orderRef_idx" ON "InstantBuyOrder"("orderRef");

-- CreateIndex
CREATE INDEX "InstantBuyOrder_paymentProofHash_idx" ON "InstantBuyOrder"("paymentProofHash");

-- CreateIndex
CREATE INDEX "KycSubmission_userId_idx" ON "KycSubmission"("userId");

-- CreateIndex
CREATE INDEX "KycSubmission_cnicNumberHash_idx" ON "KycSubmission"("cnicNumberHash");

-- CreateIndex
CREATE INDEX "MerchantKycSubmission_userId_idx" ON "MerchantKycSubmission"("userId");

-- CreateIndex
CREATE INDEX "PaymentMethod_userId_idx" ON "PaymentMethod"("userId");

-- CreateIndex
CREATE INDEX "SavedAddress_userId_idx" ON "SavedAddress"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SavedAddress_userId_coin_network_address_key" ON "SavedAddress"("userId", "coin", "network", "address");

-- CreateIndex
CREATE INDEX "TrustedWithdrawalAddress_userId_idx" ON "TrustedWithdrawalAddress"("userId");

-- CreateIndex
CREATE INDEX "TrustedWithdrawalAddress_userId_removedAt_idx" ON "TrustedWithdrawalAddress"("userId", "removedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TrustedWithdrawalAddress_userId_coin_network_address_key" ON "TrustedWithdrawalAddress"("userId", "coin", "network", "address");

-- CreateIndex
CREATE INDEX "CollateralLock_userId_status_idx" ON "CollateralLock"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Merchant_userId_key" ON "Merchant"("userId");

-- CreateIndex
CREATE INDEX "MerchantInventory_merchantId_idx" ON "MerchantInventory"("merchantId");

-- CreateIndex
CREATE INDEX "ReferralReward_referrerId_status_idx" ON "ReferralReward"("referrerId", "status");

-- CreateIndex
CREATE INDEX "Notification_userId_isRead_idx" ON "Notification"("userId", "isRead");

-- CreateIndex
CREATE INDEX "PushSubscription_userId_idx" ON "PushSubscription"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_userId_endpoint_key" ON "PushSubscription"("userId", "endpoint");

-- CreateIndex
CREATE INDEX "EmailLog_userId_idx" ON "EmailLog"("userId");

-- CreateIndex
CREATE INDEX "OtpCode_userId_type_idx" ON "OtpCode"("userId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "Session_token_key" ON "Session"("token");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_token_idx" ON "Session"("token");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformConfig_key_key" ON "PlatformConfig"("key");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_idx" ON "AuditLog"("actorId");

-- CreateIndex
CREATE INDEX "AuditLog_targetType_targetId_idx" ON "AuditLog"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- CreateIndex
CREATE INDEX "AdminNote_targetUserId_idx" ON "AdminNote"("targetUserId");

-- CreateIndex
CREATE INDEX "FraudFlag_userId_status_idx" ON "FraudFlag"("userId", "status");

-- CreateIndex
CREATE INDEX "FraudFlag_severity_status_idx" ON "FraudFlag"("severity", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SanctionedEntity_nameHash_key" ON "SanctionedEntity"("nameHash");

-- CreateIndex
CREATE INDEX "SanctionedEntity_nameHash_idx" ON "SanctionedEntity"("nameHash");

-- CreateIndex
CREATE UNIQUE INDEX "TradeStats_userId_key" ON "TradeStats"("userId");

-- CreateIndex
CREATE INDEX "RateAlert_userId_status_idx" ON "RateAlert"("userId", "status");

-- CreateIndex
CREATE INDEX "RateAlert_coin_status_idx" ON "RateAlert"("coin", "status");

-- CreateIndex
CREATE UNIQUE INDEX "GasFeeOrder_orderRef_key" ON "GasFeeOrder"("orderRef");

-- CreateIndex
CREATE INDEX "GasFeeOrder_status_expiresAt_idx" ON "GasFeeOrder"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "GasFeeOrder_userId_idx" ON "GasFeeOrder"("userId");

-- CreateIndex
CREATE INDEX "GasFeeOrder_orderRef_idx" ON "GasFeeOrder"("orderRef");

-- CreateIndex
CREATE INDEX "GasFeeOrder_paymentTxHash_idx" ON "GasFeeOrder"("paymentTxHash");

-- CreateIndex
CREATE UNIQUE INDEX "GasHotWallet_chain_key" ON "GasHotWallet"("chain");

-- CreateIndex
CREATE INDEX "GasHotWallet_chain_isActive_idx" ON "GasHotWallet"("chain", "isActive");

-- CreateIndex
CREATE INDEX "DepositAddress_chainFamily_idx" ON "DepositAddress"("chainFamily");

-- CreateIndex
CREATE UNIQUE INDEX "DepositAddress_userId_chainFamily_key" ON "DepositAddress"("userId", "chainFamily");

-- CreateIndex
CREATE UNIQUE INDEX "DepositAddress_address_key" ON "DepositAddress"("address");

-- CreateIndex
CREATE INDEX "MoralisStreamSubscription_status_idx" ON "MoralisStreamSubscription"("status");

-- CreateIndex
CREATE INDEX "MoralisStreamSubscription_chain_status_idx" ON "MoralisStreamSubscription"("chain", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MoralisStreamSubscription_depositAddressId_chain_key" ON "MoralisStreamSubscription"("depositAddressId", "chain");

-- CreateIndex
CREATE INDEX "Deposit_toAddress_idx" ON "Deposit"("toAddress");

-- CreateIndex
CREATE INDEX "Deposit_userId_idx" ON "Deposit"("userId");

-- CreateIndex
CREATE INDEX "Deposit_status_idx" ON "Deposit"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Deposit_txHash_chain_asset_key" ON "Deposit"("txHash", "chain", "asset");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_referredById_fkey" FOREIGN KEY ("referredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Withdrawal" ADD CONSTRAINT "Withdrawal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ad" ADD CONSTRAINT "Ad_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_adId_fkey" FOREIGN KEY ("adId") REFERENCES "Ad"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeMessage" ADD CONSTRAINT "TradeMessage_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "Trade"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "Trade"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DisputeMessage" ADD CONSTRAINT "DisputeMessage_disputeId_fkey" FOREIGN KEY ("disputeId") REFERENCES "Dispute"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeRating" ADD CONSTRAINT "TradeRating_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "Trade"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstantBuyOrder" ADD CONSTRAINT "InstantBuyOrder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KycSubmission" ADD CONSTRAINT "KycSubmission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentMethod" ADD CONSTRAINT "PaymentMethod_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedAddress" ADD CONSTRAINT "SavedAddress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrustedWithdrawalAddress" ADD CONSTRAINT "TrustedWithdrawalAddress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollateralLock" ADD CONSTRAINT "CollateralLock_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Merchant" ADD CONSTRAINT "Merchant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantInventory" ADD CONSTRAINT "MerchantInventory_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralReward" ADD CONSTRAINT "ReferralReward_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralReward" ADD CONSTRAINT "ReferralReward_referredId_fkey" FOREIGN KEY ("referredId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminNote" ADD CONSTRAINT "AdminNote_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FraudFlag" ADD CONSTRAINT "FraudFlag_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeStats" ADD CONSTRAINT "TradeStats_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RateAlert" ADD CONSTRAINT "RateAlert_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GasFeeOrder" ADD CONSTRAINT "GasFeeOrder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepositAddress" ADD CONSTRAINT "DepositAddress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MoralisStreamSubscription" ADD CONSTRAINT "MoralisStreamSubscription_depositAddressId_fkey" FOREIGN KEY ("depositAddressId") REFERENCES "DepositAddress"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

