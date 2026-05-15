/**
 * Seed script: populate GasChainConfig + GasTokenConfig with initial data.
 * Run with: npx ts-node prisma/seed-gas-chains.ts
 * Or via: npx prisma db seed (if configured in package.json)
 *
 * Safe to re-run — uses upsert by slug/chainConfigId+symbol.
 */

import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

async function main() {
  const chains = [
    {
      slug: 'TRON',
      name: 'TRON',
      symbol: 'TRX',
      category: 'tron',
      networkLabel: 'TRC20',
      addressType: 'TRC20',
      explorerBase: 'https://tronscan.org/#',
      backendChainId: 'TRON',
      isActive: true,
      displayOrder: 1,
      tokens: [
        {
          name: 'TRX',
          symbol: 'TRX',
          tokenType: 'native',
          priceSymbol: 'TRX',
          minAmount: 10,
          maxUsdValue: 10,
          presetAmounts: [10, 50, 100, 200],
          isActive: true,
          displayOrder: 1,
        },
      ],
    },
    {
      slug: 'BSC',
      name: 'BNB Smart Chain',
      symbol: 'BNB',
      category: 'bnb',
      networkLabel: 'BEP20',
      addressType: 'EVM',
      explorerBase: 'https://bscscan.com',
      backendChainId: 'BSC',
      isActive: true,
      displayOrder: 2,
      tokens: [
        {
          name: 'BNB',
          symbol: 'BNB',
          tokenType: 'native',
          priceSymbol: 'BNB',
          minAmount: 0.005,
          maxUsdValue: 10,
          presetAmounts: [0.005, 0.01, 0.02, 0.05],
          isActive: true,
          displayOrder: 1,
        },
      ],
    },
    {
      slug: 'ETH',
      name: 'Ethereum',
      symbol: 'ETH',
      category: 'ethereum',
      networkLabel: 'ERC20',
      addressType: 'EVM',
      explorerBase: 'https://etherscan.io',
      backendChainId: 'ETH',
      isActive: true,
      displayOrder: 3,
      tokens: [
        {
          name: 'ETH',
          symbol: 'ETH',
          tokenType: 'native',
          priceSymbol: 'ETH',
          minAmount: 0.001,
          maxUsdValue: 10,
          presetAmounts: [0.001, 0.003, 0.005, 0.01],
          isActive: true,
          displayOrder: 1,
        },
      ],
    },
    {
      slug: 'BASE',
      name: 'Base',
      symbol: 'ETH',
      category: 'ethereum',
      networkLabel: 'Base',
      addressType: 'EVM',
      explorerBase: 'https://basescan.org',
      backendChainId: null,
      isActive: false,
      displayOrder: 4,
      tokens: [
        {
          name: 'ETH (Base)',
          symbol: 'ETH',
          tokenType: 'native',
          priceSymbol: 'ETH',
          minAmount: 0.001,
          maxUsdValue: 10,
          presetAmounts: [0.001, 0.003, 0.005, 0.01],
          isActive: false,
          displayOrder: 1,
        },
      ],
    },
    {
      slug: 'ARB',
      name: 'Arbitrum',
      symbol: 'ETH',
      category: 'ethereum',
      networkLabel: 'Arbitrum',
      addressType: 'EVM',
      explorerBase: 'https://arbiscan.io',
      backendChainId: null,
      isActive: false,
      displayOrder: 5,
      tokens: [
        {
          name: 'ETH (Arbitrum)',
          symbol: 'ETH',
          tokenType: 'native',
          priceSymbol: 'ETH',
          minAmount: 0.001,
          maxUsdValue: 10,
          presetAmounts: [0.001, 0.003, 0.005, 0.01],
          isActive: false,
          displayOrder: 1,
        },
      ],
    },
    {
      slug: 'MATIC',
      name: 'Polygon',
      symbol: 'POL',
      category: 'ethereum',
      networkLabel: 'Polygon',
      addressType: 'EVM',
      explorerBase: 'https://polygonscan.com',
      backendChainId: null,
      isActive: false,
      displayOrder: 6,
      tokens: [
        {
          name: 'POL',
          symbol: 'POL',
          tokenType: 'native',
          priceSymbol: 'MATIC',
          minAmount: 1,
          maxUsdValue: 10,
          presetAmounts: [1, 5, 10, 20],
          isActive: false,
          displayOrder: 1,
        },
      ],
    },
    {
      slug: 'OP',
      name: 'Optimism',
      symbol: 'ETH',
      category: 'ethereum',
      networkLabel: 'Optimism',
      addressType: 'EVM',
      explorerBase: 'https://optimistic.etherscan.io',
      backendChainId: null,
      isActive: false,
      displayOrder: 7,
      tokens: [
        {
          name: 'ETH (Optimism)',
          symbol: 'ETH',
          tokenType: 'native',
          priceSymbol: 'ETH',
          minAmount: 0.001,
          maxUsdValue: 10,
          presetAmounts: [0.001, 0.003, 0.005, 0.01],
          isActive: false,
          displayOrder: 1,
        },
      ],
    },
    {
      slug: 'SOL',
      name: 'Solana',
      symbol: 'SOL',
      category: 'solana',
      networkLabel: 'Solana',
      addressType: 'SOL',
      explorerBase: 'https://solscan.io',
      backendChainId: null,
      isActive: false,
      displayOrder: 8,
      tokens: [
        {
          name: 'SOL',
          symbol: 'SOL',
          tokenType: 'native',
          priceSymbol: 'SOL',
          minAmount: 0.01,
          maxUsdValue: 10,
          presetAmounts: [0.01, 0.05, 0.1, 0.5],
          isActive: false,
          displayOrder: 1,
        },
      ],
    },
    {
      slug: 'SUI',
      name: 'SUI',
      symbol: 'SUI',
      category: 'sui',
      networkLabel: 'SUI',
      addressType: 'SUI',
      explorerBase: 'https://suiscan.xyz',
      backendChainId: null,
      isActive: false,
      displayOrder: 9,
      tokens: [
        {
          name: 'SUI',
          symbol: 'SUI',
          tokenType: 'native',
          priceSymbol: 'SUI',
          minAmount: 0.1,
          maxUsdValue: 10,
          presetAmounts: [0.1, 0.5, 1, 5],
          isActive: false,
          displayOrder: 1,
        },
      ],
    },
  ]

  for (const chain of chains) {
    const { tokens, ...chainData } = chain
    const upsertedChain = await db.gasChainConfig.upsert({
      where: { slug: chainData.slug },
      update: chainData,
      create: chainData,
    })
    console.log(`✓ Chain: ${upsertedChain.name} (${upsertedChain.slug})`)

    for (const token of tokens) {
      const existing = await db.gasTokenConfig.findFirst({
        where: { chainConfigId: upsertedChain.id, symbol: token.symbol },
      })
      if (existing) {
        await db.gasTokenConfig.update({ where: { id: existing.id }, data: { ...token, chainConfigId: upsertedChain.id } })
        console.log(`  ↺ Token updated: ${token.symbol}`)
      } else {
        await db.gasTokenConfig.create({ data: { ...token, chainConfigId: upsertedChain.id } })
        console.log(`  + Token created: ${token.symbol}`)
      }
    }
  }

  console.log('\n✅ Gas chain/token seed complete.')
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => db.$disconnect())
