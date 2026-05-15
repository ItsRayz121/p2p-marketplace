import { processSettlementCycles } from '../lib/gas/gas.merchant-settlement'
import { logger } from '../lib/logger'

export async function runMerchantSettlementJob(): Promise<void> {
  logger.info('Merchant settlement cycle starting')
  const created = await processSettlementCycles()
  logger.info({ created }, 'Merchant settlement cycle complete')
}
