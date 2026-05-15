-- AlterEnum
-- PostgreSQL does not support adding enum values inside a transaction.
ALTER TYPE "GasChain" ADD VALUE 'OP';
ALTER TYPE "GasChain" ADD VALUE 'AVAX';
