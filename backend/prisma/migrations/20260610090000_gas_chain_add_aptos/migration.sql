-- AlterEnum
-- Adds APT (Aptos) to the GasChain enum so inbound USDT payments that settle on
-- Aptos can be recorded on the correct chain in the gas ledger (USER PAYMENT rows
-- previously inherited the gas-delivery chain, e.g. Base, which was wrong).
ALTER TYPE "GasChain" ADD VALUE 'APT';
