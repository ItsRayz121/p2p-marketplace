import { logger } from './logger'
import { env } from './env'
import { getAllChains, getMoralisStreamId } from '../services/chainRegistry.service'
import { getStreamMetadata } from './moralisClient'

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
}
