-- Portfolio: a manual entry can point at the RupChain trade it was recorded for, so the importer
-- never counts that trade a second time (additive; existing rows have no link).
-- AlterTable
ALTER TABLE "PortfolioEvent" ADD COLUMN     "linkedTradeRef" VARCHAR(64);

-- CreateIndex
CREATE UNIQUE INDEX "PortfolioEvent_userId_linkedTradeRef_key" ON "PortfolioEvent"("userId", "linkedTradeRef");
