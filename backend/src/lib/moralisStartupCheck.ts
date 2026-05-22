import { logger } from './logger'
import { env } from './env'
import { getAllChains, getMoralisStreamId } from '../services/chainRegistry.service'
import { getStreamMetadata, addAddressToStream } from './moralisClient'
import { db } from './prisma'

/**
 * Best-effort startup check for Moralis Streams configuration. NEVER throws —
 * a Moralis outage or a half-configured stream must not prevent the backend
 * from booting. Instead we log a structured ops report so it's obvious what's
 * missing without leaking the API key.
 */
export async function reportMoralisStartupStatus(): Promise<void> {
  if (!env.MORALIS_API_KEY) {
    logger.warn('MORALIS_API_KEY not set — deposit detection disabled')
    return
  }

  const report: Array<{ chain: string; streamConfigured: boolean; reachable: boolean | null; error: string | null }> = []
  const evmChains = (await getAllChains()).filter((c) => c.family === 'EVM')
  for (const chain of evmChains) {
    const streamId = getMoralisStreamId(chain.id)
    if (!streamId) {
      report.push({ chain: chain.id, streamConfigured: false, reachable: null, error: null })
      continue
    }
    try {
      const meta = await getStreamMetadata(streamId)
      report.push({ chain: chain.id, streamConfigured: true, reachable: meta !== null, error: null })
    } catch (err) {
      report.push({
        chain: chain.id,
        streamConfigured: true,
        reachable: false,
        error: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
      })
    }
  }

  const configured = report.filter((r) => r.streamConfigured).length
  const reachable = report.filter((r) => r.reachable === true).length
  logger.info({ report, configured, reachable, totalChains: report.length }, 'Moralis Streams startup status')

  // Also subscribe all active hot wallets so direct top-ups fire webhooks
  void subscribeHotWalletsToStreams()
}

// GasHotWallet.chain enum → Moralis stream slug used by getMoralisStreamId()
const HOT_WALLET_CHAIN_TO_SLUG: Record<string, string> = {
  BSC:  'bsc',
  ETH:  'ethereum',
  MATIC:'polygon',
  ARB:  'arbitrum',
  OP:   'optimism',
  BASE: 'base',
  AVAX: 'avalanche',
}

/**
 * Subscribe every active hot wallet address to its chain's Moralis Stream so
 * that direct top-ups (admin sends native tokens to the hot wallet) trigger
 * the /webhooks/deposit handler and get recorded as ledger entries.
 *
 * Best-effort — never throws. Called from reportMoralisStartupStatus().
 */
export async function subscribeHotWalletsToStreams(): Promise<void> {
  if (!env.MORALIS_API_KEY) return

  let wallets: Array<{ chain: string; address: string }> = []
  try {
    wallets = await db.gasHotWallet.findMany({
      where: { isActive: true },
      select: { chain: true, address: true },
    })
  } catch (err) {
    logger.warn({ err }, 'subscribeHotWalletsToStreams: failed to load wallets from DB')
    return
  }

  for (const w of wallets) {
    const slug = HOT_WALLET_CHAIN_TO_SLUG[w.chain]
    if (!slug) continue  // TRON, APT, SOL etc. — not EVM, no Moralis stream

    const streamId = getMoralisStreamId(slug)
    if (!streamId) {
      logger.warn({ chain: w.chain }, 'No Moralis stream ID configured for hot wallet chain — set MORALIS_STREAM_ID_* env var')
      continue
    }

    try {
      await addAddressToStream(streamId, w.address)
      logger.info(
        { chain: w.chain, address: `${w.address.slice(0, 8)}…` },
        'Hot wallet subscribed to Moralis stream',
      )
    } catch (err) {
      logger.warn(
        { chain: w.chain, err: err instanceof Error ? err.message : String(err) },
        'Failed to subscribe hot wallet to Moralis stream (non-fatal)',
      )
    }
  }
}
