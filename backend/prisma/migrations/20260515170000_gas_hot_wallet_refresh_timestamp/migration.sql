-- AlterTable: add optional lastBalanceRefreshAt to GasHotWallet
ALTER TABLE "GasHotWallet" ADD COLUMN "lastBalanceRefreshAt" TIMESTAMP(3);
