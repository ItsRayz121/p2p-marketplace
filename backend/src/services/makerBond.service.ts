import { Prisma } from '@prisma/client'
import { db } from '../lib/prisma'
import { AppError } from '../lib/errors'
import { logger } from '../lib/logger'
import { recordAuditLog } from '../lib/audit'
import { FLAGS, isFlagEnabled, getNumberConfig } from './platformFlags.service'

/**
 * Maker collateral bond (non-custodial Phase 5).
 *
 * The maker's DEPOSITED USDT acts as skin-in-the-game. When a trade opens we
 * lock `ratio% × tradeUsdt` of the maker's available USDT into lockedBalance;
 * on a clean close we release it; if the maker loses a dispute we seize it to
 * the victim. The trade asset itself still settles off-platform — the bond is a
 * deterrent + partial recovery, never full insurance.
 *
 * SAFETY MODEL (money movement — read before editing):
 *   - One BondHold row per trade, unique (tradeType, tradeId). The status gate
 *     held → released | seized makes lock/release/seize EXACTLY-ONCE and
 *     idempotent, mirroring the Deposit detected→credited pattern.
 *   - All balance moves happen inside a single DB transaction with the maker's
 *     Wallet row SELECT-ed FOR UPDATE, so concurrent trades can't over-lock or
 *     double-spend the same bond pool.
 *   - lockedBalance only ever goes up by exactly what we later take back down,
 *     so it can never drift negative.
 */

const BOND_TYPES = ['usdt', 'ctm'] as const
export type BondTradeType = (typeof BOND_TYPES)[number]

export interface BondConfig {
  enabled: boolean
  ratioPct: number // e.g. 10 = 10%
  minUsdt: number
}

export async function getBondConfig(): Promise<BondConfig> {
  const [enabled, ratioPct, minUsdt] = await Promise.all([
    isFlagEnabled(FLAGS.MAKER_BOND, false),
    getNumberConfig('maker_bond_ratio_pct', 10),
    getNumberConfig('maker_bond_min_usdt', 0),
  ])
  return { enabled, ratioPct, minUsdt }
}

/** Bond amount (USDT, 8 dp) for a given trade size, before checking the pool. */
export function computeBondUsdt(tradeUsdt: number | string | Prisma.Decimal, cfg: BondConfig): Prisma.Decimal {
  const trade = new Prisma.Decimal(tradeUsdt)
  const pct = new Prisma.Decimal(Number.isFinite(cfg.ratioPct) ? cfg.ratioPct : 0).div(100)
  let bond = trade.mul(pct)
  const min = new Prisma.Decimal(Number.isFinite(cfg.minUsdt) ? cfg.minUsdt : 0)
  if (bond.lt(min)) bond = min
  // Quantize to the Wallet balance scale (8 dp), rounding up so we never
  // under-collateralise by a rounding sliver.
  return bond.toDecimalPlaces(8, Prisma.Decimal.ROUND_UP)
}

export type BondLockResult =
  | { status: 'skipped'; reason: 'disabled' | 'zero' }
  | { status: 'held'; amount: string; alreadyHeld: boolean }

// Minimal client shape shared by db and an interactive-transaction client.
type BondTxClient = Prisma.TransactionClient

/**
 * Core lock, operating on a provided transaction client so the bond lock can
 * commit ATOMICALLY with the trade it backs (caller passes its own `tx`).
 * Idempotent within (tradeType, tradeId). Throws AppError('INSUFFICIENT_BOND')
 * when no single USDT wallet covers the bond. Does NOT write audit logs — the
 * caller logs after its transaction commits.
 */
export async function lockMakerBondTx(
  tx: BondTxClient,
  params: { tradeType: BondTradeType; tradeId: string; makerId: string; tradeUsdt: number | string | Prisma.Decimal },
  cfg: BondConfig,
): Promise<BondLockResult> {
  const { tradeType, tradeId, makerId } = params
  if (!cfg.enabled) return { status: 'skipped', reason: 'disabled' }
  const bond = computeBondUsdt(params.tradeUsdt, cfg)
  if (bond.lte(0)) return { status: 'skipped', reason: 'zero' }

  // Re-check inside the transaction so two concurrent opens collapse to one.
  const dup = await tx.bondHold.findUnique({ where: { tradeType_tradeId: { tradeType, tradeId } } })
  if (dup) return { status: 'held', amount: dup.amount.toString(), alreadyHeld: true }

  // Row-lock the maker's USDT wallets; pick one whose available covers the bond.
  const wallets = await tx.$queryRaw<Array<{ id: string; balance: string; lockedBalance: string }>>`
    SELECT id, balance, "lockedBalance"
    FROM "Wallet"
    WHERE "userId" = ${makerId} AND coin = 'USDT'
    ORDER BY (balance - "lockedBalance") DESC
    FOR UPDATE
  `
  const chosen = wallets.find((w) => new Prisma.Decimal(w.balance).sub(w.lockedBalance).gte(bond))
  if (!chosen) {
    throw new AppError(
      'INSUFFICIENT_BOND',
      'This offer can’t accept trades right now (the maker’s collateral bond is insufficient). Please choose another offer.',
      400,
    )
  }

  await tx.wallet.update({ where: { id: chosen.id }, data: { lockedBalance: { increment: bond } } })
  await tx.bondHold.create({
    data: { tradeType, tradeId, makerId, walletId: chosen.id, amount: bond, status: 'held' },
  })
  return { status: 'held', amount: bond.toString(), alreadyHeld: false }
}

/**
 * Standalone lock (opens its own transaction). For callers not already inside a
 * transaction. Idempotent; throws AppError('INSUFFICIENT_BOND') as above.
 */
export async function lockMakerBond(params: {
  tradeType: BondTradeType
  tradeId: string
  makerId: string
  tradeUsdt: number | string | Prisma.Decimal
}): Promise<BondLockResult> {
  const cfg = await getBondConfig()
  if (!cfg.enabled) return { status: 'skipped', reason: 'disabled' }

  const pre = await db.bondHold.findUnique({
    where: { tradeType_tradeId: { tradeType: params.tradeType, tradeId: params.tradeId } },
  })
  if (pre) return { status: 'held', amount: pre.amount.toString(), alreadyHeld: true }

  const result = await db.$transaction((tx) => lockMakerBondTx(tx, params, cfg))
  if (result.status === 'held' && !result.alreadyHeld) {
    void recordAuditLog(params.makerId, 'BOND_LOCKED', 'BondHold', `${params.tradeType}:${params.tradeId}`, {
      tradeType: params.tradeType, tradeId: params.tradeId, amountUsdt: result.amount,
    })
    logger.info({ ...params, amount: result.amount }, 'Maker bond locked')
  }
  return result
}

/**
 * Release a held bond back to the maker's available balance. Idempotent and
 * safe to call on a trade that never had a bond (e.g. flag was off at open):
 * a missing or already-resolved hold is a no-op.
 */
export async function releaseMakerBond(params: {
  tradeType: BondTradeType
  tradeId: string
}): Promise<{ released: boolean }> {
  const { tradeType, tradeId } = params
  const hold = await db.bondHold.findUnique({ where: { tradeType_tradeId: { tradeType, tradeId } } })
  if (!hold || hold.status !== 'held') return { released: false }

  const done = await db.$transaction(async (tx) => {
    // Atomic claim — only one caller flips held → released.
    const claimed = await tx.bondHold.updateMany({
      where: { id: hold.id, status: 'held' },
      data: { status: 'released', resolvedAt: new Date() },
    })
    if (claimed.count === 0) return false
    await tx.wallet.update({
      where: { id: hold.walletId },
      data: { lockedBalance: { decrement: hold.amount } },
    })
    return true
  })

  if (done) {
    void recordAuditLog(hold.makerId, 'BOND_RELEASED', 'BondHold', `${tradeType}:${tradeId}`, {
      tradeType, tradeId, amountUsdt: hold.amount.toString(),
    })
    logger.info({ tradeType, tradeId, makerId: hold.makerId, amount: hold.amount.toString() }, 'Maker bond released')
  }
  return { released: done }
}

/**
 * Seize a held bond to the victim (the wronged counterparty) when the maker
 * loses a dispute. Debits the maker's balance AND lockedBalance, credits the
 * victim's USDT balance on the same network, and writes ledger Transactions for
 * both sides. Idempotent via the status gate.
 */
export async function seizeMakerBond(params: {
  tradeType: BondTradeType
  tradeId: string
  victimId: string
}): Promise<{ seized: boolean; amount?: string }> {
  const { tradeType, tradeId, victimId } = params
  const hold = await db.bondHold.findUnique({ where: { tradeType_tradeId: { tradeType, tradeId } } })
  if (!hold || hold.status !== 'held') return { seized: false }
  if (victimId === hold.makerId) {
    // Defensive: never pay a seizure back to the maker. Release instead.
    await releaseMakerBond({ tradeType, tradeId })
    return { seized: false }
  }

  const done = await db.$transaction(async (tx) => {
    const claimed = await tx.bondHold.updateMany({
      where: { id: hold.id, status: 'held' },
      data: { status: 'seized', victimId, resolvedAt: new Date() },
    })
    if (claimed.count === 0) return false

    const makerWallet = await tx.wallet.findUnique({ where: { id: hold.walletId } })
    if (!makerWallet) throw new AppError('CUSTODY_ERROR', 'Maker bond wallet missing during seize', 500)

    // Funds physically leave the maker: drop both balance and the lock.
    await tx.wallet.update({
      where: { id: hold.walletId },
      data: {
        balance: { decrement: hold.amount },
        lockedBalance: { decrement: hold.amount },
      },
    })

    // Credit the victim on the same coin/network so it's a real, withdrawable balance.
    const victimWallet = await tx.wallet.upsert({
      where: { userId_coin_network: { userId: victimId, coin: 'USDT', network: makerWallet.network } },
      create: { userId: victimId, coin: 'USDT', network: makerWallet.network, balance: hold.amount, lockedBalance: '0' },
      update: { balance: { increment: hold.amount } },
    })

    await tx.transaction.create({
      data: {
        walletId: hold.walletId,
        type: 'bond_seized',
        amount: hold.amount,
        fee: '0',
        status: 'completed',
        metadata: { tradeType, tradeId, victimId },
      },
    })
    await tx.transaction.create({
      data: {
        walletId: victimWallet.id,
        type: 'bond_received',
        amount: hold.amount,
        fee: '0',
        status: 'completed',
        metadata: { tradeType, tradeId, makerId: hold.makerId },
      },
    })
    return true
  })

  if (done) {
    void recordAuditLog(hold.makerId, 'BOND_SEIZED', 'BondHold', `${tradeType}:${tradeId}`, {
      tradeType, tradeId, amountUsdt: hold.amount.toString(), victimId,
    })
    logger.info({ tradeType, tradeId, makerId: hold.makerId, victimId, amount: hold.amount.toString() }, 'Maker bond seized to victim')
  }
  return { seized: done, amount: hold.amount.toString() }
}
