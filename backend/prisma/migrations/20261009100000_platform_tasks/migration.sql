ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'task_reward';

CREATE TABLE "PlatformTask" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "url" TEXT,
    "telegramChat" TEXT,
    "verifyMode" TEXT NOT NULL,
    "rewardType" TEXT NOT NULL,
    "rewardPoints" DECIMAL(18,4),
    "rewardUsdt" DECIMAL(18,8),
    "payoutMode" TEXT NOT NULL DEFAULT 'auto',
    "requireKyc" BOOLEAN NOT NULL DEFAULT false,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "maxClaims" INTEGER,
    "claimedCount" INTEGER NOT NULL DEFAULT 0,
    "budgetUsdt" DECIMAL(18,8),
    "spentUsdt" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformTask_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PlatformTaskCompletion" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "proof" TEXT,
    "rewardType" TEXT NOT NULL,
    "rewardPoints" DECIMAL(18,4),
    "rewardUsdt" DECIMAL(18,8),
    "payoutMode" TEXT,
    "payoutNetwork" TEXT,
    "payoutAddress" TEXT,
    "txHash" TEXT,
    "rejectionReason" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformTaskCompletion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PlatformTask_isActive_endsAt_idx" ON "PlatformTask"("isActive", "endsAt");
CREATE UNIQUE INDEX "PlatformTaskCompletion_txHash_key" ON "PlatformTaskCompletion"("txHash");
CREATE UNIQUE INDEX "PlatformTaskCompletion_taskId_userId_key" ON "PlatformTaskCompletion"("taskId", "userId");
CREATE INDEX "PlatformTaskCompletion_status_createdAt_idx" ON "PlatformTaskCompletion"("status", "createdAt");
CREATE INDEX "PlatformTaskCompletion_userId_createdAt_idx" ON "PlatformTaskCompletion"("userId", "createdAt");

ALTER TABLE "PlatformTaskCompletion" ADD CONSTRAINT "PlatformTaskCompletion_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "PlatformTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
