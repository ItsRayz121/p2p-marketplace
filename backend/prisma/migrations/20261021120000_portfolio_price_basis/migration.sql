-- Portfolio: remember whether a buy/sell used the RupChain price or the price the user got elsewhere
-- (additive; informational only; existing rows are NULL).
-- AlterTable
ALTER TABLE "PortfolioEvent" ADD COLUMN     "priceBasis" VARCHAR(8);
