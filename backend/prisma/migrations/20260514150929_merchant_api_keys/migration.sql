-- AlterTable
ALTER TABLE "GasFeeOrder" ADD COLUMN     "merchantApiKeyId" TEXT;

-- CreateTable
CREATE TABLE "MerchantApiKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "rateLimit" INTEGER NOT NULL DEFAULT 60,
    "lastUsedAt" TIMESTAMP(3),
    "webhookUrl" TEXT,
    "webhookSecret" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MerchantApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MerchantApiKey_keyId_key" ON "MerchantApiKey"("keyId");

-- CreateIndex
CREATE INDEX "MerchantApiKey_userId_idx" ON "MerchantApiKey"("userId");

-- CreateIndex
CREATE INDEX "MerchantApiKey_isActive_idx" ON "MerchantApiKey"("isActive");

-- AddForeignKey
ALTER TABLE "GasFeeOrder" ADD CONSTRAINT "GasFeeOrder_merchantApiKeyId_fkey" FOREIGN KEY ("merchantApiKeyId") REFERENCES "MerchantApiKey"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantApiKey" ADD CONSTRAINT "MerchantApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
