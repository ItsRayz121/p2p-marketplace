// Fallback EVM payment poller — defence-in-depth against missed Moralis webhooks.
// Runs every 30 s. Scans recent blocks on each configured EVM payment network for
// USDT Transfer events to the gas deposit address, then applies the same matching
// logic as webhook.routes.ts. Also catches payments that arrived before a gas
// order expired but were never attributed (e.g. Moralis fired late or not at all).
//
// Status written on match: payment_verified (awaiting admin "Release Gas" action).
// Delivery is NOT queued automatically — admin must click Release Gas.

import { createPublicClient, http, parseAbiItem } from 'viem'
import { bsc, mainnet } from 'viem/chains'
import { db } from '../lib/prisma'
import { redis } from '../lib/redis'
import { logger } from '../lib/logger'
import { env } from '../lib/env'
import { sendAdminAlertEmail } from '../services/email.service'
import { createAdminNotif } from '../services/adminNotification.service'
import { appendLedgerEntry } from '../lib/gas/gas.ledger'
import { fromDbChain } from '../lib/gas/gas.chains'
import type { GasChainId } from '../lib/gas/gas.chains'

// ERC20 Transfer(from, to, value) — indexed from + to allow topic-filter on 'to'
const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
)

// Grace window: attribute payments to orders that expired at most this many ms ago.
// Covers the case where Moralis fires after the order expiry job has already run.
const GRACE_WINDOW_MS = 15 * 60 * 1000 // 15 minutes

interface NetworkConfig {
  paymentNetwork: string
  viemChain: typeof bsc | typeof mainnet
  rpcUrl: () => string
  usdtContract: `0x${string}`
  usdtDecimals: number
  depositAddressDbKey: string
  depositAddressEnvFn: () => string | undefined
  // How many blocks ≈ the scan window. Keeps getLogs range reasonable.
  // BSC  ~3 s/block → 100 blocks ≈ 5 min
  // ETH ~12 s/block →  30 blocks ≈ 6 min
  scanBlocks: number
  // Minimum block confirmations required before marking payment_verified.
  minConfirmations: number
}

const NETWORK_CONFIGS: NetworkConfig[] = [
  {
    paymentNetwork:      'BEP20',
    viemChain:           bsc,
    rpcUrl:              () => env.BSC_RPC_URL,
    usdtContract:        '0x55d398326f99059fF775485246999027B3197955',
    usdtDecimals:        18,  // Binance-Peg USDT on BSC uses 18 decimals
    depositAddressDbKey: 'gas_usdt_bep20_address',
    depositAddressEnvFn: () => env.GAS_FEE_DEPOSIT_ADDRESS_BEP20,
    scanBlocks:          100,
    minConfirmations:    3,
  },
  {
    paymentNetwork:      'ERC20',
    viemChain:           mainnet,
    rpcUrl:              () => env.ETHEREUM_RPC_URL,
    usdtContract:        '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    usdtDecimals:        6,
    depositAddressDbKey: 'gas_usdt_erc20_address',
    depositAddressEnvFn: () => env.GAS_FEE_DEPOSIT_ADDRESS_ERC20,
    scanBlocks:          30,
    minConfirmations:    6,
  },
]

// Resolve deposit address: DB override takes precedence over env var.
async function resolveDepositAddress(cfg: NetworkConfig): Promise<string | null> {
  const dbOverride = await db.platformConfig.findUnique({ where: { key: cfg.depositAddressDbKey } })
  if (dbOverride?.value) return dbOverride.value
  return cfg.depositAddressEnvFn() ?? null
}

async function scanNetwork(cfg: NetworkConfig): Promise<void> {
  const depositAddress = await resolveDepositAddress(cfg)
  if (!depositAddress) return  // network not configured

  // Skip if no actionable orders (payment_pending, payment_uploaded, or recently-expired).
  const graceCutoff = new Date(Date.now() - GRACE_WINDOW_MS)
  const activeOrExpired = await db.gasFeeOrder.count({
    where: {
      paymentNetwork: cfg.paymentNetwork,
      status: { in: ['payment_pending', 'payment_uploaded', 'expired'] },
      expiresAt: { gte: graceCutoff },
    },
  })
  if (activeOrExpired === 0) return

  const client = createPublicClient({
    chain: cfg.viemChain,
    transport: http(cfg.rpcUrl(), { timeout: 10_000 }),
  })

  // Determine block range: last-checked block → current block.
  const redisKey = `gas_poller_last_block:${cfg.paymentNetwork}`
  const currentBlock = await client.getBlockNumber()

  const storedBlock = await redis.get(redisKey)
  const fromBlock = storedBlock
    ? BigInt(storedBlock) + 1n
    : currentBlock - BigInt(cfg.scanBlocks)

  // Nothing new since last run.
  if (fromBlock > currentBlock) return

  // Cap range to scanBlocks to avoid oversized getLogs calls on first run or after
  // a long gap. getLogs range limits vary per provider; 500 blocks is very safe.
  const maxRange = BigInt(Math.max(cfg.scanBlocks, 500))
  const effectiveFrom = fromBlock < currentBlock - maxRange
    ? currentBlock - maxRange
    : fromBlock

  let logs
  try {
    logs = await client.getLogs({
      address: cfg.usdtContract,
      event:   TRANSFER_EVENT,
      args:    { to: depositAddress as `0x${string}` },
      fromBlock: effectiveFrom,
      toBlock:   currentBlock,
    })
  } catch (err) {
    logger.warn({ err, network: cfg.paymentNetwork, effectiveFrom: effectiveFrom.toString(), currentBlock: currentBlock.toString() }, 'gasPaymentPoller: getLogs failed — will retry next tick')
    return  // don't advance the cursor so we retry same range
  }

  // Advance cursor even when logs is empty so we don't re-scan old blocks.
  await redis.set(redisKey, currentBlock.toString())

  if (logs.length === 0) return

  logger.info(
    { network: cfg.paymentNetwork, count: logs.length, from: effectiveFrom.toString(), to: currentBlock.toString() },
    'gasPaymentPoller: found Transfer events',
  )

  for (const log of logs) {
    const txHash = log.transactionHash
    if (!txHash) continue

    const rawValue = log.args.value
    if (rawValue === undefined || rawValue === null) continue

    // Confirmation check — only verify payments with enough block depth.
    const confirmations = log.blockNumber != null
      ? Number(currentBlock) - Number(log.blockNumber)
      : 0
    if (confirmations < cfg.minConfirmations) continue

    // Convert raw token units to USDT decimal amount.
    const incoming = Number(rawValue) / Math.pow(10, cfg.usdtDecimals)
    if (!(incoming > 0)) continue

    // Duplicate guard: skip if already attributed to a gas order that is past the
    // verification stage. We must NOT skip payment_uploaded orders whose paymentTxHash
    // was set by the user submitting proof — those are exactly what Pass 1 handles.
    const alreadyUsed = await db.gasFeeOrder.findFirst({
      where: {
        paymentTxHash: txHash,
        status: { notIn: ['payment_uploaded'] },
      },
    })
    if (alreadyUsed) continue

    const senderAddress = log.args.from ?? undefined

    const lo = (incoming * 0.99).toFixed(4)
    const hi = (incoming * 1.01).toFixed(4)

    // ── Pass 1: payment_uploaded orders where user submitted this exact tx hash ─
    // Strongest signal — user explicitly provided the hash; skip amount tolerance.
    const txHashUploadedOrder = await db.gasFeeOrder.findFirst({
      where: {
        status:         'payment_uploaded',
        paymentNetwork: cfg.paymentNetwork,
        paymentTxHash:  txHash,
      },
    })

    if (txHashUploadedOrder) {
      const claimed = await db.gasFeeOrder.updateMany({
        where: { id: txHashUploadedOrder.id, status: 'payment_uploaded' },
        data: {
          status:               'payment_verified',
          paymentVerifiedAt:    new Date(),
          verifiedAmount:       incoming,
          verifiedAsset:        'USDT',
          verifiedConfirmations: confirmations,
        },
      })
      if (claimed.count > 0) {
        void recordVerifiedPayment(txHashUploadedOrder.id, txHashUploadedOrder.orderRef, txHashUploadedOrder.chain, txHash, incoming, confirmations, cfg, senderAddress)
      }
      continue
    }

    // ── Pass 2: amount-based match — payment_pending OR payment_uploaded (no hash yet) ──
    const activeOrder = await db.gasFeeOrder.findFirst({
      where: {
        status:         { in: ['payment_pending', 'payment_uploaded'] },
        paymentNetwork: cfg.paymentNetwork,
        paymentAmount:  { gte: lo, lte: hi },
        paymentTxHash:  null,
        expiresAt:      { gt: new Date() },
      },
      orderBy: { createdAt: 'asc' },
    })

    if (activeOrder) {
      const claimed = await db.gasFeeOrder.updateMany({
        where: { id: activeOrder.id, status: { in: ['payment_pending', 'payment_uploaded'] }, paymentTxHash: null },
        data: {
          status:               'payment_verified',
          paymentTxHash:        txHash,
          paymentVerifiedAt:    new Date(),
          verifiedAmount:       incoming,
          verifiedAsset:        'USDT',
          verifiedConfirmations: confirmations,
        },
      })
      if (claimed.count > 0) {
        void recordVerifiedPayment(activeOrder.id, activeOrder.orderRef, activeOrder.chain, txHash, incoming, confirmations, cfg, senderAddress)
      }
      continue
    }

    // ── Pass 3: grace match — recently-expired orders where payment arrived on time ──
    const expiredOrder = await db.gasFeeOrder.findFirst({
      where: {
        status:         'expired',
        paymentNetwork: cfg.paymentNetwork,
        paymentAmount:  { gte: lo, lte: hi },
        expiresAt:      { gte: graceCutoff },
        paymentTxHash:  null,
      },
      orderBy: { createdAt: 'asc' },
    })

    if (expiredOrder) {
      // Fetch block to check on-chain timestamp vs order expiry.
      let blockTimestampMs: number | null = null
      try {
        if (log.blockNumber != null) {
          const block = await client.getBlock({ blockNumber: log.blockNumber })
          blockTimestampMs = Number(block.timestamp) * 1000
        }
      } catch (err) {
        logger.warn({ err, txHash }, 'gasPaymentPoller: could not fetch block timestamp for grace check')
      }

      const paidBeforeExpiry =
        blockTimestampMs === null ||
        blockTimestampMs < expiredOrder.expiresAt.getTime()

      if (paidBeforeExpiry) {
        const claimed = await db.gasFeeOrder.updateMany({
          where: { id: expiredOrder.id, status: 'expired', paymentTxHash: null },
          data: {
            status:               'payment_verified',
            paymentTxHash:        txHash,
            paymentVerifiedAt:    new Date(),
            verifiedAmount:       incoming,
            verifiedAsset:        'USDT',
            verifiedConfirmations: confirmations,
          },
        })
        if (claimed.count > 0) {
          void recordVerifiedPayment(expiredOrder.id, expiredOrder.orderRef, expiredOrder.chain, txHash, incoming, confirmations, cfg, senderAddress)
          sendAdminAlertEmail(
            `Gas Order Resurrected — Late Payment Detection`,
            `Order ref: ${expiredOrder.orderRef}\nOrder ID: ${expiredOrder.id}\nNetwork: ${cfg.paymentNetwork}\nAmount: ${incoming} USDT\nTx Hash: ${txHash}\n\nPayment was on-chain before expiry but Moralis never fired. The poller detected and attributed it. Admin must release gas manually.`,
          ).catch(() => {})
        }
        continue
      }
    }

    // ── No match — record as unattributed for admin review ──────────────────────
    const member = JSON.stringify({
      txHash,
      amount: incoming.toFixed(4),
      network: cfg.paymentNetwork,
      toAddress: depositAddress,
      paymentNote: 'poller_no_match',
      detectedAt: new Date().toISOString(),
    })
    await redis.zadd('gas_unattributed', Date.now(), member)
    await redis.zremrangebyrank('gas_unattributed', 0, -101)
    logger.warn({ txHash, incoming, network: cfg.paymentNetwork }, 'gasPaymentPoller: unattributed transfer — no matching order')
    void createAdminNotif({
      category: 'GAS',
      title: `Unattributed Deposit — ${incoming.toFixed(2)} USDT (${cfg.paymentNetwork})`,
      body: `Received ${incoming.toFixed(4)} USDT but no matching order found. Needs manual attribution. Tx: ${txHash.slice(0, 12)}…`,
      href: '/admin/gas/flagged',
      metadata: { txHash, amount: incoming.toFixed(4), network: cfg.paymentNetwork },
    })
  }
}

// Shared post-match logic: write ledger entry + admin notification.
// Runs fire-and-forget (void) so errors never block the poller loop.
async function recordVerifiedPayment(
  orderId: string,
  orderRef: string,
  orderChain: string,
  txHash: string,
  incoming: number,
  confirmations: number,
  cfg: NetworkConfig,
  senderAddress: string | undefined,
): Promise<void> {
  try {
    appendLedgerEntry({
      entryType:      'order_payment',
      chain:          fromDbChain(orderChain) as GasChainId,
      nativeAmount:   0,          // USDT is ERC20 — no native token moved
      usdAmount:      incoming,   // USDT ≈ USD 1:1
      tokenSymbol:    'USDT',
      tokenAmount:    incoming,
      txHash,
      ...(senderAddress !== undefined ? { fromAddress: senderAddress } : {}),
      relatedOrderId: orderId,
    }).catch((e) => logger.warn({ err: e, orderId }, 'Failed to write order_payment ledger entry'))

    void createAdminNotif({
      category: 'GAS',
      title: `Payment Verified — ${incoming.toFixed(2)} USDT (${cfg.paymentNetwork})`,
      body: `Order ${orderRef} payment verified on-chain (${confirmations} confirmations). Ready to release gas. Tx: ${txHash.slice(0, 12)}…`,
      href: `/admin/gas/orders/${orderRef}`,
      metadata: { txHash, amount: incoming.toFixed(4), network: cfg.paymentNetwork, orderId, confirmations },
    })

    logger.info({ txHash, orderId, network: cfg.paymentNetwork, incoming, confirmations }, 'gasPaymentPoller: payment verified — awaiting admin release')
  } catch (err) {
    logger.warn({ err, orderId, txHash }, 'gasPaymentPoller: recordVerifiedPayment failed')
  }
}

export async function runGasPaymentPoller(): Promise<void> {
  for (const cfg of NETWORK_CONFIGS) {
    try {
      await scanNetwork(cfg)
    } catch (err) {
      logger.error({ err, network: cfg.paymentNetwork }, 'gasPaymentPoller: scanNetwork threw unexpectedly')
    }
  }
}
