-- Phase 6 of the Gas-Payment promo/referral system: KOL giveaway campaigns. People
-- enter with their receiving address; an admin later draws N winners and free gas is
-- delivered to the selected addresses (Phase 3 path). Payout is decoupled from entry,
-- so cost is fixed at winners × amount. All new tables; runs only when
-- gas_giveaway_enabled = ON.

-- CreateTable
CREATE TABLE "GasGiveawayCampaign" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "kolLabel" TEXT NOT NULL,
    "gasTokenConfigId" TEXT NOT NULL,
    "amountNative" DECIMAL(18,8) NOT NULL,
    "winnerCount" INTEGER NOT NULL,
    "drawnCount" INTEGER NOT NULL DEFAULT 0,
    "entryDeadline" TIMESTAMP(3),
    "requireKyc" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'open',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GasGiveawayCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GasGiveawayEntry" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT,
    "receivingAddress" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'entered',
    "orderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GasGiveawayEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GasGiveawayCampaign_code_key" ON "GasGiveawayCampaign"("code");
CREATE INDEX "GasGiveawayCampaign_isActive_status_idx" ON "GasGiveawayCampaign"("isActive", "status");
CREATE UNIQUE INDEX "GasGiveawayEntry_campaignId_userId_key" ON "GasGiveawayEntry"("campaignId", "userId");
CREATE INDEX "GasGiveawayEntry_campaignId_status_idx" ON "GasGiveawayEntry"("campaignId", "status");

-- AddForeignKey
ALTER TABLE "GasGiveawayEntry" ADD CONSTRAINT "GasGiveawayEntry_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "GasGiveawayCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
