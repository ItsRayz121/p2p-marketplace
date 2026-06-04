/**
 * Production-grade blockchain transaction verifier for P2P and CTM trades.
 *
 * Security contract:
 *   'verified'       — RPC confirmed the tx is mined, successful, correct receiver,
 *                      correct token/amount. Trade may proceed immediately.
 *   'admin_verified' — Admin manually confirmed after reviewing on-chain. Same as verified.
 *   'pending'        — Tx is in the mempool but not yet mined. Hard-reject submissions;
 *                      seller must wait for confirmation and resubmit.
 *   'not_found'      — Tx does not exist on this chain. Hard-reject (fake hash).
 *   'skipped'        — Non-EVM/no-RPC chain; hash stored but unverified on-chain.
 *                      Trade transitions to crypto_sent but release is BLOCKED until
 *                      admin manually calls approve-tx-verification.
 *   'rpc_error'      — Our RPC node failed (not a fraud signal). Same hold as skipped.
 *   'reverted'       — Tx was mined but reverted (status=0x0). Hard-reject.
 *   'mismatch_receiver' — Tx sent to wrong address. Hard-reject.
 *   'mismatch_amount'   — Tx amount below trade amount (>1% short). Hard-reject.
 *   'failed'            — Generic failure. Hard-reject.
 */

import { Decimal } from '@prisma/client/runtime/library'
import { AppError } from '../lib/errors'
import { logger } from '../lib/logger'
import { getChainByNetworkLabel, getRpcUrl } from './chainRegistry.service'
import { env } from '../lib/env'
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
  | 'admin_verified'
  | 'failed'
  | 'mismatch_receiver'
  | 'mismatch_amount'
  | 'reverted'
  | 'not_found'
  | 'rpc_error'
  | 'pending'
  | 'skipped'

/** Statuses that are definitive fraud — reject the submission outright. */
export const HARD_REJECT_STATUSES: TxVerificationStatus[] = [
  'reverted', 'mismatch_receiver', 'mismatch_amount', 'failed', 'not_found', 'pending',
]

/** Statuses that hold the trade for admin review (not fraud, but unverified). */
export const ADMIN_REVIEW_STATUSES: TxVerificationStatus[] = ['skipped', 'rpc_error']

/** Statuses that allow the trade to complete without admin intervention. */
export const RELEASE_ALLOWED_STATUSES: TxVerificationStatus[] = ['verified', 'admin_verified']

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

// ── Public entry point ────────────────────────────────────────────────────────

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
      message: `Network ${network} is not in the chain registry — admin must verify manually`,
      details: { rpcChecked: false },
    }
  }

  if (chain.family === 'EVM') {
    return verifyEvmTx(txHash, coin, chain, new Decimal(amount.toString()), buyerWallet)
  }

  if (chain.family === 'TRON') {
    return verifyTronTx(txHash, coin, chain, new Decimal(amount.toString()), buyerWallet)
  }

  // Chains that are on the roadmap but do not yet have an automated verifier.
  // Returning 'skipped' means markCryptoSent stores the hash and notifies admin;
  // the trade is held until an admin manually approves via approve-tx-verification.
  const PLANNED_FAMILIES: Record<string, string> = {
    SOL:   'Solana — verifier not yet implemented',
    TON:   'TON — verifier not yet implemented',
    SUI:   'SUI — verifier not yet implemented',
    APTOS: 'Aptos — verifier not yet implemented',
  }
  const plannedMsg = PLANNED_FAMILIES[(chain.family as string).toUpperCase()]
  return {
    status: 'skipped',
    message: plannedMsg
      ? `${plannedMsg}. Admin must verify the transaction manually.`
      : `On-chain verification for ${chain.family} chains is not yet supported. Admin must verify manually.`,
    details: { chain: chain.id, rpcChecked: false },
  }
}

// ── EVM verifier ──────────────────────────────────────────────────────────────

async function verifyEvmTx(
  txHash: string,
  coin: string,
  chain: Awaited<ReturnType<typeof getChainByNetworkLabel>> & object,
  expectedAmount: Decimal,
  buyerWallet: string,
): Promise<TxVerificationResult> {
  const rpcUrl = getRpcUrl(chain!.id)
  if (!rpcUrl) {
    return {
      status: 'skipped',
      message: `No RPC URL configured for ${chain!.id} — admin must verify manually`,
      details: { chain: chain!.id, rpcChecked: false },
    }
  }

  const isNative = coin.toUpperCase() === chain!.nativeSymbol.toUpperCase()
  const tokenCfg = isNative
    ? null
    : chain!.tokens.find((t: { symbol: string }) => t.symbol.toUpperCase() === coin.toUpperCase())

  if (!isNative && !tokenCfg) {
    return {
      status: 'skipped',
      message: `${coin} is not a whitelisted token on ${chain!.name} — admin must verify manually`,
      details: { chain: chain!.id, rpcChecked: false },
    }
  }

  const expectedReceiver = buyerWallet.toLowerCase()

  try {
    const [receipt, currentBlock] = await Promise.all([
      getTransactionReceiptWithLogs(rpcUrl, chain!.id, txHash),
      getBlockNumber(rpcUrl, chain!.id),
    ])

    // null receipt = tx not yet mined (or dropped from mempool)
    if (!receipt) {
      return {
        status: 'not_found',
        message: 'Transaction not found on chain — the hash does not exist or is still pending. Please ensure the transaction is confirmed and resubmit.',
        details: { chain: chain!.id, rpcChecked: true, expectedReceiver: buyerWallet, tokenContract: (tokenCfg as { address: string | null } | null)?.address ?? null },
      }
    }

    if (receipt.status === '0x0') {
      return {
        status: 'reverted',
        message: 'Transaction was reverted on-chain (receipt status = 0x0) — no tokens were transferred.',
        details: { chain: chain!.id, rpcChecked: true, txStatus: '0x0', expectedReceiver: buyerWallet, tokenContract: (tokenCfg as { address: string | null } | null)?.address ?? null },
      }
    }

    const confirmations = currentBlock >= receipt.blockNumber
      ? Number(currentBlock - receipt.blockNumber + 1n)
      : 0

    // ── Reorg protection ──────────────────────────────────────────────────────
    // A mined tx can still be reorged out until it has >= chain.minConfirmations
    // blocks on top of it. Return 'pending' (a HARD_REJECT status) so the seller
    // is forced to wait and resubmit once the tx is deep enough in the chain.
    if (confirmations < chain!.minConfirmations) {
      return {
        status: 'pending',
        message: `Transaction mined but only ${confirmations} of ${chain!.minConfirmations} required confirmations. Please wait and resubmit once fully confirmed.`,
        details: {
          chain: chain!.id,
          rpcChecked: true,
          txStatus: receipt.status as '0x1',
          expectedReceiver: buyerWallet,
          confirmations,
          threshold: chain!.minConfirmations,
          tokenContract: (tokenCfg as { address: string | null } | null)?.address ?? null,
        },
      }
    }

    const baseDetails = {
      chain: chain!.id,
      rpcChecked: true,
      txStatus: receipt.status as '0x1',
      expectedReceiver: buyerWallet,
      confirmations,
      threshold: chain!.minConfirmations,
      tokenContract: (tokenCfg as { address: string | null } | null)?.address ?? null,
    }

    if (isNative) {
      const tx = await getTransactionByHash(rpcUrl, chain!.id, txHash)
      if (!tx) {
        return { status: 'rpc_error', message: 'Receipt found but transaction body missing — RPC inconsistency.', details: baseDetails }
      }

      const actualReceiver = tx.to?.toLowerCase() ?? null
      if (actualReceiver !== expectedReceiver) {
        return {
          status: 'mismatch_receiver',
          message: `Transaction sends to ${actualReceiver ?? '(null)'} — expected buyer wallet ${buyerWallet}.`,
          details: { ...baseDetails, actualReceiver, expectedAmount: expectedAmount.toString(), actualAmount: formatNative(tx.value) },
        }
      }

      const expectedWei = BigInt(expectedAmount.times(new Decimal(10).pow(18)).toFixed(0))
      const tolerance = expectedWei / 100n
      if (tx.value < expectedWei - tolerance) {
        return {
          status: 'mismatch_amount',
          message: `Sent ${formatNative(tx.value)} ${coin} — expected at least ${expectedAmount.toString()} (1% tolerance).`,
          details: { ...baseDetails, actualReceiver, expectedAmount: expectedAmount.toString(), actualAmount: formatNative(tx.value) },
        }
      }

      return {
        status: 'verified',
        message: `Verified: ${formatNative(tx.value)} ${coin} → ${actualReceiver} (${confirmations} confirmations).`,
        details: { ...baseDetails, actualReceiver, expectedAmount: expectedAmount.toString(), actualAmount: formatNative(tx.value), verifiedAt: new Date().toISOString() },
      }
    }

    // ERC-20
    const tc = tokenCfg as { address: string; decimals: number }
    const transfers = parseErc20Transfers(receipt.logs, tc.address)
    const match = transfers.find((t) => t.to.toLowerCase() === expectedReceiver)

    if (!match) {
      const found = transfers.map((t) => t.to).join(', ') || '(none)'
      return {
        status: 'mismatch_receiver',
        message: `No ${coin} Transfer to buyer wallet ${buyerWallet}. Transfers found to: ${found}.`,
        details: { ...baseDetails, actualReceiver: found, expectedAmount: expectedAmount.toString(), tokenContract: tc.address },
      }
    }

    const expectedRaw = BigInt(expectedAmount.times(new Decimal(10).pow(tc.decimals)).toFixed(0))
    const tolerance = expectedRaw / 100n
    const actualHuman = formatTokenAmount(match.value, tc.decimals)

    if (match.value < expectedRaw - tolerance) {
      return {
        status: 'mismatch_amount',
        message: `Sent ${actualHuman} ${coin} — expected at least ${expectedAmount.toString()} (1% tolerance).`,
        details: { ...baseDetails, actualReceiver: match.to, expectedAmount: expectedAmount.toString(), actualAmount: actualHuman, tokenContract: tc.address },
      }
    }

    return {
      status: 'verified',
      message: `Verified: ${actualHuman} ${coin} → ${match.to} (${confirmations} confirmations).`,
      details: { ...baseDetails, actualReceiver: match.to, expectedAmount: expectedAmount.toString(), actualAmount: actualHuman, tokenContract: tc.address, verifiedAt: new Date().toISOString() },
    }
  } catch (err) {
    if (err instanceof EvmRpcError) {
      logger.warn({ err: err.message, txHash, chain: chain!.id }, 'blockchainVerification: EVM RPC error')
      return {
        status: 'rpc_error',
        message: `RPC call failed (${err.message}) — admin must verify manually.`,
        details: { chain: chain!.id, rpcChecked: false, expectedReceiver: buyerWallet, tokenContract: (tokenCfg as { address: string | null } | null)?.address ?? null },
      }
    }
    throw err
  }
}

// ── TRON verifier ─────────────────────────────────────────────────────────────

interface TronApiTransaction {
  txID?: string
  ret?: Array<{ contractRet?: string }>
  raw_data?: {
    contract?: Array<{
      type?: string
      parameter?: {
        value?: {
          owner_address?: string
          to_address?: string       // TransferContract (native TRX)
          amount?: number           // TransferContract: µTRX
          contract_address?: string // TriggerSmartContract: TRC20 token address (hex)
          data?: string             // TriggerSmartContract: ABI-encoded call
        }
      }
    }>
  }
}

interface TronEventResult {
  data?: Array<{
    event_name?: string
    contract_address?: string
    result?: {
      from?: string
      to?: string
      value?: string
    }
    block_number?: number
  }>
}

async function tronApiGet<T>(path: string): Promise<T> {
  const base = env.TRON_FULLNODE_URL.replace(/\/$/, '')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  try {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (env.TRONGRID_API_KEY) headers['TRON-PRO-API-KEY'] = env.TRONGRID_API_KEY
    const res = await fetch(`${base}${path}`, { headers, signal: controller.signal })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`TRON API HTTP ${res.status}: ${body.slice(0, 200)}`)
    }
    return await res.json() as T
  } catch (err) {
    if (err instanceof Error) throw err
    throw new Error('unknown tron api error')
  } finally {
    clearTimeout(timeout)
  }
}

// TRC20 transfer selector: keccak256("transfer(address,uint256)") first 4 bytes
const TRC20_TRANSFER_SELECTOR = 'a9059cbb'

async function verifyTronTx(
  txHash: string,
  coin: string,
  chain: Awaited<ReturnType<typeof getChainByNetworkLabel>> & object,
  expectedAmount: Decimal,
  buyerWallet: string,
): Promise<TxVerificationResult> {
  const isNative = coin.toUpperCase() === chain!.nativeSymbol.toUpperCase()
  const tokenCfg = isNative
    ? null
    : chain!.tokens.find((t: { symbol: string }) => t.symbol.toUpperCase() === coin.toUpperCase())

  if (!isNative && !tokenCfg) {
    return {
      status: 'skipped',
      message: `${coin} is not a whitelisted token on ${chain!.name} — admin must verify manually.`,
      details: { chain: chain!.id, rpcChecked: false },
    }
  }

  try {
    // ── 1. Fetch transaction ──────────────────────────────────────────────────
    const txResp = await tronApiGet<{ data?: TronApiTransaction[] }>(`/v1/transactions/${txHash}`)
    const tx = txResp.data?.[0]

    if (!tx || !tx.txID) {
      return {
        status: 'not_found',
        message: 'Transaction not found on TRON — the hash does not exist or is still pending.',
        details: { chain: chain!.id, rpcChecked: true, expectedReceiver: buyerWallet },
      }
    }

    const contractRet = tx.ret?.[0]?.contractRet ?? 'UNKNOWN'
    if (contractRet !== 'SUCCESS') {
      return {
        status: 'reverted',
        message: `TRON transaction failed: contractRet = ${contractRet}.`,
        details: { chain: chain!.id, rpcChecked: true, txStatus: '0x0', expectedReceiver: buyerWallet },
      }
    }

    const contract = tx.raw_data?.contract?.[0]
    const contractType = contract?.type

    // ── 2. Native TRX transfer ────────────────────────────────────────────────
    if (isNative) {
      if (contractType !== 'TransferContract') {
        return {
          status: 'mismatch_receiver',
          message: `Expected a TRX transfer (TransferContract) but got ${contractType}.`,
          details: { chain: chain!.id, rpcChecked: true, expectedReceiver: buyerWallet },
        }
      }
      const toHex = contract?.parameter?.value?.to_address ?? ''
      // Convert the hex to_address (41…) to base58 (T…) using TronWeb for
      // a proper format-agnostic comparison with the buyer's wallet address.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const TW = require('tronweb') as { address: { fromHex(h: string): string } }
      let actualReceiver58: string
      try { actualReceiver58 = TW.address.fromHex(toHex) } catch { actualReceiver58 = toHex }

      if (actualReceiver58.toLowerCase() !== buyerWallet.toLowerCase()) {
        return {
          status: 'mismatch_receiver',
          message: `TRX sent to ${actualReceiver58} — expected buyer wallet ${buyerWallet}.`,
          details: { chain: chain!.id, rpcChecked: true, expectedReceiver: buyerWallet, actualReceiver: actualReceiver58 },
        }
      }
      const amountSun = contract?.parameter?.value?.amount ?? 0
      const actualTrx = amountSun / 1_000_000
      const expectedTrx = expectedAmount.toNumber()
      if (actualTrx < expectedTrx * 0.99) {
        return {
          status: 'mismatch_amount',
          message: `Sent ${actualTrx} TRX — expected at least ${expectedTrx} TRX (1% tolerance).`,
          details: { chain: chain!.id, rpcChecked: true, expectedReceiver: buyerWallet, expectedAmount: expectedTrx.toString(), actualAmount: actualTrx.toString() },
        }
      }
      return {
        status: 'verified',
        message: `Verified: ${actualTrx} TRX → ${toHex}.`,
        details: { chain: chain!.id, rpcChecked: true, txStatus: '0x1', expectedReceiver: buyerWallet, actualReceiver: toHex, expectedAmount: expectedTrx.toString(), actualAmount: actualTrx.toString(), verifiedAt: new Date().toISOString() },
      }
    }

    // ── 3. TRC20 transfer via events API ──────────────────────────────────────
    if (contractType !== 'TriggerSmartContract') {
      return {
        status: 'mismatch_receiver',
        message: `Expected TRC20 TriggerSmartContract but got ${contractType}.`,
        details: { chain: chain!.id, rpcChecked: true, expectedReceiver: buyerWallet },
      }
    }

    const contractAddrHex = contract?.parameter?.value?.contract_address ?? ''
    const tc = tokenCfg as { address: string; decimals: number }

    // Normalise both addresses to base58 via TronWeb so we can compare regardless
    // of whether the DB stores base58 (TR7NHqje…) or hex (41a614f8…).
    // TronWeb.address.fromHex returns base58; toHex returns '41…' hex.
    let contractAddrBase58: string
    let tcAddrBase58: string
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const TW = require('tronweb') as { address: { fromHex(h: string): string } }
      contractAddrBase58 = TW.address.fromHex(contractAddrHex)
      tcAddrBase58 = tc.address.startsWith('T') && tc.address.length === 34
        ? tc.address
        : TW.address.fromHex(tc.address)
    } catch {
      // Conversion failed — fall through and rely on events API comparison only
      contractAddrBase58 = contractAddrHex
      tcAddrBase58 = tc.address
    }

    if (contractAddrBase58.toLowerCase() !== tcAddrBase58.toLowerCase()) {
      return {
        status: 'mismatch_receiver',
        message: `Token contract ${contractAddrBase58} does not match expected ${tcAddrBase58} for ${coin}.`,
        details: { chain: chain!.id, rpcChecked: true, expectedReceiver: buyerWallet, tokenContract: tc.address },
      }
    }

    // Parse ABI data for to-address + amount as fallback, but prefer events API
    const data = contract?.parameter?.value?.data ?? ''
    let actualReceiverFromData: string | null = null
    let amountFromData: bigint | null = null

    if (data.startsWith(TRC20_TRANSFER_SELECTOR) && data.length >= 8 + 64 + 64) {
      const toHex32 = data.slice(8, 72)  // 32 bytes = 64 hex chars
      actualReceiverFromData = '0x' + toHex32.slice(-40)
      try { amountFromData = BigInt('0x' + data.slice(72, 136)) } catch { /* ignore */ }
    }

    // Fetch events for definitive address (base58) comparison
    let eventsResp: TronEventResult | null = null
    try {
      eventsResp = await tronApiGet<TronEventResult>(`/v1/transactions/${txHash}/events`)
    } catch {
      // Events API failure — fall back to ABI-decoded data
    }

    const transferEvent = eventsResp?.data?.find(
      (e) => e.event_name === 'Transfer' &&
        e.contract_address?.toLowerCase() === tc.address.toLowerCase(),
    )

    let actualReceiver: string | null = null
    let actualAmountRaw: bigint | null = null

    if (transferEvent?.result) {
      actualReceiver = transferEvent.result.to ?? null
      try { actualAmountRaw = transferEvent.result.value ? BigInt(transferEvent.result.value) : null } catch { /* ignore */ }
    } else if (actualReceiverFromData) {
      actualReceiver = actualReceiverFromData
      actualAmountRaw = amountFromData
    }

    if (!actualReceiver) {
      return {
        status: 'rpc_error',
        message: 'Could not parse Transfer event or ABI data from TRON transaction — admin must verify manually.',
        details: { chain: chain!.id, rpcChecked: true, expectedReceiver: buyerWallet, tokenContract: tc.address },
      }
    }

    // Address comparison: normalise to lowercase, handle both base58 and hex formats
    const receiverNorm = actualReceiver.toLowerCase()
    const buyerNorm2 = buyerWallet.toLowerCase()
    if (receiverNorm !== buyerNorm2) {
      return {
        status: 'mismatch_receiver',
        message: `${coin} sent to ${actualReceiver} — expected buyer wallet ${buyerWallet}.`,
        details: { chain: chain!.id, rpcChecked: true, expectedReceiver: buyerWallet, actualReceiver, tokenContract: tc.address },
      }
    }

    if (actualAmountRaw !== null) {
      const expectedRaw = BigInt(expectedAmount.times(new Decimal(10).pow(tc.decimals)).toFixed(0))
      const tolerance = expectedRaw / 100n
      const actualHuman = formatTokenAmount(actualAmountRaw, tc.decimals)
      if (actualAmountRaw < expectedRaw - tolerance) {
        return {
          status: 'mismatch_amount',
          message: `Sent ${actualHuman} ${coin} — expected at least ${expectedAmount.toString()} (1% tolerance).`,
          details: { chain: chain!.id, rpcChecked: true, expectedReceiver: buyerWallet, actualReceiver, expectedAmount: expectedAmount.toString(), actualAmount: actualHuman, tokenContract: tc.address },
        }
      }
      return {
        status: 'verified',
        message: `Verified: ${actualHuman} ${coin} → ${actualReceiver}.`,
        details: { chain: chain!.id, rpcChecked: true, txStatus: '0x1', expectedReceiver: buyerWallet, actualReceiver, expectedAmount: expectedAmount.toString(), actualAmount: actualHuman, tokenContract: tc.address, verifiedAt: new Date().toISOString() },
      }
    }

    // Amount not parseable — receiver is correct, mark as verified without amount check (log warning)
    logger.warn({ txHash, coin, chain: chain!.id }, 'TRON verifier: could not parse transfer amount — receiver matched, treating as verified')
    return {
      status: 'verified',
      message: `Verified receiver only (amount not parseable): ${coin} → ${actualReceiver}.`,
      details: { chain: chain!.id, rpcChecked: true, txStatus: '0x1', expectedReceiver: buyerWallet, actualReceiver, tokenContract: tc.address, verifiedAt: new Date().toISOString() },
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error'
    logger.warn({ err: msg, txHash, chain: chain!.id }, 'blockchainVerification: TRON API error')
    return {
      status: 'rpc_error',
      message: `TRON API call failed (${msg}) — admin must verify manually.`,
      details: { chain: chain!.id, rpcChecked: false, expectedReceiver: buyerWallet },
    }
  }
}

// ── Duplicate guard ───────────────────────────────────────────────────────────

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

export async function assertNoDuplicateTradeTxHash(
  txHash: string,
  excludeTradeId: string,
): Promise<void> {
  // Check P2P trades
  const dupe = await findDuplicateTradeTxHash(txHash, excludeTradeId)
  if (dupe) {
    throw new AppError(
      'DUPLICATE_TX_HASH',
      `Transaction hash has already been submitted for trade ${dupe.orderRef} — each transaction can only be used once.`,
      400,
    )
  }

  // Cross-table: check CTM proofs so the same hash can't prove a P2P trade AND a CTM trade
  const ctmDupe = await db.ctmTradeProof.findFirst({
    where: { txHash },
    select: { tradeId: true },
  })
  if (ctmDupe) {
    throw new AppError(
      'DUPLICATE_TX_HASH',
      `Transaction hash has already been submitted as proof for a CTM trade — each transaction can only be used once.`,
      400,
    )
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatNative(wei: bigint): string {
  const divisor = 10n ** 18n
  const whole = wei / divisor
  const remainder = wei % divisor
  if (remainder === 0n) return whole.toString()
  return `${whole}.${remainder.toString().padStart(18, '0').replace(/0+$/, '')}`
}

function formatTokenAmount(raw: bigint, decimals: number): string {
  const divisor = 10n ** BigInt(decimals)
  const whole = raw / divisor
  const remainder = raw % divisor
  if (remainder === 0n) return whole.toString()
  return `${whole}.${remainder.toString().padStart(decimals, '0').replace(/0+$/, '')}`
}
