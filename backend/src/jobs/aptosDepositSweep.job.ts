// Aptos deposit → hot-wallet straggler sweep.
//
// Runs every ~10 min. Walks every per-user Aptos deposit address and sweeps any
// that still holds USDT into the Aptos hot wallet, so auto-withdrawals always
// have a funded place to pay from (EVM parity). The post-credit hook in
// aptosDepositPoller.job.ts handles the fresh case; this is the backstop for
// deposits received before the sweep existed, or that the hook missed.
//
// Idempotent + self-limiting: see aptosDepositSweep.service.ts. A quiet run
// (nothing to sweep) is the normal steady state.

import { redis } from '../lib/redis'
import { logger } from '../lib/logger'
import { createAdminNotif } from '../services/adminNotification.service'
import { sweepAllAptosDepositStragglers } from '../services/aptosDepositSweep.service'

const HEARTBEAT_KEY = 'poller_heartbeat:APTOS_DEPOSIT_SWEEP'
// Alert admins at most once/day if the straggler pass keeps failing addresses.
const FAIL_ALERT_KEY = 'aptos_deposit_sweep:fail_alert'
const FAIL_ALERT_TTL_SEC = 24 * 60 * 60

async function writeHeartbeat(payload: Record<string, unknown>): Promise<void> {
  try {
    await redis.set(HEARTBEAT_KEY, JSON.stringify({ ...payload, at: new Date().toISOString() }))
  } catch {
    /* best-effort */
  }
}

export async function runAptosDepositSweepStragglers(): Promise<void> {
  const summary = await sweepAllAptosDepositStragglers()

  if (summary.swept > 0) {
    logger.info(summary, 'aptosDepositSweep.job: swept straggler deposits to the hot wallet')
  }
  await writeHeartbeat({ ok: true, ...summary })

  if (summary.failed > 0) {
    const already = await redis.get(FAIL_ALERT_KEY).catch(() => null)
    if (!already) {
      await redis.set(FAIL_ALERT_KEY, '1', 'EX', FAIL_ALERT_TTL_SEC).catch(() => {})
      void createAdminNotif({
        category: 'SYSTEM',
        title: 'Aptos deposit sweep — some addresses failed',
        body: `The Aptos straggler sweep could not move USDT off ${summary.failed} deposit address(es) this run (scanned ${summary.scanned}, swept ${summary.swept}). Common causes: Aptos hot wallet low on APT gas, or a fullnode/indexer outage. Check /admin/gas balances and the APTOS_DEPOSIT_SWEEP heartbeat.`,
        href: '/admin/gas',
        metadata: { ...summary },
      })
    }
  }
}
