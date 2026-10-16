-- Portfolio: index for the all-transactions list (newest first per user). Additive.
-- CreateIndex
CREATE INDEX "PortfolioEvent_userId_occurredAt_idx" ON "PortfolioEvent"("userId", "occurredAt");
