-- Portfolio: archive a tracked token without losing its history (additive).
-- AlterTable
ALTER TABLE "PortfolioAsset" ADD COLUMN     "archivedAt" TIMESTAMP(3);
