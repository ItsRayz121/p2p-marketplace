-- AlterEnum
-- Adds OPBNB (opBNB, BNB Smart Chain L2, chainId 204) to the GasChain enum so it
-- becomes a first-class deliverable gas chain instead of a native token wrongly
-- nested under BSC. opBNB shares the EVM hot-wallet address with BSC but has its
-- own network/RPC/balance — see gas.chains.ts GAS_CHAINS.OPBNB.
ALTER TYPE "GasChain" ADD VALUE 'OPBNB';
