import { logger } from '../lib/logger'
import { runPortfolioSnapshots } from '../services/portfolioSnapshot.service'

/** Every 6 hours: store one value point per user with an active portfolio tracking period (see portfolioSnapshot.service.ts). */
export async function runPortfolioSnapshotJob(): Promise<void> {
  const r = await runPortfolioSnapshots()
  logger.info(r, 'Portfolio snapshots recorded')
}
