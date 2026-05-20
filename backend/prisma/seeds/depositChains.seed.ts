/**
 * Seed script: populate DepositChain + DepositToken from the static EVM_CHAINS array.
 * Idempotent — safe to re-run. Uses upsert on slug / (chainId, symbol).
 *
 * Run: npx ts-node --project tsconfig.json prisma/seeds/depositChains.seed.ts
 */
import { PrismaClient } from '@prisma/client'
import { EVM_CHAINS } from '../../src/lib/chains'

const prisma = new PrismaClient()

const RPC_ENV_VARS: Record<string, string> = {
  ethereum: 'ETHEREUM_RPC_URL',
  bsc:      'BSC_RPC_URL',
  polygon:  'POLYGON_RPC_URL',
  arbitrum: 'ARBITRUM_RPC_URL',
  optimism: 'OPTIMISM_RPC_URL',
  base:     'BASE_RPC_URL',
}

// CoinGecko coin IDs for known tokens — pre-populated so verification badges light up
const COINGECKO_IDS: Record<string, string> = {
  USDT: 'tether',
  USDC: 'usd-coin',
  ETH:  'ethereum',
  BNB:  'binancecoin',
  MATIC: 'matic-network',
  POL:  'matic-network',
}

async function main() {
  console.log('Seeding DepositChain + DepositToken from EVM_CHAINS...\n')

  for (const chain of EVM_CHAINS) {
    const chainRow = await prisma.depositChain.upsert({
      where: { slug: chain.id },
      update: {
        name:             chain.name,
        chainId:          chain.chainId ?? null,
        family:           chain.family,
        nativeSymbol:     chain.nativeSymbol,
        networkLabel:     chain.networkLabel,
        minConfirmations: chain.minConfirmations,
        explorerBase:     chain.explorerBase,
        rpcEnvVar:        RPC_ENV_VARS[chain.id] ?? null,
        isActive:         true,
      },
      create: {
        slug:             chain.id,
        name:             chain.name,
        chainId:          chain.chainId ?? null,
        family:           chain.family,
        nativeSymbol:     chain.nativeSymbol,
        networkLabel:     chain.networkLabel,
        minConfirmations: chain.minConfirmations,
        explorerBase:     chain.explorerBase,
        rpcEnvVar:        RPC_ENV_VARS[chain.id] ?? null,
        isActive:         true,
      },
    })

    console.log(`  chain: ${chain.id} → ${chainRow.id}`)

    for (const token of chain.tokens) {
      const tokenRow = await prisma.depositToken.upsert({
        where: { chainId_symbol: { chainId: chainRow.id, symbol: token.symbol } },
        update: {
          address:             token.address,
          decimals:            token.decimals,
          isActive:            true,
          coingeckoId:         COINGECKO_IDS[token.symbol] ?? null,
          onChainVerified:     true,
          trustWalletVerified: true,
          verifiedAt:          new Date(),
        },
        create: {
          chainId:             chainRow.id,
          symbol:              token.symbol,
          address:             token.address,
          decimals:            token.decimals,
          isActive:            true,
          coingeckoId:         COINGECKO_IDS[token.symbol] ?? null,
          onChainVerified:     true,
          trustWalletVerified: true,
          verifiedAt:          new Date(),
        },
      })
      console.log(`    token: ${token.symbol} (${token.address?.slice(0, 10)}...) → ${tokenRow.id}`)
    }
  }

  console.log('\nSeed complete.')
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
