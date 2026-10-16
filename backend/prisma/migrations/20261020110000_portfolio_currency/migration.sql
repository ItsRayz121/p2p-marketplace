-- Portfolio: per-record currency and exchange rate (additive; existing rows default to PKR with no rate).
-- AlterTable
ALTER TABLE "PortfolioEvent" ADD COLUMN     "fxRate" DECIMAL(46,18),
ADD COLUMN     "fxSource" VARCHAR(10),
ADD COLUMN     "quote" VARCHAR(4) NOT NULL DEFAULT 'PKR';

-- AlterTable
ALTER TABLE "PortfolioPriceObservation" ADD COLUMN     "quote" VARCHAR(4) NOT NULL DEFAULT 'PKR';
