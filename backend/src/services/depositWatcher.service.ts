import { Prisma } from '@prisma/client'
import { formatUnits } from 'viem'
import { db } from '../lib/prisma'
import { logger } from '../lib/logger'
import { getAllChains, getRpcUrl } from './chainRegistry.service'
import type { ChainConfig } from '../lib/chains'
import { findUserByDepositAddress } from './depositAddress.service'
import { getBlockNumber, getTransactionReceipt } from '../lib/evmRpc'

/**
 * Verify a deposit's real confirmation count on-chain (EVM only). Moralis Streams
 * carry no confirmation count — we treat confirmed:true as "fully confirmed", which
 * is only safe if the stream's depth in the dashboard is >= chain.minConfirmations.
 * This RPC check makes the credit decision independent of that config.
 *
 * Returns:
 *   - { status: 'ok', confirmations } when the receipt is readable (0 if not mined)
 *   - { status: 'reverted' } when the tx reverted on-chain
 *   - { status: 'unavailable' } on RPC error / no URL → caller falls back to webhook trust
 */
async function verifyEvmDepositOnChain(
  chainSlug: string,
  txHash: string,
): Promise<{ status: 'ok'; confirmations: number } | { status: 'reverted' } | { status: 'unavailable' }> {
  const rpcUrl = getRpcUrl(chainSlug)
  if (!rpcUrl) return { status: 'unavailable' }
  try {
    const [currentBlock, receipt] = await Promise.all([
      getBlockNumber(rpcUrl, chainSlug),
      getTransactionReceipt(rpcUrl, chainSlug, txHash),
    ])
    // Receipt missing = not yet mined (or dropped) → 0 confirmations, NOT a fallback.
    if (!receipt) return { status: 'ok', confirmations: 0 }
    if (receipt.status === '0x0') return { status: 'reverted' }
    const conf = currentBlock >= receipt.blockNumber
      ? Number(currentBlock - receipt.blockNumber + 1n)
      : 0
    return { status: 'ok', confirmations: conf }
  } catch {
    return { status: 'unavailable' }
  }
}

/**
 * Normalized deposit event consumed by `processDepositEvent`. The webhook
 * handler is responsible for translating provider-specific payloads (Moralis
 * Streams, Tatum, etc.) into one of these per native-or-token transfer.
 */
export interface NormalizedDepositEvent {
  chainId: number
  txHash: string
  fromAddress: string
  toAddress: string
  /** Contract address of the token, or 'native' for the chain's gas asset. */
  asset: string
  /** Token symbol (USDT, USDC, ETH, BNB, POL, …). */
  symbol: string
  /** Raw on-chain amount as a decimal string already scaled to token units. */
  amount: string
  confirmations: number
}

export type ProcessResult =
  | { status: 'ignored'; reason: string }
  | { status: 'pending'; depositId: string; required: number; confirmations: number }
  | { status: 'credited'; depositId: string; userId: string; symbol: string; amount: string }
  | { status: 'rejected'; depositId: string; reason: string }

async function chainFromId(chainId: number): Promise<ChainConfig | undefined> {
  const chains = await getAllChains()
  return chains.find((c) => c.chainId === chainId)
}

/**
 * Resolve the asset on a chain. Returns the configured token (with decimals)
 * for ERC20 contracts, or a synthesized native-asset descriptor.
 */
function resolveAsset(chain: ChainConfig, assetField: string, symbolHint?: string) {
  if (assetField === 'native') {
    return { symbol: chain.nativeSymbol, decimals: 18, isNative: true as const }
  }
  const lower = assetField.toLowerCase()
  const token = chain.tokens.find((t) => t.address?.toLowerCase() === lower)
  if (token) return { symbol: token.symbol, decimals: token.decimals, isNative: false as const }
  if (symbolHint && symbolHint.toUpperCase() === chain.nativeSymbol) {
    return { symbol: chain.nativeSymbol, decimals: 18, isNative: true as const }
  }
  return null
}

/**
 * Convert a raw on-chain amount ("1000000") to its human-readable decimal
 * representation ("1.0") using the token's decimals. Required because the
 * internal Wallet.balance is a Decimal(18, 8) holding token-denominated
 * values, not raw wei/units.
 */
function toHumanAmount(rawAmount: string, decimals: number): string {
  // Defensive: Moralis sometimes emits floats for native txs ("0.01") and
  // sometimes integers ("10000000000000000"). If it parses cleanly as a
  // BigInt, treat it as raw units; otherwise pass through as-is.
  try {
    const big = BigInt(rawAmount)
    return formatUnits(big, decimals)
  } catch {
    return rawAmount
  }
}

/**
 * Idempotently record a deposit and credit the user's internal balance once
 * enough confirmations have arrived.
 *
 * Calling this with the same (txHash, chain, asset) repeatedly is safe:
 *   - The first call inserts a row in status='detected' (or 'credited' if it
 *     already meets the confirmation threshold).
 *   - Subsequent calls only update `confirmations`. The credit step only fires
 *     once, gated by an atomic UPDATE that compares status='detected'.
 *   - Crediting moves funds in a single Prisma transaction: it bumps
 *     Wallet.balance, writes a Transaction(type='deposit'), and flips the
 *     Deposit row to status='credited' all-or-nothing.
 */
export async function processDepositEvent(event: NormalizedDepositEvent): Promise<ProcessResult> {
  const chain = await chainFromId(event.chainId)
  if (!chain) {
    return { status: 'ignored', reason: `unsupported chainId ${event.chainId}` }
  }

  const asset = resolveAsset(chain, event.asset, event.symbol)
  if (!asset) {
    return { status: 'ignored', reason: `asset ${event.asset} is not whitelisted on ${chain.id}` }
  }

  // Case-insensitive — findUserByDepositAddress uses mode: 'insensitive'.
  const userId = await findUserByDepositAddress(event.toAddress)
  if (!userId) {
    return { status: 'ignored', reason: 'toAddress is not a known RupChain deposit address' }
  }

  // Upsert Deposit row. Unique (txHash, chain, asset) makes this idempotent.
  const existing = await db.deposit.findUnique({
    where: {
      txHash_chain_asset: { txHash: event.txHash, chain: chain.id, asset: event.asset },
    },
  })

  // Normalise raw on-chain units to human-readable decimal once, here, so the
  // Deposit row and the eventual credit both use the same denomination.
  const humanAmount = toHumanAmount(event.amount, asset.decimals)

  if (existing && existing.status === 'credited') {
    return { status: 'credited', depositId: existing.id, userId, symbol: asset.symbol, amount: humanAmount }
  }
  if (existing && existing.status === 'rejected') {
    return { status: 'rejected', depositId: existing.id, reason: existing.rejectionReason ?? 'previously rejected' }
  }

  // Confirmation count must never go backwards. Moralis can emit the
  // unconfirmed (confirmed:false → 0) event AFTER the confirmed (confirmed:true)
  // event if delivery is reordered or the reconciler beats the webhook to it,
  // and we don't want that to "uncredit" or lower a counter that's already at
  // threshold.
  const effectiveConfirmations = existing
    ? Math.max(existing.confirmations, event.confirmations)
    : event.confirmations

  if (existing) {
    logger.info(
      {
        depositId: existing.id,
        txHash: event.txHash,
        chain: chain.id,
        before: existing.confirmations,
        after: effectiveConfirmations,
        threshold: chain.minConfirmations,
        source: 'webhook',
      },
      'Deposit confirmation update',
    )
  } else {
    logger.info(
      {
        txHash: event.txHash,
        chain: chain.id,
        asset: asset.symbol,
        amount: humanAmount,
        toAddress: event.toAddress,
        confirmations: effectiveConfirmations,
        threshold: chain.minConfirmations,
      },
      'Deposit detected (first sighting)',
    )
  }

  const deposit = existing
    ? await db.deposit.update({
        where: { id: existing.id },
        data: { confirmations: effectiveConfirmations },
      })
    : await db.deposit.create({
        data: {
          txHash: event.txHash,
          chain: chain.id,
          asset: event.asset,
          symbol: asset.symbol,
          fromAddress: event.fromAddress,
          toAddress: event.toAddress,
          amount: humanAmount,
          confirmations: effectiveConfirmations,
          userId,
          status: 'detected',
        },
      })

  // ── On-chain confirmation gate (A7) ─────────────────────────────────────────
  // Don't trust a webhook's confirmed:true alone — RPC-verify the real depth so a
  // misconfigured Moralis stream depth can't credit a deposit before it's final
  // (which a reorg could then orphan). Falls back to the webhook count only if RPC
  // is genuinely unavailable, preserving availability.
  let confirmationsForDecision = effectiveConfirmations
  if (chain.family === 'EVM') {
    const v = await verifyEvmDepositOnChain(chain.id, event.txHash)
    if (v.status === 'reverted') {
      await db.deposit
        .updateMany({ where: { id: deposit.id, status: 'detected' }, data: { status: 'rejected', rejectionReason: 'tx_reverted_on_chain' } })
        .catch(() => {})
      logger.warn({ depositId: deposit.id, txHash: event.txHash, chain: chain.id }, 'Deposit rejected — tx reverted on-chain (webhook RPC gate)')
      return { status: 'rejected', depositId: deposit.id, reason: 'tx_reverted_on_chain' }
    }
    if (v.status === 'ok') {
      confirmationsForDecision = v.confirmations
      // Persist the real count so the reconciler doesn't inherit an inflated value.
      if (deposit.confirmations !== v.confirmations) {
        await db.deposit.update({ where: { id: deposit.id }, data: { confirmations: v.confirmations } }).catch(() => {})
      }
    } else {
      logger.warn({ depositId: deposit.id, txHash: event.txHash, chain: chain.id }, 'Deposit RPC verification unavailable — falling back to webhook confirmation')
    }
  }

  if (confirmationsForDecision < chain.minConfirmations) {
    return {
      status: 'pending',
      depositId: deposit.id,
      required: chain.minConfirmations,
      confirmations: confirmationsForDecision,
    }
  }

  // Credit the user atomically. The where clause includes status='detected'
  // so concurrent crediting attempts collapse to one — the others get zero
  // affected rows from the Deposit update and bail.
  try {
    const result = await db.$transaction(async (tx) => {
      // Atomically claim the credit step: only one transaction can flip
      // status from 'detected' → 'credited'.
      const claimed = await tx.deposit.updateMany({
        where: { id: deposit.id, status: 'detected' },
        data: { status: 'credited', creditedAt: new Date() },
      })
      if (claimed.count === 0) {
        return null // someone else already credited it
      }

      // Find-or-create the internal Wallet row for this user+coin+network.
      const network = chain.networkLabel
      const wallet = await tx.wallet.upsert({
        where: {
          userId_coin_network: { userId, coin: asset.symbol, network },
        },
        create: {
          userId,
          coin: asset.symbol,
          network,
          balance: humanAmount,
          lockedBalance: '0',
        },
        update: {
          balance: { increment: new Prisma.Decimal(humanAmount) },
        },
      })

      const txn = await tx.transaction.create({
        data: {
          walletId: wallet.id,
          type: 'deposit',
          amount: humanAmount,
          fee: '0',
          txHash: event.txHash,
          status: 'completed',
          metadata: {
            chain: chain.id,
            asset: event.asset,
            symbol: asset.symbol,
            rawAmount: event.amount,
            decimals: asset.decimals,
            fromAddress: event.fromAddress,
            toAddress: event.toAddress,
            confirmations: event.confirmations,
          },
        },
      })

      await tx.deposit.update({
        where: { id: deposit.id },
        data: { walletId: wallet.id, creditedTransactionId: txn.id },
      })

      return { walletId: wallet.id, txnId: txn.id }
    })

    if (!result) {
      return {
        status: 'credited',
        depositId: deposit.id,
        userId,
        symbol: asset.symbol,
        amount: humanAmount,
      }
    }

    logger.info(
      {
        depositId: deposit.id,
        userId,
        chain: chain.id,
        symbol: asset.symbol,
        amount: humanAmount,
        txHash: event.txHash,
      },
      'Deposit credited to internal balance',
    )

    return {
      status: 'credited',
      depositId: deposit.id,
      userId,
      symbol: asset.symbol,
      amount: humanAmount,
    }
  } catch (err) {
    logger.error({ err, depositId: deposit.id }, 'Failed to credit deposit')
    // Mark for manual review rather than retry-storm. Operators inspect
    // /admin/deposits and re-run the credit pathway manually.
    await db.deposit.update({
      where: { id: deposit.id },
      data: {
        status: 'rejected',
        rejectionReason: err instanceof Error ? err.message.slice(0, 500) : 'credit failed',
      },
    })
    return {
      status: 'rejected',
      depositId: deposit.id,
      reason: 'credit transaction failed — flagged for admin review',
    }
  }
}

/**
 * Convert a Moralis Streams webhook payload into one or more normalized
 * deposit events. Handles native ETH/BNB/etc. transfers and ERC20 transfers
 * in the same payload. Returns an empty array if the payload contains nothing
 * actionable (e.g. internal txs or transfers we don't index).
 *
 * Reference shape (abbreviated):
 *   {
 *     confirmed: boolean,
 *     chainId: '0x1',
 *     block: { number, hash, timestamp },
 *     txs: [ { hash, fromAddress, toAddress, value } ],
 *     erc20Transfers: [ { transactionHash, from, to, value, contract, tokenSymbol } ],
 *     confirmations?: number
 *   }
 */
export async function normalizeMoralisEvent(
  payload: unknown,
): Promise<NormalizedDepositEvent[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = payload as any
  if (!p || typeof p !== 'object') return []

  const chainIdHex: string | undefined = p.chainId
  const chainId = chainIdHex ? Number.parseInt(chainIdHex, 16) : Number(p.chainIdDecimal)
  if (!Number.isFinite(chainId)) return []

  // Moralis Streams webhook payloads carry `confirmed: boolean` but no
  // `confirmations` field. The stream fires exactly twice per tx:
  //   1) confirmed:false when first seen in a block
  //   2) confirmed:true once the stream's configured depth has been reached
  // We treat `confirmed: true` as "fully confirmed at this chain's threshold"
  // so the credit branch fires. The Moralis Stream's own confirmation depth
  // MUST be configured to be at least chainConfig.minConfirmations in the
  // dashboard — otherwise we'd credit too early. (See ops runbook.)
  //
  // `p.confirmations` is preserved as a fallback in case Moralis (or a future
  // provider) ever sends an explicit count.
  const chain = await chainFromId(chainId)
  const threshold = chain?.minConfirmations ?? 0
  let confirmations: number
  if (p.confirmations != null && Number.isFinite(Number(p.confirmations))) {
    confirmations = Number(p.confirmations)
  } else if (p.confirmed === true) {
    confirmations = threshold > 0 ? threshold : 1
    logger.info(
      { chainId, threshold },
      'Moralis confirmed:true interpreted as full confirmation',
    )
  } else {
    confirmations = 0
  }

  const out: NormalizedDepositEvent[] = []

  // Native transfers
  if (Array.isArray(p.txs)) {
    for (const t of p.txs) {
      if (!t?.hash || !t?.toAddress) continue
      const value = String(t.value ?? '0')
      if (value === '0') continue
      out.push({
        chainId,
        txHash: String(t.hash),
        fromAddress: String(t.fromAddress ?? ''),
        toAddress: String(t.toAddress),
        asset: 'native',
        symbol: '',
        amount: value,
        confirmations,
      })
    }
  }

  // ERC20 transfers
  if (Array.isArray(p.erc20Transfers)) {
    for (const t of p.erc20Transfers) {
      if (!t?.transactionHash || !t?.to || !t?.contract) continue
      out.push({
        chainId,
        txHash: String(t.transactionHash),
        fromAddress: String(t.from ?? ''),
        toAddress: String(t.to),
        asset: String(t.contract),
        symbol: String(t.tokenSymbol ?? ''),
        amount: String(t.value ?? '0'),
        confirmations,
      })
    }
  }

  return out
}

export type CreditDepositOutcome =
  | { status: 'credited'; depositId: string; userId: string; symbol: string; amount: string; alreadyCredited: false }
  | { status: 'credited'; depositId: string; userId: string; symbol: string; amount: string; alreadyCredited: true }
  | { status: 'rejected'; depositId: string; reason: string }
  | { status: 'no_user'; depositId: string }

/**
 * Credit a Deposit row that's already been recorded in status='detected'
 * (or, when `allowFromRejected` is true, in status='rejected'). Used by:
 *   - the reconciler worker when on-chain confirmations cross threshold
 *   - the admin force-credit endpoint after an on-chain verification check
 *
 * Idempotency: the atomic updateMany gate (status='detected' → 'credited')
 * means two concurrent callers can never double-credit. A second caller
 * observes claimed.count === 0 and returns alreadyCredited:true without
 * touching the wallet.
 *
 * This deliberately does NOT lower status from 'credited' or re-credit a
 * row. Crediting a row from 'rejected' is gated behind `allowFromRejected`
 * because that path requires an explicit admin reason (logged separately).
 */
export async function creditDetectedDeposit(
  depositId: string,
  opts: {
    source: 'webhook' | 'reconciler' | 'admin-force' | 'admin-refresh'
    allowFromRejected?: boolean
    /** Extra metadata stamped into the Transaction record (admin reason, RPC info, …). */
    extraMetadata?: Record<string, unknown>
  },
): Promise<CreditDepositOutcome> {
  const deposit = await db.deposit.findUnique({ where: { id: depositId } })
  if (!deposit) {
    return { status: 'rejected', depositId, reason: 'deposit_not_found' }
  }
  if (!deposit.userId) {
    return { status: 'no_user', depositId }
  }
  if (deposit.status === 'credited') {
    return {
      status: 'credited',
      depositId,
      userId: deposit.userId,
      symbol: deposit.symbol,
      amount: deposit.amount.toString(),
      alreadyCredited: true,
    }
  }
  if (deposit.status === 'rejected' && !opts.allowFromRejected) {
    return { status: 'rejected', depositId, reason: 'deposit_rejected' }
  }

  const chain = (await getAllChains()).find((c) => c.id === deposit.chain)
  const network = chain?.networkLabel ?? deposit.chain.toUpperCase()
  const symbol = deposit.symbol
  const amountStr = deposit.amount.toString()
  const userId = deposit.userId
  const allowedFromStatuses = opts.allowFromRejected ? ['detected', 'rejected'] : ['detected']

  try {
    const result = await db.$transaction(async (tx) => {
      const claimed = await tx.deposit.updateMany({
        where: { id: deposit.id, status: { in: allowedFromStatuses } },
        data: { status: 'credited', creditedAt: new Date(), rejectionReason: null },
      })
      if (claimed.count === 0) return null

      const wallet = await tx.wallet.upsert({
        where: { userId_coin_network: { userId, coin: symbol, network } },
        create: { userId, coin: symbol, network, balance: amountStr, lockedBalance: '0' },
        update: { balance: { increment: new Prisma.Decimal(amountStr) } },
      })

      const txn = await tx.transaction.create({
        data: {
          walletId: wallet.id,
          type: 'deposit',
          amount: amountStr,
          fee: '0',
          txHash: deposit.txHash,
          status: 'completed',
          metadata: {
            chain: deposit.chain,
            asset: deposit.asset,
            symbol,
            fromAddress: deposit.fromAddress,
            toAddress: deposit.toAddress,
            confirmations: deposit.confirmations,
            source: opts.source,
            ...(opts.extraMetadata ?? {}),
          },
        },
      })

      await tx.deposit.update({
        where: { id: deposit.id },
        data: { walletId: wallet.id, creditedTransactionId: txn.id },
      })

      return { walletId: wallet.id, txnId: txn.id }
    })

    if (!result) {
      // Lost the credit race — peer process beat us. That's a successful
      // outcome from the caller's perspective.
      return {
        status: 'credited',
        depositId,
        userId,
        symbol,
        amount: amountStr,
        alreadyCredited: true,
      }
    }

    logger.info(
      { depositId, userId, chain: deposit.chain, symbol, amount: amountStr, txHash: deposit.txHash, source: opts.source },
      'Deposit credited',
    )
    return {
      status: 'credited',
      depositId,
      userId,
      symbol,
      amount: amountStr,
      alreadyCredited: false,
    }
  } catch (err) {
    logger.error({ err, depositId, source: opts.source }, 'creditDetectedDeposit failed')
    return {
      status: 'rejected',
      depositId,
      reason: err instanceof Error ? err.message.slice(0, 500) : 'credit_failed',
    }
  }
}
