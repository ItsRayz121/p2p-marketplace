import { randomUUID } from 'node:crypto'
import { db } from '../lib/prisma'
import { AppError } from '../lib/errors'
import { deriveEvmAddress, walletCustodyIsConfigured } from '../lib/walletCrypto'
import { recordAuditLog } from '../lib/audit'
import { logger } from '../lib/logger'
import { provisionSubscriptions } from './moralisStreams.service'

const EVM_INDEX_KEY = 'next_evm_derivation_index'

/**
 * Atomically claim the next EVM derivation index. PlatformConfig.value is a
 * String, so we round-trip through TEXT/INT. The ON CONFLICT clause makes this
 * race-safe across concurrent transactions on Postgres.
 *
 * Returns the index the caller may use (i.e. the value BEFORE this call's
 * increment).
 */
async function claimNextEvmIndex(): Promise<number> {
  const rows = await db.$queryRawUnsafe<Array<{ value: string }>>(
    `INSERT INTO "PlatformConfig" ("id", "key", "value", "updatedAt")
     VALUES ($1, $2, '1', NOW())
     ON CONFLICT ("key") DO UPDATE SET
       "value" = (CAST("PlatformConfig"."value" AS INTEGER) + 1)::TEXT,
       "updatedAt" = NOW()
     RETURNING "value"`,
    randomUUID(),
    EVM_INDEX_KEY,
  )
  if (!rows[0]) {
    throw new AppError('CUSTODY_ERROR', 'Failed to allocate derivation index', 500)
  }
  const newCounter = parseInt(rows[0].value, 10)
  if (!Number.isFinite(newCounter) || newCounter < 1) {
    throw new AppError('CUSTODY_ERROR', 'Derivation counter is corrupt', 500)
  }
  // The index we just claimed is (newCounter - 1): on first run newCounter=1
  // (the INSERT path), we return 0. On every UPDATE path, newCounter is the
  // post-increment value, so claimed = newCounter - 1.
  return newCounter - 1
}

/**
 * Return (or generate) the EVM deposit address for a user. The same address is
 * valid across every EVM chain we support — callers should choose the chain
 * for display, but the on-chain address is shared.
 */
export async function getOrCreateEvmDepositAddress(
  userId: string,
): Promise<{ address: string; derivationIndex: number }> {
  if (!walletCustodyIsConfigured()) {
    throw new AppError(
      'CUSTODY_UNCONFIGURED',
      'Deposit address temporarily unavailable — please retry shortly',
      503,
    )
  }

  // Fast path — already provisioned.
  const existing = await db.depositAddress.findUnique({
    where: { userId_chainFamily: { userId, chainFamily: 'EVM' } },
  })
  if (existing) {
    return { address: existing.address, derivationIndex: existing.derivationIndex }
  }

  // Slow path — claim an index, derive the address, persist. If two requests
  // for the same user race here, the unique(userId, chainFamily) constraint
  // resolves the race: one wins, the other catches and re-reads.
  const index = await claimNextEvmIndex()
  const address = deriveEvmAddress(index)

  // Defence-in-depth: the unique constraint on `address` should prevent
  // collisions, but if a duplicate ever made it to the DB layer we'd rather
  // crash than silently assign the same address to two users.
  const conflict = await db.depositAddress.findUnique({ where: { address } })
  if (conflict && conflict.userId !== userId) {
    logger.error(
      { index, userId, conflictUserId: conflict.userId },
      'HD derivation produced a colliding address — possible counter corruption',
    )
    throw new AppError(
      'CUSTODY_ERROR',
      'Address generation failed. Please retry.',
      500,
    )
  }

  try {
    const row = await db.depositAddress.create({
      data: {
        userId,
        chainFamily: 'EVM',
        address,
        derivationIndex: index,
      },
    })
    // Audit-trail every address generation. Stores only public material.
    void recordAuditLog(userId, 'DEPOSIT_ADDRESS_GENERATED', 'DepositAddress', row.id, {
      chainFamily: 'EVM',
      derivationIndex: index,
      address,
    })

    // Fire-and-forget: register this address in every configured Moralis
    // Stream. provisionSubscriptions handles its own errors so a Moralis
    // outage never blocks the user's deposit-address fetch.
    void provisionSubscriptions(row.id)

    return { address: row.address, derivationIndex: row.derivationIndex }
  } catch (err) {
    // Unique violation on (userId, chainFamily) — another request beat us.
    // The claimed index is now orphaned but harmless (counter just advanced).
    const fallback = await db.depositAddress.findUnique({
      where: { userId_chainFamily: { userId, chainFamily: 'EVM' } },
    })
    if (fallback) {
      return { address: fallback.address, derivationIndex: fallback.derivationIndex }
    }
    throw err
  }
}

export async function findUserByDepositAddress(address: string): Promise<string | null> {
  // Case-insensitive: webhook providers (Moralis, Tatum, …) emit lowercased
  // EVM addresses, but we store EIP-55 checksummed.
  const row = await db.depositAddress.findFirst({
    where: { address: { equals: address, mode: 'insensitive' } },
    select: { userId: true },
  })
  return row?.userId ?? null
}
