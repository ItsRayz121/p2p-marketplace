-- Portfolio: keep the earlier version of a manual entry when the user corrects or removes it
-- (additive; existing rows are untouched and have no edit time).
-- AlterTable
ALTER TABLE "PortfolioEvent" ADD COLUMN     "editedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PortfolioEventRevision" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "eventId" VARCHAR(40) NOT NULL,
    "assetId" VARCHAR(40) NOT NULL,
    "action" VARCHAR(8) NOT NULL,
    "before" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortfolioEventRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PortfolioEventRevision_userId_eventId_createdAt_idx" ON "PortfolioEventRevision"("userId", "eventId", "createdAt");

-- CreateIndex
CREATE INDEX "PortfolioEventRevision_userId_assetId_createdAt_idx" ON "PortfolioEventRevision"("userId", "assetId", "createdAt");

-- AddForeignKey
ALTER TABLE "PortfolioEventRevision" ADD CONSTRAINT "PortfolioEventRevision_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
