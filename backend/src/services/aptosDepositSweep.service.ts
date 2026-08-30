/**
 * Aptos deposit → hot-wallet sweep.
 *
 * WHY THIS EXISTS
 * ──────────────────────────────────────────────────────────────────────────────
 * On EVM the platform keeps its hot wallet funded, so auto-withdrawals pay out
 * from it directly. On Aptos there was no equivalent path: the deposit poller
 * credits a user's INTERNAL balance, but the actual on-chain USDT stays sitting
 * on that user's per-user HD deposit address forever. The Aptos hot wallet holds
 * APT (for gas) but ≈ 0 USDT, so `sendAptosWithdrawalOnChain` fails the moment a
 * user tries to withdraw ("insufficient balance" on the USDT leg).
 *
 * This module is the missing sweep — the Aptos analogue of keeping the EVM hot
 * wallet funded. It:
 *   1. re-derives the user's deposit-address key from the stored derivationIndex
 *      and PROVES it controls the stored address before signing anything;
 *   2. tops the deposit address up with a little APT for gas from the hot wallet
 *      (serialized through withHotWalletLock('aptos') so the top-up can't
 *      sequence-collide with gas deliveries / refunds / withdrawals);
 *   3. transfers the address's full USDT balance to the Aptos hot wallet;
 *   4. writes a `deposit_sweep` ledger entry.
 *
 * Callers:
 *   - aptosDepositPoller.job.ts  — fires a sweep right after each credited deposit.
 *   - aptosDepositSweep.job.ts   — straggler pass every ~10 min; picks up any
 *     deposit address still holding USDT (including everything received before
 *     this code shipped).
 *   - withdrawal.aptos.sender.ts — withdrawal pre-flight: if the hot wallet is
 *     short on USDT, sweep that user's address first, then send. Self-healing.
 *
 * SAFETY MODEL (money movement — read before editing):
 *   - Every sweep of one deposit address is guarded by a per-address Redis claim
 *     lock, so the poller / straggler / withdrawal-preflight paths can never run
 *     two sweeps of the same address at once.
 *   - The derived key MUST match the stored DepositAddress.address — a drifted
 *     master seed or corrupt index aborts before anything is signed.
 *   - Idempotency: the USDT transfer moves whatever balance is on the address at
 *     that instant. A duplicate sweep just finds a (near-)zero balance and
 *     no-ops. The ledger entry is keyed by tx hash (sourceKey), so re-runs never
 *     double-count.
 */

import { randomBytes } from 'node:crypto'
import { db } from '../lib/prisma'
import { env } from '../lib/env'
import { redis } from '../lib/redis'
import { logger as log } from '../lib/logger'
import { walletAptosCustodyIsConfigured, deriveAptosDepositPrivateKey } from '../lib/walletCrypto'
import { decryptGasSeed, gasWalletIsConfigured } from '../lib/gas/gasWalletService'
import {
  getAptosHotWalletAddress,
  deriveAptosPrivateKeyForDelivery,
  validateAptosAddress,
  aptosAddressFromPrivateKeySeed,
} from '../lib/gas/aptosWalletService'
import { getAptosNativeBalance, getAptosUsdtAsset } from '../lib/gas/aptosRefund'
import { getHotWalletTokenBalance } from '../lib/gas/gas.tokenBalance'
import { withHotWalletLock } from '../lib/hotWalletLock'
import { appendLedgerEntry } from '../lib/gas/gas.ledger'

const APT_DECIMALS = 8
const USDT_APTOS_DECIMALS = 6

const CLAIM_TTL_MS = 180_000
const claimKey = (depositAddressId: string) => `sweep:aptos:${depositAddressId}`

/** Normalize an Aptos address to canonical 0x + 64 lowercase hex. */
function normalizeAptosAddr(addr: string): string {
  const hex = addr.replace(/^0x/i, '').toLowerCase()
  return '0x' + hex.padStart(64, '0')
}

export type AptosSweepStatus = 'swept' | 'skipped' | 'failed'

export interface AptosSweepResult {
  status: AptosSweepStatus
  /** Machine-readable reason for skipped/failed. */
  reason?: string
  depositAddress?: string
  /** Human USDT amount moved to the hot wallet (0 unless status==='swept'). */
  usdt: number
  txHash?: string
  gasTopUpTxHash?: string
}

interface AptosSdk {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  aptos: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Account: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Ed25519PrivateKey: any
}

async function makeAptosSdk(): Promise<AptosSdk> {
  const { Aptos, AptosConfig, Account, Ed25519PrivateKey } = await import('@aptos-labs/ts-sdk')
  const config = new AptosConfig({
    fullnode: env.APTOS_FULLNODE_URL,
    indexer: env.APTOS_INDEXER_URL,
    ...(env.APTOS_API_KEY ? { clientConfig: { API_KEY: env.APTOS_API_KEY } } : {}),
  })
  return { aptos: new Aptos(config), Account, Ed25519PrivateKey }
}

/**
 * Raw USDT base-unit balance (6 dp) of any Aptos address. Returns 0n when the
 * address has no primary store for the asset yet. Never throws.
 */
export async function readUsdtBaseUnits(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  aptos: any,
  owner: string,
  assetAddr: string,
): Promise<bigint> {
  try {
    const [raw] = (await aptos.view({
      payload: {
        function: '0x1::primary_fungible_store::balance',
        typeArguments: ['0x1::fungible_asset::Metadata'],
        functionArguments: [owner, assetAddr],
      },
    })) as [string | number]
    return BigInt(String(raw))
  } catch {
    return 0n
  }
}

function baseUnitsToHuman(units: bigint, decimals: number): number {
  return Number(units) / 10 ** decimals
}

/**
 * Sweep one Aptos per-user deposit address's full USDT balance into the Aptos
 * hot wallet. Resolve the address by `depositAddressId` OR `userId` (exactly one
 * required). Best-effort: returns a status object rather than throwing for the
 * expected "nothing to do" / "hot wallet short" cases; only genuinely unexpected
 * SDK failures reject.
 */
export async function sweepAptosDeposit(opts: {
  depositAddressId?: string
  userId?: string
  /** Free-text call-site tag for logs/ledger notes. */
  reason: string
}): Promise<AptosSweepResult> {
  if (!opts.depositAddressId && !opts.userId) {
    throw new Error('sweepAptosDeposit: depositAddressId or userId is required')
  }
  if (!walletAptosCustodyIsConfigured()) {
    return { status: 'skipped', reason: 'custody_unconfigured', usdt: 0 }
  }
  if (!gasWalletIsConfigured()) {
    return { status: 'skipped', reason: 'hot_wallet_unconfigured', usdt: 0 }
  }
  const hotAddress = getAptosHotWalletAddress()
  if (!hotAddress || !validateAptosAddress(hotAddress)) {
    return { status: 'skipped', reason: 'hot_wallet_address_unavailable', usdt: 0 }
  }

  const row = opts.depositAddressId
    ? await db.depositAddress.findUnique({ where: { id: opts.depositAddressId } })
    : await db.depositAddress.findUnique({
        where: { userId_chainFamily: { userId: opts.userId!, chainFamily: 'APTOS' } },
      })
  if (!row) return { status: 'skipped', reason: 'no_deposit_address', usdt: 0 }
  if (row.chainFamily !== 'APTOS') {
    return { status: 'skipped', reason: `wrong_family_${row.chainFamily}`, usdt: 0 }
  }

  const depositAddr = normalizeAptosAddr(row.address)
  if (normalizeAptosAddr(hotAddress) === depositAddr) {
    return { status: 'skipped', reason: 'self_sweep', usdt: 0 }
  }

  // ── Per-address claim lock ─────────────────────────────────────────────────
  const token = randomBytes(16).toString('hex')
  const got = await redis.set(claimKey(row.id), token, 'PX', CLAIM_TTL_MS, 'NX')
  if (got !== 'OK') {
    return { status: 'skipped', reason: 'locked', depositAddress: row.address, usdt: 0 }
  }

  try {
    const { aptos, Account, Ed25519PrivateKey } = await makeAptosSdk()
    const assetAddr = await getAptosUsdtAsset()

    // ── How much USDT is actually on the address? ────────────────────────────
    const rawUsdt = await readUsdtBaseUnits(aptos, depositAddr, assetAddr)
    const minUnits = BigInt(Math.round(env.APTOS_SWEEP_MIN_USDT * 10 ** USDT_APTOS_DECIMALS))
    if (rawUsdt < minUnits) {
      return {
        status: 'skipped',
        reason: 'below_min',
        depositAddress: row.address,
        usdt: baseUnitsToHuman(rawUsdt, USDT_APTOS_DECIMALS),
      }
    }

    // ── Re-derive the key and PROVE it controls the stored address ───────────
    let depositPriv: Buffer | null = null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let depositAccount: any
    try {
      depositPriv = deriveAptosDepositPrivateKey(row.derivationIndex)
      const derivedAddr = normalizeAptosAddr(aptosAddressFromPrivateKeySeed(depositPriv))
      if (derivedAddr !== depositAddr) {
        log.error(
          { depositAddressId: row.id, derivationIndex: row.derivationIndex, stored: row.address, derived: derivedAddr },
          'aptosDepositSweep: derived key does not control the stored address — seed drift or index corruption, ABORTING',
        )
        return { status: 'failed', reason: 'derivation_mismatch', depositAddress: row.address, usdt: 0 }
      }
      depositAccount = Account.fromPrivateKey({
        privateKey: new Ed25519PrivateKey(new Uint8Array(depositPriv)),
      })
    } finally {
      if (depositPriv) depositPriv.fill(0)
    }

    // ── Gas pre-flight: the deposit address holds no APT ─────────────────────
    let gasTopUpTxHash: string | undefined
    const depositApt = await getAptosNativeBalance(depositAddr)
    if (depositApt < env.APTOS_SWEEP_GAS_APT) {
      const hotApt = await getAptosNativeBalance(hotAddress)
      // Hot wallet must keep enough APT for the top-up AND its own alert floor.
      if (hotApt < env.APTOS_SWEEP_GAS_APT + env.GAS_APTOS_MIN_APT) {
        log.warn(
          { depositAddressId: row.id, hotApt, need: env.APTOS_SWEEP_GAS_APT + env.GAS_APTOS_MIN_APT },
          'aptosDepositSweep: hot wallet APT too low to fund the gas top-up',
        )
        return { status: 'failed', reason: 'hot_wallet_apt_low', depositAddress: row.address, usdt: 0 }
      }

      const topUpOctas = BigInt(Math.round(env.APTOS_SWEEP_GAS_APT * 10 ** APT_DECIMALS))
      const seed = decryptGasSeed()
      let hotPriv: Buffer | null = null
      try {
        hotPriv = deriveAptosPrivateKeyForDelivery(seed)
        const hotAccount = Account.fromPrivateKey({
          privateKey: new Ed25519PrivateKey(new Uint8Array(hotPriv)),
        })
        // aptos_account::transfer credits APT and auto-creates the recipient
        // account if it does not exist yet. Serialized against every other send
        // from the shared hot-wallet account (same mutex key the withdrawal
        // sender / gas delivery / refund all use).
        gasTopUpTxHash = await withHotWalletLock('aptos', async () => {
          const txn = await aptos.transaction.build.simple({
            sender: hotAccount.accountAddress,
            data: {
              function: '0x1::aptos_account::transfer',
              functionArguments: [depositAddr, topUpOctas],
            },
          })
          const pending = await aptos.signAndSubmitTransaction({ signer: hotAccount, transaction: txn })
          await aptos.waitForTransaction({ transactionHash: pending.hash })
          return pending.hash as string
        })
        log.info(
          { depositAddressId: row.id, topUpApt: env.APTOS_SWEEP_GAS_APT, txHash: gasTopUpTxHash },
          'aptosDepositSweep: gas top-up confirmed',
        )
      } finally {
        seed.fill(0)
        if (hotPriv) hotPriv.fill(0)
      }
    }

    // ── Sweep the USDT: deposit address → hot wallet ─────────────────────────
    // Re-read the balance now (a top-up tx may have landed; nothing else moves
    // this single-use address, but the read is cheap and keeps us exact).
    const sweepUnits = await readUsdtBaseUnits(aptos, depositAddr, assetAddr)
    if (sweepUnits < minUnits) {
      return {
        status: 'skipped',
        reason: 'below_min_after_topup',
        depositAddress: row.address,
        usdt: baseUnitsToHuman(sweepUnits, USDT_APTOS_DECIMALS),
        ...(gasTopUpTxHash ? { gasTopUpTxHash } : {}),
      }
    }

    // The deposit address is its own account with its own sequence number, so
    // this send does NOT contend with the hot-wallet mutex — the per-address
    // claim lock above already serializes concurrent sweeps of THIS address.
    const txn = await aptos.transaction.build.simple({
      sender: depositAccount.accountAddress,
      data: {
        function: '0x1::primary_fungible_store::transfer',
        typeArguments: ['0x1::fungible_asset::Metadata'],
        functionArguments: [assetAddr, normalizeAptosAddr(hotAddress), sweepUnits],
      },
    })
    const pending = await aptos.signAndSubmitTransaction({ signer: depositAccount, transaction: txn })
    await aptos.waitForTransaction({ transactionHash: pending.hash })
    const txHash = pending.hash as string
    const humanUsdt = baseUnitsToHuman(sweepUnits, USDT_APTOS_DECIMALS)

    log.info(
      { depositAddressId: row.id, userId: row.userId, usdt: humanUsdt, txHash, gasTopUpTxHash, reason: opts.reason },
      'aptosDepositSweep: USDT swept to hot wallet',
    )

    // Ledger: USDT inflow to the hot wallet, no native movement. chainOverride
    // pins the row to Aptos; usdAmount given so no price lookup runs.
    void appendLedgerEntry({
      entryType: 'deposit_sweep',
      chain: 'BSC', // type-level fallback only — chainOverride is authoritative
      chainOverride: { dbChain: 'APT', nativeSymbol: 'APT' },
      nativeAmount: 0,
      tokenSymbol: 'USDT',
      tokenAmount: humanUsdt,
      usdAmount: humanUsdt, // USDT ≈ 1 USD
      txHash,
      fromAddress: row.address,
      toAddress: hotAddress,
      sourceKey: `deposit_sweep:aptos:${txHash}`,
      notes: `Aptos deposit sweep for user ${row.userId} (${opts.reason}) — depositAddress ${row.id}`,
    }).catch((err) => log.error({ err, depositAddressId: row.id, txHash }, 'aptosDepositSweep: ledger write failed'))

    return {
      status: 'swept',
      depositAddress: row.address,
      usdt: humanUsdt,
      txHash,
      ...(gasTopUpTxHash ? { gasTopUpTxHash } : {}),
    }
  } catch (err) {
    log.error({ err, depositAddressId: row.id, reason: opts.reason }, 'aptosDepositSweep: unexpected failure')
    return {
      status: 'failed',
      reason: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
      depositAddress: row.address,
      usdt: 0,
    }
  } finally {
    // Only release a claim we still own (the CAD script guards against releasing
    // a lock that already expired and was re-acquired).
    try {
      await redis.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1,
        claimKey(row.id),
        token,
      )
    } catch {
      /* lock self-expires */
    }
  }
}

export interface AptosPoolSweepResult {
  /** Deposit addresses actually swept this call. */
  sweptAddresses: number
  /** Total human USDT moved into the hot wallet this call. */
  totalUsdt: number
  /** Hot-wallet USDT balance after the sweeps (null if it couldn't be re-read). */
  hotUsdtAfter: number | null
  /** True when the hot wallet still can't cover `neededUsdt` after sweeping. */
  shortfall: boolean
  /** Machine-readable note when nothing was swept. */
  reason?: string
}

/**
 * Consolidate USDT from the WIDER pool of Aptos per-user deposit addresses into
 * the hot wallet until it can cover `neededUsdt` (or the pool is exhausted).
 *
 * WHY: the per-user pre-flight sweep only drains the withdrawing user's own
 * deposit address. When their internal balance came from a P2P trade or a
 * deposit on another chain, that address is empty and the hot wallet stays dry.
 * On Aptos the hot wallet is never funded directly — its only USDT source is
 * user deposits — so a withdrawal by such a user can never be paid unless we
 * pull liquidity from every funded deposit address, the way the shared EVM hot
 * wallet already works.
 *
 * Biggest balances first, so the fewest transactions cover the target. Each
 * address still goes through `sweepAptosDeposit` (per-address claim lock, APT
 * gas top-up, derivation proof, ledger entry). Bounded per call.
 */
export async function sweepAptosDepositsUntilFunded(opts: {
  neededUsdt: number
  reason: string
  /** Hard cap on addresses touched in one call (default APTOS_SWEEP_STRAGGLER_BATCH). */
  maxAddresses?: number
}): Promise<AptosPoolSweepResult> {
  const empty: AptosPoolSweepResult = { sweptAddresses: 0, totalUsdt: 0, hotUsdtAfter: null, shortfall: true }

  if (!walletAptosCustodyIsConfigured()) return { ...empty, reason: 'custody_unconfigured' }
  if (!gasWalletIsConfigured()) return { ...empty, reason: 'hot_wallet_unconfigured' }
  const hotAddress = getAptosHotWalletAddress()
  if (!hotAddress || !validateAptosAddress(hotAddress)) {
    return { ...empty, reason: 'hot_wallet_address_unavailable' }
  }

  const assetAddr = await getAptosUsdtAsset()
  const readHotUsdt = async (): Promise<number | null> => {
    try {
      const { balance } = await getHotWalletTokenBalance('APT', assetAddr, hotAddress, USDT_APTOS_DECIMALS)
      return balance
    } catch {
      return null
    }
  }

  const hotBefore = await readHotUsdt()
  if (hotBefore != null && hotBefore >= opts.neededUsdt) {
    return { sweptAddresses: 0, totalUsdt: 0, hotUsdtAfter: hotBefore, shortfall: false, reason: 'already_funded' }
  }

  const cap = Math.max(1, opts.maxAddresses ?? env.APTOS_SWEEP_STRAGGLER_BATCH)
  const rows = await db.depositAddress.findMany({
    where: { chainFamily: 'APTOS' },
    select: { id: true, address: true },
    orderBy: { createdAt: 'asc' },
  })
  if (rows.length === 0) return { ...empty, hotUsdtAfter: hotBefore, reason: 'no_deposit_addresses' }

  const { aptos } = await makeAptosSdk()
  const minUnits = BigInt(Math.round(env.APTOS_SWEEP_MIN_USDT * 10 ** USDT_APTOS_DECIMALS))

  // Rank funded addresses by balance, biggest first.
  const funded: Array<{ id: string; units: bigint }> = []
  for (const r of rows) {
    let units: bigint
    try {
      units = await readUsdtBaseUnits(aptos, normalizeAptosAddr(r.address), assetAddr)
    } catch {
      continue // one unreadable address must not abort the scan
    }
    if (units >= minUnits) funded.push({ id: r.id, units })
  }
  funded.sort((a, b) => (a.units < b.units ? 1 : a.units > b.units ? -1 : 0))

  let sweptAddresses = 0
  let totalUsdt = 0
  let runningHot = hotBefore ?? 0
  for (const f of funded) {
    if (sweptAddresses >= cap) break
    if (runningHot >= opts.neededUsdt) break

    const res = await sweepAptosDeposit({ depositAddressId: f.id, reason: opts.reason })
    if (res.status === 'swept') {
      sweptAddresses++
      totalUsdt += res.usdt
      runningHot += res.usdt
    }
    // Gentle spacing so a burst of sweeps doesn't hammer the fullnode.
    await new Promise((rsv) => setTimeout(rsv, 400))
  }

  const hotUsdtAfter = await readHotUsdt()
  const shortfall = hotUsdtAfter == null ? runningHot < opts.neededUsdt : hotUsdtAfter < opts.neededUsdt
  return { sweptAddresses, totalUsdt, hotUsdtAfter, shortfall }
}

export interface AptosStragglerSweepSummary {
  scanned: number
  swept: number
  skipped: number
  failed: number
  totalUsdt: number
}

/**
 * Straggler pass: walk every Aptos per-user deposit address, and sweep any that
 * still holds USDT. Picks up deposits received before the auto-sweep existed and
 * any that the post-credit hook missed (process crash, transient RPC error).
 *
 * Bounded per run by APTOS_SWEEP_STRAGGLER_BATCH — the rest roll to the next run.
 */
export async function sweepAllAptosDepositStragglers(): Promise<AptosStragglerSweepSummary> {
  const summary: AptosStragglerSweepSummary = { scanned: 0, swept: 0, skipped: 0, failed: 0, totalUsdt: 0 }

  if (!walletAptosCustodyIsConfigured() || !gasWalletIsConfigured()) return summary
  const hotAddress = getAptosHotWalletAddress()
  if (!hotAddress) return summary

  const rows = await db.depositAddress.findMany({
    where: { chainFamily: 'APTOS' },
    select: { id: true, address: true },
    orderBy: { createdAt: 'asc' },
  })
  if (rows.length === 0) return summary

  const { aptos } = await makeAptosSdk()
  const assetAddr = await getAptosUsdtAsset()
  const minUnits = BigInt(Math.round(env.APTOS_SWEEP_MIN_USDT * 10 ** USDT_APTOS_DECIMALS))

  let sweptThisRun = 0
  for (const r of rows) {
    if (sweptThisRun >= env.APTOS_SWEEP_STRAGGLER_BATCH) break
    summary.scanned++

    let raw: bigint
    try {
      raw = await readUsdtBaseUnits(aptos, normalizeAptosAddr(r.address), assetAddr)
    } catch {
      continue // one unreadable address must not abort the batch
    }
    if (raw < minUnits) continue

    sweptThisRun++
    const res = await sweepAptosDeposit({ depositAddressId: r.id, reason: 'straggler-sweep' })
    if (res.status === 'swept') {
      summary.swept++
      summary.totalUsdt += res.usdt
    } else if (res.status === 'failed') {
      summary.failed++
    } else {
      summary.skipped++
    }
    // Gentle spacing so a batch of sweeps doesn't hammer the fullnode.
    await new Promise((rsv) => setTimeout(rsv, 500))
  }

  return summary
}
