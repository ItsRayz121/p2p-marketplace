/**
 * Seed script: populate GasChainConfig + GasTokenConfig with initial data.
 * Run with: npx ts-node --project tsconfig.json prisma/seed-gas-chains.ts
 *
 * Idempotent:
 *   - Chains are upserted by slug. platformFeePercent is NEVER overwritten on update.
 *   - Tokens are upserted by (chainConfigId, symbol). Existing token config is preserved
 *     (only displayOrder and name are updated) so admin-edited values survive re-runs.
 */

import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

interface TokenSeed {
  name: string
  symbol: string
  tokenType: 'native' | 'token'
  priceSymbol: string
  minAmount: number
  maxUsdValue: number
  presetAmounts: number[]
  isActive: boolean
  displayOrder: number
  contractAddress?: string
}

interface ChainSeed {
  slug: string
  name: string
  symbol: string
  category: string
  networkLabel: string
  addressType: string
  explorerBase: string
  backendChainId: string | null
  isActive: boolean
  displayOrder: number
  tokens: TokenSeed[]
}

const chains: ChainSeed[] = [
  // ─────────────────────────────────────────────────────────────
  // TRON — live
  // ─────────────────────────────────────────────────────────────
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
      {
        name: 'USDT (TRC20)',
        symbol: 'USDT',
        tokenType: 'token',
        priceSymbol: 'USDT',
        contractAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
        minAmount: 1,
        maxUsdValue: 10,
        presetAmounts: [1, 2, 5, 10],
        isActive: true,
        displayOrder: 2,
      },
      {
        name: 'USDC (TRC20)',
        symbol: 'USDC',
        tokenType: 'token',
        priceSymbol: 'USDC',
        contractAddress: 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8',
        minAmount: 1,
        maxUsdValue: 10,
        presetAmounts: [1, 2, 5, 10],
        isActive: true,
        displayOrder: 3,
      },
    ],
  },

  // ─────────────────────────────────────────────────────────────
  // BNB Smart Chain — live
  // ─────────────────────────────────────────────────────────────
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
      {
        name: 'USDC (BEP20)',
        symbol: 'USDC',
        tokenType: 'token',
        priceSymbol: 'USDC',
        contractAddress: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
        minAmount: 1,
        maxUsdValue: 10,
        presetAmounts: [1, 2, 5, 10],
        isActive: true,
        displayOrder: 2,
      },
      {
        name: 'opBNB Gas',
        symbol: 'opBNB',
        tokenType: 'native',
        priceSymbol: 'BNB',
        minAmount: 0.005,
        maxUsdValue: 10,
        presetAmounts: [0.005, 0.01, 0.02, 0.05],
        isActive: false,
        displayOrder: 3,
      },
    ],
  },

  // ─────────────────────────────────────────────────────────────
  // Ethereum — live
  // ─────────────────────────────────────────────────────────────
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
      {
        name: 'USDT (ERC20)',
        symbol: 'USDT',
        tokenType: 'token',
        priceSymbol: 'USDT',
        contractAddress: '0xdac17f958d2ee523a2206206994597c13d831ec7',
        minAmount: 1,
        maxUsdValue: 10,
        presetAmounts: [1, 2, 5, 10],
        isActive: true,
        displayOrder: 2,
      },
      {
        name: 'USDC (ERC20)',
        symbol: 'USDC',
        tokenType: 'token',
        priceSymbol: 'USDC',
        contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        minAmount: 1,
        maxUsdValue: 10,
        presetAmounts: [1, 2, 5, 10],
        isActive: true,
        displayOrder: 3,
      },
    ],
  },

  // ─────────────────────────────────────────────────────────────
  // Base — soon
  // ─────────────────────────────────────────────────────────────
  {
    slug: 'BASE',
    name: 'Base',
    symbol: 'ETH',
    category: 'ethereum',
    networkLabel: 'Base',
    addressType: 'EVM',
    explorerBase: 'https://basescan.org',
    backendChainId: 'BASE',
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
      {
        name: 'USDT (Base)',
        symbol: 'USDT',
        tokenType: 'token',
        priceSymbol: 'USDT',
        contractAddress: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
        minAmount: 1,
        maxUsdValue: 10,
        presetAmounts: [1, 2, 5, 10],
        isActive: false,
        displayOrder: 2,
      },
      {
        name: 'USDC (Base)',
        symbol: 'USDC',
        tokenType: 'token',
        priceSymbol: 'USDC',
        contractAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        minAmount: 1,
        maxUsdValue: 10,
        presetAmounts: [1, 2, 5, 10],
        isActive: false,
        displayOrder: 3,
      },
    ],
  },

  // ─────────────────────────────────────────────────────────────
  // Arbitrum — soon
  // ─────────────────────────────────────────────────────────────
  {
    slug: 'ARB',
    name: 'Arbitrum',
    symbol: 'ETH',
    category: 'ethereum',
    networkLabel: 'Arbitrum',
    addressType: 'EVM',
    explorerBase: 'https://arbiscan.io',
    backendChainId: 'ARB',
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
      {
        name: 'USDT (Arbitrum)',
        symbol: 'USDT',
        tokenType: 'token',
        priceSymbol: 'USDT',
        contractAddress: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
        minAmount: 1,
        maxUsdValue: 10,
        presetAmounts: [1, 2, 5, 10],
        isActive: false,
        displayOrder: 2,
      },
      {
        name: 'USDC (Arbitrum)',
        symbol: 'USDC',
        tokenType: 'token',
        priceSymbol: 'USDC',
        contractAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
        minAmount: 1,
        maxUsdValue: 10,
        presetAmounts: [1, 2, 5, 10],
        isActive: false,
        displayOrder: 3,
      },
    ],
  },

  // ─────────────────────────────────────────────────────────────
  // Optimism — soon
  // ─────────────────────────────────────────────────────────────
  {
    slug: 'OP',
    name: 'Optimism',
    symbol: 'ETH',
    category: 'ethereum',
    networkLabel: 'Optimism',
    addressType: 'EVM',
    explorerBase: 'https://optimistic.etherscan.io',
    backendChainId: 'OP',
    isActive: false,
    displayOrder: 6,
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
      {
        name: 'USDT (Optimism)',
        symbol: 'USDT',
        tokenType: 'token',
        priceSymbol: 'USDT',
        contractAddress: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
        minAmount: 1,
        maxUsdValue: 10,
        presetAmounts: [1, 2, 5, 10],
        isActive: false,
        displayOrder: 2,
      },
      {
        name: 'USDC (Optimism)',
        symbol: 'USDC',
        tokenType: 'token',
        priceSymbol: 'USDC',
        contractAddress: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
        minAmount: 1,
        maxUsdValue: 10,
        presetAmounts: [1, 2, 5, 10],
        isActive: false,
        displayOrder: 3,
      },
    ],
  },

  // ─────────────────────────────────────────────────────────────
  // Polygon — soon
  // ─────────────────────────────────────────────────────────────
  {
    slug: 'MATIC',
    name: 'Polygon',
    symbol: 'POL',
    category: 'polygon',
    networkLabel: 'Polygon',
    addressType: 'EVM',
    explorerBase: 'https://polygonscan.com',
    backendChainId: 'MATIC',
    isActive: false,
    displayOrder: 7,
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
      {
        name: 'USDT (Polygon)',
        symbol: 'USDT',
        tokenType: 'token',
        priceSymbol: 'USDT',
        contractAddress: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
        minAmount: 1,
        maxUsdValue: 10,
        presetAmounts: [1, 2, 5, 10],
        isActive: false,
        displayOrder: 2,
      },
      {
        name: 'USDC (Polygon)',
        symbol: 'USDC',
        tokenType: 'token',
        priceSymbol: 'USDC',
        contractAddress: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
        minAmount: 1,
        maxUsdValue: 10,
        presetAmounts: [1, 2, 5, 10],
        isActive: false,
        displayOrder: 3,
      },
    ],
  },

  // ─────────────────────────────────────────────────────────────
  // Solana — soon
  // ─────────────────────────────────────────────────────────────
  {
    slug: 'SOL',
    name: 'Solana',
    symbol: 'SOL',
    category: 'solana',
    networkLabel: 'Solana',
    addressType: 'SOL',
    explorerBase: 'https://solscan.io',
    backendChainId: 'SOL',
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
      {
        name: 'USDT (Solana)',
        symbol: 'USDT',
        tokenType: 'token',
        priceSymbol: 'USDT',
        contractAddress: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
        minAmount: 1,
        maxUsdValue: 10,
        presetAmounts: [1, 2, 5, 10],
        isActive: false,
        displayOrder: 2,
      },
      {
        name: 'USDC (Solana)',
        symbol: 'USDC',
        tokenType: 'token',
        priceSymbol: 'USDC',
        contractAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        minAmount: 1,
        maxUsdValue: 10,
        presetAmounts: [1, 2, 5, 10],
        isActive: false,
        displayOrder: 3,
      },
    ],
  },

  // ─────────────────────────────────────────────────────────────
  // SUI — soon
  // ─────────────────────────────────────────────────────────────
  {
    slug: 'SUI',
    name: 'SUI',
    symbol: 'SUI',
    category: 'sui',
    networkLabel: 'SUI',
    addressType: 'SUI',
    explorerBase: 'https://suiscan.xyz',
    backendChainId: 'SUI',
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
      {
        name: 'USDT (SUI)',
        symbol: 'USDT',
        tokenType: 'token',
        priceSymbol: 'USDT',
        minAmount: 1,
        maxUsdValue: 10,
        presetAmounts: [1, 2, 5, 10],
        isActive: false,
        displayOrder: 2,
      },
      {
        name: 'USDC (SUI)',
        symbol: 'USDC',
        tokenType: 'token',
        priceSymbol: 'USDC',
        minAmount: 1,
        maxUsdValue: 10,
        presetAmounts: [1, 2, 5, 10],
        isActive: false,
        displayOrder: 3,
      },
    ],
  },

  // ─────────────────────────────────────────────────────────────
  // Avalanche — soon
  // ─────────────────────────────────────────────────────────────
  {
    slug: 'AVAX',
    name: 'Avalanche',
    symbol: 'AVAX',
    category: 'avalanche',
    networkLabel: 'Avalanche C-Chain',
    addressType: 'EVM',
    explorerBase: 'https://snowtrace.io',
    backendChainId: 'AVAX',
    isActive: false,
    displayOrder: 10,
    tokens: [
      {
        name: 'AVAX',
        symbol: 'AVAX',
        tokenType: 'native',
        priceSymbol: 'AVAX',
        minAmount: 0.1,
        maxUsdValue: 10,
        presetAmounts: [0.1, 0.2, 0.5, 1],
        isActive: false,
        displayOrder: 1,
      },
      {
        name: 'USDT (Avalanche)',
        symbol: 'USDT',
        tokenType: 'token',
        priceSymbol: 'USDT',
        contractAddress: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7',
        minAmount: 1,
        maxUsdValue: 10,
        presetAmounts: [1, 2, 5, 10],
        isActive: false,
        displayOrder: 2,
      },
      {
        name: 'USDC (Avalanche)',
        symbol: 'USDC',
        tokenType: 'token',
        priceSymbol: 'USDC',
        contractAddress: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
        minAmount: 1,
        maxUsdValue: 10,
        presetAmounts: [1, 2, 5, 10],
        isActive: false,
        displayOrder: 3,
      },
    ],
  },

  // ─────────────────────────────────────────────────────────────
  // TON — soon
  // ─────────────────────────────────────────────────────────────
  {
    slug: 'TON',
    name: 'TON',
    symbol: 'TON',
    category: 'ton',
    networkLabel: 'TON',
    addressType: 'TON',
    explorerBase: 'https://tonscan.org',
    backendChainId: 'TON',
    isActive: false,
    displayOrder: 11,
    tokens: [
      {
        name: 'TON',
        symbol: 'TON',
        tokenType: 'native',
        priceSymbol: 'TON',
        minAmount: 0.5,
        maxUsdValue: 10,
        presetAmounts: [0.5, 1, 2, 5],
        isActive: false,
        displayOrder: 1,
      },
      {
        name: 'USDT (TON)',
        symbol: 'USDT',
        tokenType: 'token',
        priceSymbol: 'USDT',
        contractAddress: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs',
        minAmount: 1,
        maxUsdValue: 10,
        presetAmounts: [1, 2, 5, 10],
        isActive: false,
        displayOrder: 2,
      },
      {
        name: 'USDC (TON)',
        symbol: 'USDC',
        tokenType: 'token',
        priceSymbol: 'USDC',
        minAmount: 1,
        maxUsdValue: 10,
        presetAmounts: [1, 2, 5, 10],
        isActive: false,
        displayOrder: 3,
      },
    ],
  },
]

async function main() {
  for (const chain of chains) {
    const { tokens, ...chainData } = chain

    // Upsert chain — on update do NOT overwrite platformFeeUsdt (admin may have changed it)
    const { platformFeeUsdt: _ignored, ...updateData } = {
      platformFeeUsdt: 0.25, // only used for create; excluded from update below
      ...chainData,
    }
    const upsertedChain = await db.gasChainConfig.upsert({
      where:  { slug: chainData.slug },
      create: { ...chainData, platformFeeUsdt: 0.25 },
      update: updateData,
    })
    console.log(`✓ Chain: ${upsertedChain.name} (${upsertedChain.slug})`)

    for (const token of tokens) {
      const existing = await db.gasTokenConfig.findFirst({
        where: { chainConfigId: upsertedChain.id, symbol: token.symbol },
      })

      if (existing) {
        // Only update non-admin-editable fields (display order, name label).
        // Preserve: isActive, minAmount, maxUsdValue, presetAmounts (admin may have tuned these).
        await db.gasTokenConfig.update({
          where: { id: existing.id },
          data:  { name: token.name, displayOrder: token.displayOrder, priceSymbol: token.priceSymbol, tokenType: token.tokenType, contractAddress: token.contractAddress ?? null },
        })
        console.log(`  ↺ Token updated: ${token.symbol} (${token.name})`)
      } else {
        await db.gasTokenConfig.create({
          data: { ...token, chainConfigId: upsertedChain.id },
        })
        console.log(`  + Token created: ${token.symbol} (${token.name})`)
      }
    }
  }

  console.log('\n✅ Gas chain/token seed complete.')
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => db.$disconnect())
