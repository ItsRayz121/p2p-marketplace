/**
 * Production-grade blockchain transaction verifier for P2P and CTM trades.
 *
 * Used when a seller submits a tx hash claiming they sent crypto to the buyer.
 * We verify on-chain that:
 *   1. The tx exists and is mined (not dropped)
 *   2. The tx succeeded (receipt.status = 0x1, not reverted)
 *   3. The receiver matches the buyer's wallet address
 *   4. The token contract matches the expected coin/network
 *   5. The transferred amount >= expected trade amount (99% tolerance)
 *
 * For EVM chains: verifies via direct RPC call (getTransactionReceipt + logs).
 * For non-EVM chains (TRON, TON, SOL, SUI): returns status='skipped' — these
 * chains are not yet wired to an RPC verifier. The hash is still stored and
 * the buyer must verify manually.
 *
 * Rejections (definitive fraud signals) throw AppError so the HTTP caller sees
 * a 400. Uncertain outcomes (RPC down, tx pending) return status='pending' and
 * let the trade proceed — the buyer still has the final release gate.
 */

import { Decimal } from '@prisma/client/runtime/library'
import { AppError } from '../lib/errors'
import { logger } from '../lib/logger'
import { getChainByNetworkLabel } from './chainRegistry.service'
import { getRpcUrl } from '../lib/chains'
import {
  getTransactionReceiptWithLogs,
  getTransactionByHash,
  getBlockNumber,
  parseErc20Transfers,
  EvmRpcError,
} from '../lib/evmRpc'
import { db } from '../lib/prisma'

export type TxVerificationStatus =
  | 'verified'
  | 'failed'
  | 'mismatch_receiver'
  | 'mismatch_amount'
  | 'reverted'
  | 'not_found'
  | 'rpc_error'
  | 'pending'
  | 'skipped'

export interface TxVerificationResult {
  status: TxVerificationStatus
  message: string
  details: {
    chain?: string
    rpcChecked: boolean
    txStatus?: '0x0' | '0x1'
    expectedReceiver?: string
    actualReceiver?: string | null
    expectedAmount?: string
    actualAmount?: string
    confirmations?: number
    threshold?: number
    tokenContract?: string | null
    verifiedAt?: string
  }
}

/**
 * Verify an EVM transaction submitted as proof of a P2P or CTM trade transfer.
 *
 * @param txHash      The hash submitted by the seller
 * @param coin        Token symbol (e.g. "USDT", "ETH", "BNB")
 * @param network     Network label (e.g. "BEP20", "ERC20", "POLYGON")
 * @param amount      Expected token amount (Decimal or string — human-readable units)
 * @param buyerWallet The buyer's destination wallet address
 */
export async function verifyTradeTx(
  txHash: string,
  coin: string,
  network: string,
  amount: Decimal | string,
  buyerWallet: string,
): Promise<TxVerificationResult> {
  const chain = await getChainByNetworkLabel(network)

  if (!chain) {
    return {
      status: 'skipped',
      message: `Network ${network} is not in the chain registry — hash stored, buyer must verify manually`,
      details: { rpcChecked: false },
    }
  }

  if (chain.family !== 'EVM') {
    return {
      status: 'skipped',
      message: `On-chain verification for ${chain.family} chains is not yet automated — buyer must verify manually`,
      details: { chain: chain.id, rpcChecked: false },
    }
  }

  const rpcUrl = getRpcUrl(chain.id)
  if (!rpcUrl) {
    return {
      status: 'skipped',
      message: `No RPC URL configured for ${chain.id} — hash stored, buyer must verify manually`,
      details: { chain: chain.id, rpcChecked: false },
    }
  }

  const expectedAmount = new Decimal(amount.toString())
  const expectedReceiver = buyerWallet.toLowerCase()

  // Determine if this is a native token or ERC20
  const isNative = coin.toUpperCase() === chain.nativeSymbol.toUpperCase()
  const tokenCfg = isNative
    ? null
    : chain.tokens.find((t) => t.symbol.toUpperCase() === coin.toUpperCase())

  if (!isNative && !tokenCfg) {
    return {
      status: 'skipped',
      message: `${coin} is not a whitelisted token on ${chain.name} — buyer must verify manually`,
      details: { chain: chain.id, rpcChecked: false },
    }
  }

  try {
    const [receipt, currentBlock] = await Promise.all([
      getTransactionReceiptWithLogs(rpcUrl, chain.id, txHash),
      getBlockNumber(rpcUrl, chain.id),
    ])

    if (!receipt) {
      return {
        status: 'not_found',
        message: 'Transaction not found on chain — it may still be pending in the mempool',
        details: {
          chain: chain.id,
          rpcChecked: true,
          expectedReceiver: buyerWallet,
          tokenContract: tokenCfg?.address ?? null,
        },
      }
    }

    if (receipt.status === '0x0') {
      return {
        status: 'reverted',
        message: 'Transaction was reverted on-chain (receipt status = 0x0) — no tokens were transferred',
        details: {
          chain: chain.id,
          rpcChecked: true,
          txStatus: '0x0',
          expectedReceiver: buyerWallet,
          tokenContract: tokenCfg?.address ?? null,
        },
      }
    }

    const confirmations = currentBlock >= receipt.blockNumber
      ? Number(currentBlock - receipt.blockNumber + 1n)
      : 0

    const baseDetails = {
      chain: chain.id,
      rpcChecked: true,
      txStatus: receipt.status,
      expectedReceiver: buyerWallet,
      confirmations,
      threshold: chain.minConfirmations,
      tokenContract: tokenCfg?.address ?? null,
    }

    if (isNative) {
      // For native transfers, getTransactionByHash gives us `to` and `value`
      const tx = await getTransactionByHash(rpcUrl, chain.id, txHash)
      if (!tx) {
        return {
          status: 'rpc_error',
          message: 'Receipt found but transaction body missing — RPC inconsistency, retry later',
          details: baseDetails,
        }
      }

      const actualReceiver = tx.to?.toLowerCase() ?? null
      if (actualReceiver !== expectedReceiver) {
        return {
          status: 'mismatch_receiver',
          message: `Transaction receiver (${actualReceiver}) does not match buyer wallet (${buyerWallet})`,
          details: {
            ...baseDetails,
            actualReceiver,
            expectedAmount: expectedAmount.toString(),
            actualAmount: formatNative(tx.value),
          },
        }
      }

      // Native amount check: tx.value is in wei, expectedAmount is in token units
      const NATIVE_DECIMALS = 18
      const expectedWei = BigInt(expectedAmount.times(new Decimal(10).pow(NATIVE_DECIMALS)).toFixed(0))
      const tolerance = expectedWei / 100n // 1% tolerance

      if (tx.value < expectedWei - tolerance) {
        return {
          status: 'mismatch_amount',
          message: `Native amount sent (${formatNative(tx.value)}) is less than expected (${expectedAmount.toString()}) by more than 1%`,
          details: {
            ...baseDetails,
            actualReceiver,
            expectedAmount: expectedAmount.toString(),
            actualAmount: formatNative(tx.value),
          },
        }
      }

      return {
        status: 'verified',
        message: `On-chain verified: ${formatNative(tx.value)} ${coin} sent to ${actualReceiver} (${confirmations} confirmations)`,
        details: {
          ...baseDetails,
          actualReceiver,
          expectedAmount: expectedAmount.toString(),
          actualAmount: formatNative(tx.value),
          verifiedAt: new Date().toISOString(),
        },
      }
    }

    // ERC20 path — parse Transfer event logs
    const transfers = parseErc20Transfers(receipt.logs, tokenCfg!.address!)
    const matchingTransfer = transfers.find(
      (t) => t.to.toLowerCase() === expectedReceiver,
    )

    if (!matchingTransfer) {
      const allReceivers = transfers.map((t) => t.to).join(', ') || '(none)'
      return {
        status: 'mismatch_receiver',
        message: `No ${coin} Transfer event found sending to buyer wallet ${buyerWallet}. Found transfers to: ${allReceivers}`,
        details: {
          ...baseDetails,
          actualReceiver: allReceivers,
          expectedAmount: expectedAmount.toString(),
          tokenContract: tokenCfg!.address,
        },
      }
    }

    // Amount check: value is raw token units, convert to human-readable
    const decimals = tokenCfg!.decimals
    const divisor = BigInt(10 ** decimals)
    const actualAmountRaw = matchingTransfer.value
    // Compare in raw units to avoid float rounding
    const expectedRaw = BigInt(expectedAmount.times(new Decimal(10).pow(decimals)).toFixed(0))
    const tolerance = expectedRaw / 100n // 1% tolerance

    const actualAmountHuman = formatTokenAmount(actualAmountRaw, decimals)

    if (actualAmountRaw < expectedRaw - tolerance) {
      return {
        status: 'mismatch_amount',
        message: `Token amount sent (${actualAmountHuman} ${coin}) is less than expected (${expectedAmount.toString()}) by more than 1%`,
        details: {
          ...baseDetails,
          actualReceiver: matchingTransfer.to,
          expectedAmount: expectedAmount.toString(),
          actualAmount: actualAmountHuman,
          tokenContract: tokenCfg!.address,
        },
      }
    }

    void divisor // silence unused warning

    return {
      status: 'verified',
      message: `On-chain verified: ${actualAmountHuman} ${coin} sent to ${matchingTransfer.to} (${confirmations} confirmations)`,
      details: {
        ...baseDetails,
        actualReceiver: matchingTransfer.to,
        expectedAmount: expectedAmount.toString(),
        actualAmount: actualAmountHuman,
        tokenContract: tokenCfg!.address,
        verifiedAt: new Date().toISOString(),
      },
    }
  } catch (err) {
    if (err instanceof EvmRpcError) {
      logger.warn({ err: err.message, txHash, chain: chain.id }, 'blockchainVerification: RPC error during trade tx verify')
      return {
        status: 'rpc_error',
        message: `RPC call failed (${err.message}) — hash stored, buyer should verify manually`,
        details: {
          chain: chain.id,
          rpcChecked: false,
          expectedReceiver: buyerWallet,
          tokenContract: tokenCfg?.address ?? null,
        },
      }
    }
    throw err
  }
}

/**
 * Check whether a sellerTxHash has already been used for another trade.
 * Returns the conflicting trade's orderRef, or null if the hash is fresh.
 */
export async function findDuplicateTradeTxHash(
  txHash: string,
  excludeTradeId?: string,
): Promise<{ orderRef: string; id: string } | null> {
  const existing = await db.trade.findFirst({
    where: {
      sellerTxHash: txHash,
      ...(excludeTradeId ? { id: { not: excludeTradeId } } : {}),
    },
    select: { id: true, orderRef: true },
  })
  return existing ?? null
}

/**
 * Assert no other trade already uses this txHash.
 * Throws AppError(400) if a duplicate is found.
 */
export async function assertNoDuplicateTradeTxHash(
  txHash: string,
  excludeTradeId: string,
): Promise<void> {
  const dupe = await findDuplicateTradeTxHash(txHash, excludeTradeId)
  if (dupe) {
    throw new AppError(
      'DUPLICATE_TX_HASH',
      `Transaction hash has already been submitted for trade ${dupe.orderRef} — each transaction can only be used once`,
      400,
    )
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatNative(wei: bigint): string {
  const divisor = 10n ** 18n
  const whole = wei / divisor
  const remainder = wei % divisor
  if (remainder === 0n) return whole.toString()
  const decimal = remainder.toString().padStart(18, '0').replace(/0+$/, '')
  return `${whole}.${decimal}`
}

function formatTokenAmount(raw: bigint, decimals: number): string {
  const divisor = BigInt(10 ** decimals)
  const whole = raw / divisor
  const remainder = raw % divisor
  if (remainder === 0n) return whole.toString()
  const decimal = remainder.toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${whole}.${decimal}`
}
