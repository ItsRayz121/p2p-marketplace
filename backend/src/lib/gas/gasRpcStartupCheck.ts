import { db } from '../prisma'
import { logger } from '../logger'
import { fromDbChain, GAS_CHAINS } from './gas.chains'

// These are the fallback public endpoints baked into env.ts defaults.
// In production, operators should set dedicated RPC URLs — these shared
// nodes are rate-limited and may be unreachable from Railway.
const PUBLIC_DEFAULT_RPCS = new Set([
  'https://api.trongrid.io',
  'https://eth.llamarpc.com',
  'https://bsc-dataseed.binance.org',
  'https://polygon-bor-rpc.publicnode.com',
  'https://arb1.arbitrum.io/rpc',
  'https://mainnet.optimism.io',
  'https://mainnet.base.org',
  'https://api.avax.network/ext/bc/C/rpc',
])

export async function reportGasRpcStartupStatus(): Promise<void> {
  try {
    const activeWallets = await db.gasHotWallet.findMany({ where: { isActive: true } })
    if (activeWallets.length === 0) {
      logger.info('Gas RPC startup check: no active hot wallets')
      return
    }

    for (const w of activeWallets) {
      const chain = fromDbChain(w.chain)
      const cfg = GAS_CHAINS[chain]
      if (!cfg) {
        logger.warn({ chain: w.chain }, 'Gas RPC startup check: no chain config found — chain may be unsupported')
        continue
      }

      const rpcUrl = cfg.getRpcUrl()

      if (!rpcUrl) {
        logger.error(
          { chain: w.chain },
          `Gas RPC for ${w.chain} is NOT configured — set the RPC URL env var in Railway to enable balance monitoring`,
        )
        continue
      }

      if (PUBLIC_DEFAULT_RPCS.has(rpcUrl)) {
        logger.warn(
          { chain: w.chain, rpcUrl },
          `Gas RPC for ${w.chain} is using the public default endpoint — set a dedicated RPC URL in Railway for reliability`,
        )
      } else {
        // Mask any API key path segments before logging
        const safeUrl = rpcUrl.replace(/\/[^/]*(?:key|token|apikey)[^/]*/i, '/***')
        logger.info({ chain: w.chain, rpcUrl: safeUrl }, `Gas RPC for ${w.chain} configured`)
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Gas RPC startup check failed (non-fatal)')
  }
}
