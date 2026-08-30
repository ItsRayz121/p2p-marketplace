/**
 * Run the Aptos deposit → hot-wallet sweep on demand.
 *
 * On Aptos the withdrawal hot wallet is never funded directly — its only USDT
 * source is sweeping user per-user deposit addresses. This is the same pass the
 * ~10-min straggler job runs; use it to consolidate liquidity immediately when a
 * withdrawal is failing with "insufficient balance" on the USDT leg.
 *
 * Walks every per-user Aptos deposit address, tops each up with a little APT for
 * gas from the hot wallet, and transfers its full USDT balance to the hot wallet.
 * Idempotent (per-address claim lock + tx-hash-keyed ledger) — safe to re-run.
 * Bounded per run by APTOS_SWEEP_STRAGGLER_BATCH; re-run until `swept` is 0.
 *
 * Run on the target DB (e.g. Railway):  npm run aptos:sweep
 */

import { sweepAllAptosDepositStragglers } from '../services/aptosDepositSweep.service'

async function main() {
  console.log('— Aptos deposit → hot-wallet sweep —\n')
  const summary = await sweepAllAptosDepositStragglers()
  console.log(JSON.stringify(summary, null, 2))
  if (summary.scanned === 0) {
    console.log('\nNothing to do — custody/hot wallet not configured, or no Aptos deposit addresses.')
  } else if (summary.swept > 0) {
    console.log(`\n✅ Swept ${summary.swept} address(es), ${summary.totalUsdt} USDT total into the hot wallet.`)
    console.log('   Re-run if `swept` hit the per-run batch cap and more addresses still hold USDT.')
  } else {
    console.log('\n✅ No addresses needed sweeping (hot wallet already holds the deposited USDT).')
    if (summary.failed > 0) {
      console.log(`   ⚠ ${summary.failed} address(es) FAILED — likely the hot wallet is low on APT for gas top-ups. Fund it and re-run.`)
    }
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .then(() => process.exit(0))
