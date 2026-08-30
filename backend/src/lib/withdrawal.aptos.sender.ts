/**
 * Automated Aptos USDT withdrawal sender — the non-EVM twin of
 * withdrawal.sender.ts (sendWithdrawalOnChain).
 *
 * Sends native Tether (fungible asset, 6 dp) from the gas hot wallet for
 * Tier-1 auto-approved withdrawals on the Aptos network. Called from
 * sendWithdrawalOnChain() (dispatch) and re-driven by the confirmation watcher's
 * orphan-recovery pass.
 *
 * INVARIANT (matches EVM): the platform fee was already deducted from the user's
 * balance at request time — only `wd.amount` goes on-chain here, never amount+fee.
 *
 * On success: withdrawal → sent, pending Transaction → completed, fee ledgered.
 * On failure / low gas: withdrawal stays auto_approved and admins are alerted.
 */

import { randomBytes } from 'node:crypto'
import { db } from './prisma'
import { env } from './env'
import { redis } from './redis'
import { logger as log } from './logger'
import { createAdminNotif } from '../services/adminNotification.service'
import { withHotWalletLock } from './hotWalletLock'
import { getAptosHotWalletAddress } from './gas/aptosWalletService'
import { getAptosNativeBalance, getAptosUsdtAsset } from './gas/aptosRefund'
import { sendAptosFungibleAsset, usdtToAptosBaseUnits } from './gas/aptosTransfer'
import { getHotWalletTokenBalance } from './gas/gas.tokenBalance'
import { sweepAptosDeposit, sweepAptosDepositsUntilFunded } from '../services/aptosDepositSweep.service'
import { finalizeWithdrawalSent } from './withdrawal.finalize'

interface AutoWithdrawal {
  id: string
  userId: string
  coin: string
  network: string
  amount: number | string
  fee?: number | string
  toAddress: string
}

// Redis claim key guards the crash window between broadcast and DB finalize:
// while it is held (or until it self-expires) the recovery pass will not
// re-drive this row. 3 min comfortably covers submit + waitForTransaction.
const CLAIM_TTL_MS = 180_000
const claimKey = (id: string) => `withdrawal:aptos:claim:${id}`

export function aptosWithdrawalClaimHeld(id: string): Promise<boolean> {
  return redis.exists(claimKey(id)).then((n) => n === 1)
}

// One shortfall alert per withdrawal per 3h — the recovery pass retries this row
// every ~5 min, and we don't want an admin-notification storm while the operator
// is topping the hot wallet up.
const SHORTFALL_ALERT_TTL_SEC = 3 * 60 * 60

/**
 * Alert admins that the Aptos hot wallet genuinely can't cover a withdrawal even
 * after sweeping every funded deposit address — i.e. a real USDT liquidity
 * shortfall that only a manual top-up (or Reject/refund) resolves. Gives the
 * concrete numbers + the address + the FA metadata so the operator knows exactly
 * what to send, instead of decoding a raw Move abort.
 */
async function alertAptosUsdtShortfall(p: {
  withdrawalId: string
  have: number
  need: number
  hotAddress: string
  assetAddr: string
}): Promise<void> {
  const first = await redis
    .set(`withdrawal:aptos:shortfall:${p.withdrawalId}`, '1', 'EX', SHORTFALL_ALERT_TTL_SEC, 'NX')
    .catch(() => 'OK')
  if (first !== 'OK') return
  const gap = Math.max(0, p.need - p.have)
  void createAdminNotif({
    category: 'WITHDRAWAL',
    title: 'Aptos hot wallet USDT liquidity shortfall — top-up required',
    body:
      `Withdrawal ${p.withdrawalId} needs ${p.need} USDT on Aptos but the hot wallet holds only ${p.have.toFixed(6)} USDT ` +
      `even after sweeping every funded deposit address (short by ~${gap.toFixed(6)}). ` +
      `Send at least ${gap.toFixed(2)} USDT (native Tether, fungible-asset metadata ${p.assetAddr}, 6 dp) to the Aptos hot wallet ${p.hotAddress} — ` +
      `it retries automatically once funded — or Reject to refund the user.`,
    href: '/admin/withdrawals',
    metadata: { withdrawalId: p.withdrawalId, haveUsdt: p.have, needUsdt: p.need, hotAddress: p.hotAddress },
    email: true,
  })
}

export async function sendAptosWithdrawalOnChain(wd: AutoWithdrawal): Promise<void> {
  if (wd.coin.toUpperCase() !== 'USDT') {
    log.warn({ withdrawalId: wd.id, coin: wd.coin }, 'sendAptosWithdrawalOnChain: only USDT is supported on Aptos')
    void createAdminNotif({
      category: 'WITHDRAWAL',
      title: 'Auto-withdrawal skipped — unsupported Aptos asset',
      body: `Withdrawal ${wd.id} (${wd.amount} ${wd.coin} on Aptos) cannot be auto-sent — only USDT is supported on Aptos. Send manually then Mark Sent, or Reject to refund.`,
      href: '/admin/withdrawals',
      metadata: { withdrawalId: wd.id },
      email: true,
    })
    return
  }

  const hotAddress = getAptosHotWalletAddress()
  if (!hotAddress) {
    log.warn({ withdrawalId: wd.id }, 'sendAptosWithdrawalOnChain: gas wallet not configured')
    void createAdminNotif({
      category: 'WITHDRAWAL',
      title: 'Auto-withdrawal skipped — Aptos hot wallet not configured',
      body: `Withdrawal ${wd.id} (${wd.amount} ${wd.coin} on Aptos) is auto-approved but the gas wallet seed is not configured. Send manually then Mark Sent (Manual Fallback), or Reject to refund.`,
      href: '/admin/withdrawals',
      metadata: { withdrawalId: wd.id },
      email: true,
    })
    return
  }

  // ── Gas pre-flight ─────────────────────────────────────────────────────────
  // Aptos charges tx gas in native APT. A USDT transfer that can't pay gas will
  // fail on submit; catch it here, alert, and leave the row auto_approved so the
  // recovery pass retries once the wallet is funded.
  try {
    const aptBalance = await getAptosNativeBalance(hotAddress)
    if (aptBalance < env.GAS_APTOS_MIN_APT) {
      log.warn(
        { withdrawalId: wd.id, aptBalance, min: env.GAS_APTOS_MIN_APT },
        'sendAptosWithdrawalOnChain: insufficient APT gas — skipping auto-send',
      )
      void createAdminNotif({
        category: 'WITHDRAWAL',
        title: 'Auto-withdrawal skipped — Aptos hot wallet low on APT gas',
        body: `Withdrawal ${wd.id} (${wd.amount} ${wd.coin} on Aptos) cannot be auto-sent: hot wallet has ${aptBalance.toFixed(6)} APT but needs at least ${env.GAS_APTOS_MIN_APT} APT for gas. Top up ${hotAddress}, then it retries automatically — or Reject to refund.`,
        href: '/admin/withdrawals',
        metadata: { withdrawalId: wd.id, aptBalance, minApt: env.GAS_APTOS_MIN_APT },
      })
      return
    }
  } catch (err) {
    // Non-fatal: proceed and let the submit fail naturally if gas is truly short.
    log.warn({ err, withdrawalId: wd.id }, 'sendAptosWithdrawalOnChain: APT gas pre-check errored, proceeding anyway')
  }

  // ── USDT liquidity pre-flight (self-healing) ───────────────────────────────
  // Aptos deposits credit the user's internal balance but leave the on-chain
  // USDT on their per-user deposit address — and the Aptos hot wallet is NEVER
  // funded directly (unlike EVM), so its only USDT source is user deposits. If
  // it can't cover this withdrawal:
  //   1. sweep the withdrawing user's own deposit address (usual source);
  //   2. still short → sweep the WIDER pool of deposit addresses (covers users
  //      whose balance came from a trade or another chain — their own Aptos
  //      address is empty), biggest balances first;
  //   3. still short → genuine liquidity shortfall: alert with the real reason
  //      instead of letting the operator see only a raw Move abort.
  // Every step here is non-fatal: the send below still fails-and-alerts if the
  // hot wallet is genuinely short, and the 10-min straggler sweep is the backstop.
  try {
    const assetAddr = await getAptosUsdtAsset()
    const need = Number(wd.amount)
    const readHotUsdt = async () => {
      const { balance } = await getHotWalletTokenBalance('APT', assetAddr, hotAddress, 6)
      return balance
    }

    let hotUsdt = await readHotUsdt()
    if (hotUsdt < need) {
      log.warn(
        { withdrawalId: wd.id, hotUsdt, needed: need },
        'sendAptosWithdrawalOnChain: hot wallet short on USDT — sweeping user deposit address first',
      )
      const swept = await sweepAptosDeposit({ userId: wd.userId, reason: `withdrawal-preflight:${wd.id}` })
      log.info({ withdrawalId: wd.id, sweep: swept }, 'sendAptosWithdrawalOnChain: pre-flight per-user sweep result')
      hotUsdt = await readHotUsdt().catch(() => hotUsdt)

      if (hotUsdt < need) {
        const pool = await sweepAptosDepositsUntilFunded({
          neededUsdt: need,
          reason: `withdrawal-preflight-pool:${wd.id}`,
        })
        log.info({ withdrawalId: wd.id, pool }, 'sendAptosWithdrawalOnChain: pre-flight pool sweep result')
        hotUsdt = pool.hotUsdtAfter ?? (await readHotUsdt().catch(() => hotUsdt))
      }

      if (hotUsdt < need) {
        await alertAptosUsdtShortfall({ withdrawalId: wd.id, have: hotUsdt, need, hotAddress, assetAddr })
      }
    }
  } catch (err) {
    log.warn({ err, withdrawalId: wd.id }, 'sendAptosWithdrawalOnChain: USDT pre-flight sweep errored, proceeding anyway')
  }

  // ── Serialize + de-dupe, then broadcast ────────────────────────────────────
  // All outbound sends from the shared Aptos hot-wallet account go through the
  // same per-account mutex (gas delivery + refunds use it too) so concurrent
  // sends can't collide on the account sequence number.
  let txHash: string
  let claimedByUs = false
  const token = randomBytes(16).toString('hex')
  try {
    txHash = await withHotWalletLock('aptos', async () => {
      // Re-read inside the lock: a concurrent send / admin action may have
      // already moved this row on.
      const fresh = await db.withdrawal.findUnique({
        where: { id: wd.id },
        select: { status: true, txHash: true },
      })
      if (!fresh || fresh.status !== 'auto_approved' || fresh.txHash) {
        log.info({ withdrawalId: wd.id, status: fresh?.status }, 'sendAptosWithdrawalOnChain: row not auto_approved, skipping')
        return '' // sentinel — nothing to do
      }

      // Crash-window claim: if another sender already holds it, back off.
      const got = await redis.set(claimKey(wd.id), token, 'PX', CLAIM_TTL_MS, 'NX')
      if (got !== 'OK') {
        log.info({ withdrawalId: wd.id }, 'sendAptosWithdrawalOnChain: claim held by another sender, skipping')
        return ''
      }
      claimedByUs = true

      const assetAddr = await getAptosUsdtAsset()
      return sendAptosFungibleAsset({
        toAddress: wd.toAddress,
        baseUnits: usdtToAptosBaseUnits(wd.amount),
        assetAddr,
      })
    })
  } catch (err) {
    if (claimedByUs) await redis.del(claimKey(wd.id)).catch(() => {})
    const msg = err instanceof Error ? err.message : String(err)
    log.error({ err, withdrawalId: wd.id }, 'sendAptosWithdrawalOnChain: on-chain send failed')
    void createAdminNotif({
      category: 'WITHDRAWAL',
      title: 'Auto-withdrawal send FAILED — manual action required',
      body: `Withdrawal ${wd.id} (${wd.amount} ${wd.coin} on Aptos) failed to send automatically: ${msg}. Send manually from the hot wallet, then Mark Sent (Manual Fallback). Or Reject to refund the user.`,
      href: '/admin/withdrawals',
      metadata: { withdrawalId: wd.id, error: msg },
      email: true,
    })
    return
  }

  if (!txHash) return // skipped inside the lock — nothing was broadcast

  // ── DB finalize (shared with the EVM path) ────────────────────────────────
  try {
    await finalizeWithdrawalSent(wd, txHash)
    if (claimedByUs) await redis.del(claimKey(wd.id)).catch(() => {})
  } catch (err) {
    // The transfer IS on-chain. Getting the row out of 'auto_approved' is now
    // critical — otherwise the recovery pass will re-broadcast and double-send.
    log.error({ err, withdrawalId: wd.id, txHash }, 'sendAptosWithdrawalOnChain: finalize failed after successful on-chain send')
    let salvaged = false
    try {
      const r = await db.withdrawal.updateMany({
        where: { id: wd.id, status: 'auto_approved' },
        data: { status: 'sent', txHash, completedAt: new Date() },
      })
      salvaged = r.count > 0
    } catch (err2) {
      log.error({ err: err2, withdrawalId: wd.id, txHash }, 'sendAptosWithdrawalOnChain: salvage status update also failed')
    }
    // Only drop the crash-window claim once the row is safely out of
    // 'auto_approved'; otherwise keep it so recovery skips this row until an
    // admin resolves it (the claim self-expires as a last resort).
    if (salvaged && claimedByUs) await redis.del(claimKey(wd.id)).catch(() => {})
    void createAdminNotif({
      category: 'WITHDRAWAL',
      title: 'Auto-withdrawal sent on-chain but DB update failed',
      body: `Withdrawal ${wd.id} txHash ${txHash} was broadcast on Aptos${salvaged ? ' and the status was salvaged to "sent"' : ' but the status could NOT be updated'}. ${salvaged ? 'Verify the Transaction row / fee ledger.' : "Set the withdrawal to 'sent' with this txHash manually — do NOT let it be resent."}`,
      href: '/admin/withdrawals',
      metadata: { withdrawalId: wd.id, txHash, salvaged },
    })
  }
}
