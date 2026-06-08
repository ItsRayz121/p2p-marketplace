/**
 * Reconciliation engine — compares DB order records against on-chain truth.
 *
 * Detects:
 *   - delivery_tx_not_found   : delivered in DB but tx hash missing or not confirmed on-chain
 *   - amount_mismatch         : on-chain tx value ≠ order's gasAmountNative
 *   - payment_not_on_chain    : payment_detected in DB but payment tx not found
 *   - stuck_sending           : order in `sending` state for > 30 min
 */

import type { GasChain } from '@prisma/client'
import { parseEther } from 'viem'
import { db } from '../prisma'
import { logger } from '../logger'
import { sendAdminAlertEmail } from '../../services/email.service'
import { checkTxConfirmed } from './gas.confirmation'
import type { GasChainId } from './gas.chains'
import { fromDbChain } from './gas.chains'
import { getTransactionByHash } from '../evmRpc'
import { getRpcUrl } from '../../services/chainRegistry.service'

const STUCK_SENDING_MIN = 30 // minutes before a `sending` order is flagged

// Delivery-chain (GasChain enum) → chain slug accepted by getRpcUrl. Only EVM
// chains we hold an RPC URL for support on-chain amount/payment verification.
const GAS_CHAIN_TO_SLUG: Partial<Record<GasChain, string>> = {
  ETH: 'ethereum', BSC: 'bsc', MATIC: 'polygon', ARB: 'arbitrum', OP: 'optimism', BASE: 'base',
}

// Payment-network label → chain slug for verifying the inbound payment tx exists.
const PAYMENT_NETWORK_TO_SLUG: Record<string, string> = {
  BEP20: 'bsc', ERC20: 'ethereum',
}

/**
 * A9: compare the on-chain delivered native value to the order's gasAmountNative
 * (EVM only). Catches ledger drift where we recorded a delivery but sent the
 * wrong amount. 1% tolerance absorbs gas-rounding. Best-effort: RPC errors skip.
 */
async function checkDeliveryAmount(
  order: { id: string; orderRef: string; deliveryTxHash: string | null; gasAmountNative: unknown },
  dbChain: GasChain,
  discrepancies: Array<{ orderId?: string; type: string; description: string }>,
): Promise<void> {
  if (!order.deliveryTxHash) return
  const slug = GAS_CHAIN_TO_SLUG[dbChain]
  if (!slug) return
  const rpcUrl = getRpcUrl(slug)
  if (!rpcUrl) return
  try {
    const tx = await getTransactionByHash(rpcUrl, slug, order.deliveryTxHash)
    if (!tx) return // existence handled by the confirmation check
    const expectedWei = parseEther(String(order.gasAmountNative))
    const actualWei = tx.value
    const diff = actualWei > expectedWei ? actualWei - expectedWei : expectedWei - actualWei
    const tolerance = expectedWei / 100n // 1%
    if (diff > tolerance) {
      discrepancies.push({
        orderId: order.id,
        type: 'amount_mismatch',
        description: `Order ${order.orderRef} delivered ${actualWei} wei on-chain but expected ~${expectedWei} wei (gasAmountNative=${String(order.gasAmountNative)})`,
      })
    }
  } catch {
    // RPC error — skip silently; confirmation check covers missing/unconfirmed txs.
  }
}

// ── Main entry ────────────────────────────────────────────────────────────────

export async function runReconciliation(chain?: GasChain) {
  const run = await db.gasReconciliationRun.create({
    data: { chain: chain ?? null, status: 'running' },
  })

  try {
    let totalOrders = 0
    let ordersChecked = 0
    const discrepancies: Array<{ orderId?: string; type: string; description: string }> = []

    const chains: GasChain[] = chain
      ? [chain]
      : ['TRON', 'BSC', 'ETH', 'BASE', 'ARB', 'OP', 'MATIC', 'AVAX']

    for (const c of chains) {
      const chainId = fromDbChain(c)
      const result = await reconcileChain(chainId, c)
      totalOrders   += result.totalOrders
      ordersChecked += result.ordersChecked
      discrepancies.push(...result.discrepancies)
    }

    // Detect stuck `sending` orders (cross-chain)
    const stuckResult = await detectStuckSending(chain)
    discrepancies.push(...stuckResult)

    // A9: detect payments recorded in DB that aren't actually on-chain (EVM payment networks)
    const paymentResult = await detectPaymentNotOnChain()
    discrepancies.push(...paymentResult)

    // Write discrepancy rows
    if (discrepancies.length > 0) {
      await db.gasReconciliationDiscrepancy.createMany({
        data: discrepancies.map((d) => ({
          runId:       run.id,
          orderId:     d.orderId ?? null,
          type:        d.type,
          description: d.description,
        })),
      })
    }

    const updated = await db.gasReconciliationRun.update({
      where: { id: run.id },
      data: {
        totalOrders,
        ordersChecked,
        discrepancyCount: discrepancies.length,
        status: 'complete',
      },
    })

    logger.info(
      { runId: run.id, totalOrders, ordersChecked, discrepancyCount: discrepancies.length },
      'Reconciliation run complete',
    )

    if (discrepancies.length > 0) {
      await sendAdminAlertEmail(
        `Gas Reconciliation: ${discrepancies.length} discrepancies found`,
        `Reconciliation run ${run.id} found ${discrepancies.length} discrepancies.\n\n` +
        discrepancies.map((d) => `[${d.type}] Order ${d.orderId ?? 'N/A'}: ${d.description}`).join('\n') +
        `\n\nView details at /admin/gas/reconciliation/${run.id}`,
      ).catch(() => {})
    }

    return updated
  } catch (err) {
    await db.gasReconciliationRun.update({
      where: { id: run.id },
      data: { status: 'failed', notes: err instanceof Error ? err.message : String(err) },
    })
    logger.error({ err, runId: run.id }, 'Reconciliation run failed')
    throw err
  }
}

// ── Per-chain reconciliation ───────────────────────────────────────────────────

async function reconcileChain(chainId: GasChainId, dbChain: GasChain) {
  const discrepancies: Array<{ orderId?: string; type: string; description: string }> = []

  // Orders delivered in the last 7 days — far enough back to catch stragglers
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

  const orders = await db.gasFeeOrder.findMany({
    where: {
      chain: dbChain,
      status: { in: ['delivered'] },
      deliveredAt: { gte: since },
    },
    select: {
      id: true,
      orderRef: true,
      deliveryTxHash: true,
      gasAmountNative: true,
      deliveryConfirmed: true,
    },
    take: 500, // cap per-chain to avoid long-running runs
  })

  const totalOrders = orders.length
  let ordersChecked = 0

  for (const order of orders) {
    try {
      if (!order.deliveryTxHash) {
        discrepancies.push({
          orderId: order.id,
          type: 'delivery_tx_not_found',
          description: `Order ${order.orderRef} is 'delivered' but has no deliveryTxHash`,
        })
        ordersChecked++
        continue
      }

      // A9: verify the on-chain delivered amount matches gasAmountNative (EVM).
      // Runs for confirmed and unconfirmed orders alike — drift can exist on both.
      await checkDeliveryAmount(order, dbChain, discrepancies)

      // Skip the confirmation RPC for orders already marked confirmed.
      if (order.deliveryConfirmed) {
        ordersChecked++
        continue
      }

      // Check on-chain confirmation (best-effort; skip chains that don't support it)
      let confirmed = false
      try {
        confirmed = await checkTxConfirmed(chainId, order.deliveryTxHash)
      } catch {
        // Chain doesn't support confirmation check (SOL/TON/SUI stubs) — skip
        ordersChecked++
        continue
      }

      if (!confirmed) {
        discrepancies.push({
          orderId: order.id,
          type: 'delivery_tx_not_found',
          description: `Order ${order.orderRef} delivery tx ${order.deliveryTxHash} not confirmed on-chain`,
        })
      }

      ordersChecked++
    } catch (err) {
      logger.warn({ err, orderId: order.id }, 'Reconciliation: error checking order')
    }
  }

  return { totalOrders, ordersChecked, discrepancies }
}

// ── Detect stuck `sending` orders ─────────────────────────────────────────────

async function detectStuckSending(chain?: GasChain) {
  const cutoff = new Date(Date.now() - STUCK_SENDING_MIN * 60 * 1000)

  const stuck = await db.gasFeeOrder.findMany({
    where: {
      status: 'sending',
      updatedAt: { lt: cutoff },
      ...(chain ? { chain } : {}),
    },
    select: { id: true, orderRef: true, chain: true, updatedAt: true },
    take: 50,
  })

  return stuck.map((o) => ({
    orderId: o.id,
    type: 'stuck_sending',
    description: `Order ${o.orderRef} (${o.chain}) has been in 'sending' state since ${o.updatedAt.toISOString()}`,
  }))
}

// ── Detect payments recorded in DB but missing on-chain (A9) ──────────────────
// Orders we advanced past payment_pending must have a real inbound payment tx.
// Verifies the payment tx exists on its payment network (EVM only — BEP20/ERC20).
async function detectPaymentNotOnChain() {
  const discrepancies: Array<{ orderId?: string; type: string; description: string }> = []
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

  const orders = await db.gasFeeOrder.findMany({
    where: {
      status: { in: ['payment_detected', 'sending', 'delivered'] },
      paymentTxHash: { not: null },
      paymentNetwork: { in: Object.keys(PAYMENT_NETWORK_TO_SLUG) },
      createdAt: { gte: since },
    },
    select: { id: true, orderRef: true, paymentTxHash: true, paymentNetwork: true },
    take: 500,
  })

  for (const order of orders) {
    const slug = order.paymentNetwork ? PAYMENT_NETWORK_TO_SLUG[order.paymentNetwork] : undefined
    if (!slug || !order.paymentTxHash) continue
    const rpcUrl = getRpcUrl(slug)
    if (!rpcUrl) continue
    try {
      const tx = await getTransactionByHash(rpcUrl, slug, order.paymentTxHash)
      if (!tx) {
        discrepancies.push({
          orderId: order.id,
          type: 'payment_not_on_chain',
          description: `Order ${order.orderRef} has paymentTxHash ${order.paymentTxHash} on ${order.paymentNetwork} but the tx was not found on-chain`,
        })
      }
    } catch {
      // RPC error — skip; a transient failure shouldn't raise a false discrepancy.
    }
  }

  return discrepancies
}

// ── Admin helpers ─────────────────────────────────────────────────────────────

export async function listReconciliationRuns(page = 1, limit = 20) {
  const skip = (page - 1) * limit
  const [runs, total] = await Promise.all([
    db.gasReconciliationRun.findMany({
      orderBy: { ranAt: 'desc' },
      skip,
      take: limit,
      include: { _count: { select: { discrepancies: true } } },
    }),
    db.gasReconciliationRun.count(),
  ])
  return { runs, total, page, limit }
}

export async function getReconciliationRun(id: string) {
  return db.gasReconciliationRun.findUnique({
    where: { id },
    include: { discrepancies: { orderBy: { createdAt: 'asc' } } },
  })
}

export async function resolveDiscrepancy(
  id: string,
  adminId: string,
  adminNote?: string,
) {
  if (!adminNote?.trim()) throw new Error('adminNote is required when resolving a discrepancy')
  const existing = await db.gasReconciliationDiscrepancy.findUnique({ where: { id }, select: { resolvedAt: true } })
  if (!existing) throw new Error('Discrepancy not found')
  if (existing.resolvedAt) throw new Error('Discrepancy is already resolved')
  return db.gasReconciliationDiscrepancy.update({
    where: { id },
    data: { resolvedAt: new Date(), resolvedBy: adminId, adminNote },
  })
}
