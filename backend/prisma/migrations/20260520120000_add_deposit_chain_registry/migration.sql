-- CreateTable
CREATE TABLE "DepositChain" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "chainId" INTEGER,
    "name" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "nativeSymbol" TEXT NOT NULL,
    "networkLabel" TEXT NOT NULL,
    "minConfirmations" INTEGER NOT NULL,
    "explorerBase" TEXT NOT NULL,
    "rpcEnvVar" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DepositChain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepositToken" (
    "id" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "address" TEXT,
    "decimals" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "coingeckoId" TEXT,
    "trustWalletVerified" BOOLEAN NOT NULL DEFAULT false,
    "onChainVerified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DepositToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DepositChain_slug_key" ON "DepositChain"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "DepositChain_networkLabel_key" ON "DepositChain"("networkLabel");

-- CreateIndex
CREATE INDEX "DepositChain_family_idx" ON "DepositChain"("family");

-- CreateIndex
CREATE UNIQUE INDEX "DepositToken_chainId_symbol_key" ON "DepositToken"("chainId", "symbol");

-- CreateIndex
CREATE INDEX "DepositToken_symbol_idx" ON "DepositToken"("symbol");

-- AddForeignKey
ALTER TABLE "DepositToken" ADD CONSTRAINT "DepositToken_chainId_fkey" FOREIGN KEY ("chainId") REFERENCES "DepositChain"("id") ON DELETE CASCADE ON UPDATE CASCADE;
