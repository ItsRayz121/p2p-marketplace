/**
 * Reconcile stuck "In progress" messaging episodes with the real trade state.
 *
 * WHY: the Messages inbox shows a trade as "In progress" whenever its
 * TradeEpisode row has outcome='active'. Episodes were closed by closeEpisode(),
 * which USED to no-op whenever `messaging_inbox_enabled` was OFF — so every trade
 * that reached a terminal state during a flag-OFF window left its episode frozen
 * at 'active' forever. closeEpisode() is now ungated, but the already-stuck rows
 * need a one-off backfill: that's this script.
 *
 * PASS 1 (always) — episode reconcile:
 *   For every active episode, load the real Trade / CtmTrade. If that trade is in
 *   a TERMINAL status, set the episode outcome to match + endedAt + post the
 *   "Trade X <outcome>." divider line. Orphan episodes (trade row gone) close as
 *   'cancelled'. Open disputes and genuinely mid-flow trades are left untouched.
 *
 * PASS 2 (only with --finalize-stuck) — finalize genuinely-stuck trades:
 *   Trades still sitting at the terminal-pending rung, older than --older-than
 *   days, with delivery proof and NO open dispute, are completed via the same
 *   path the auto-resolve jobs use (finalizeUsdtTrade / adminForceCompleteCtmTrade).
 *   That in turn closes their episode through pass 1's logic on the next run — or
 *   immediately, since closeEpisode() now runs. Anything disputed or missing
 *   proof is printed for manual review and never touched.
 *
 * DRY-RUN BY DEFAULT. Pass --apply to write.
 *
 * Usage:
 *   npx tsx src/scripts/reconcileTradeEpisodes.ts                       # dry run, pass 1 only
 *   npx tsx src/scripts/reconcileTradeEpisodes.ts --apply               # write pass 1
 *   npx tsx src/scripts/reconcileTradeEpisodes.ts --apply --finalize-stuck --older-than=2
 */

import 'dotenv/config'
import '../lib/env'
import { CtmTradeStatus } from '@prisma/client'
import { db } from '../lib/prisma'
import { finalizeUsdtTrade } from '../services/trade.service'
import { adminForceCompleteCtmTrade } from '../ctm/ctm.trade.service'

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const FINALIZE_STUCK = args.includes('--finalize-stuck')
const olderThanArg = args.find((a) => a.startsWith('--older-than='))
const OLDER_THAN_DAYS = olderThanArg ? Number(olderThanArg.split('=')[1]) : 2

// Terminal trade status → the episode outcome it should carry.
const USDT_TERMINAL: Record<string, 'completed' | 'cancelled' | 'expired'> = {
  crypto_released: 'completed',
  dispute_resolved: 'completed',
  cancelled: 'cancelled',
}
const CTM_TERMINAL: Record<string, 'completed' | 'cancelled' | 'expired'> = {
  completed: 'completed',
  dispute_resolved: 'completed',
  cancelled: 'cancelled',
  expired: 'expired',
}
// Non-terminal statuses that are the LAST pending rung — candidates for pass 2.
const USDT_STUCK_STATUS = 'crypto_sent'
const CTM_STUCK_STATUSES: CtmTradeStatus[] = [CtmTradeStatus.proof_submitted, CtmTradeStatus.buyer_confirming]

const OUTCOME_LABEL: Record<string, string> = {
  completed: 'completed', cancelled: 'cancelled', expired: 'expired', disputed: 'disputed',
}

async function closeEpisodeRow(ep: { id: string; threadId: string; tradeRef: string }, outcome: 'completed' | 'cancelled' | 'expired', note?: string) {
  if (!APPLY) return
  await db.tradeEpisode.update({ where: { id: ep.id }, data: { outcome, endedAt: new Date() } })
  await db.chatThreadMessage.create({
    data: {
      threadId: ep.threadId,
      senderId: '',
      isSystem: true,
      body: note ?? `Trade ${ep.tradeRef} ${OUTCOME_LABEL[outcome] ?? outcome}.`,
    },
  })
  await db.chatThread.update({ where: { id: ep.threadId }, data: { lastMessageAt: new Date() } })
}

async function pass1(): Promise<void> {
  const episodes = await db.tradeEpisode.findMany({
    where: { outcome: 'active' },
    select: { id: true, threadId: true, market: true, tradeId: true, tradeRef: true },
  })
  console.log(`\n── PASS 1: episode reconcile ──`)
  console.log(`${episodes.length} active episode(s) to inspect.`)

  const tally = { reconciled: 0, orphan: 0, stillActive: 0 }
  const stillActiveByStatus = new Map<string, number>()

  for (const ep of episodes) {
    if (ep.market === 'usdt') {
      const t = await db.trade.findUnique({ where: { id: ep.tradeId }, select: { status: true } })
      if (!t) {
        console.log(`  [orphan]  usdt ${ep.tradeRef} — trade row gone → close cancelled`)
        await closeEpisodeRow(ep, 'cancelled', `Trade ${ep.tradeRef} closed (record removed).`)
        tally.orphan++
        continue
      }
      const outcome = USDT_TERMINAL[t.status]
      if (outcome) {
        console.log(`  [close]   usdt ${ep.tradeRef} — ${t.status} → ${outcome}`)
        await closeEpisodeRow(ep, outcome)
        tally.reconciled++
      } else {
        tally.stillActive++
        stillActiveByStatus.set(`usdt:${t.status}`, (stillActiveByStatus.get(`usdt:${t.status}`) ?? 0) + 1)
      }
    } else if (ep.market === 'ctm') {
      const t = await db.ctmTrade.findUnique({ where: { id: ep.tradeId }, select: { status: true } })
      if (!t) {
        console.log(`  [orphan]  ctm ${ep.tradeRef} — trade row gone → close cancelled`)
        await closeEpisodeRow(ep, 'cancelled', `Trade ${ep.tradeRef} closed (record removed).`)
        tally.orphan++
        continue
      }
      const outcome = CTM_TERMINAL[t.status]
      if (outcome) {
        console.log(`  [close]   ctm ${ep.tradeRef} — ${t.status} → ${outcome}`)
        await closeEpisodeRow(ep, outcome)
        tally.reconciled++
      } else {
        tally.stillActive++
        stillActiveByStatus.set(`ctm:${t.status}`, (stillActiveByStatus.get(`ctm:${t.status}`) ?? 0) + 1)
      }
    } else {
      console.log(`  [skip]    unknown market "${ep.market}" on episode ${ep.id}`)
    }
  }

  console.log(`\n  reconciled: ${tally.reconciled}   orphan-closed: ${tally.orphan}   still genuinely active: ${tally.stillActive}`)
  if (stillActiveByStatus.size) {
    console.log(`  still-active breakdown:`)
    for (const [k, v] of [...stillActiveByStatus.entries()].sort()) console.log(`    ${k.padEnd(28)} ${v}`)
  }
}

async function pass2(): Promise<void> {
  const cutoff = new Date(Date.now() - OLDER_THAN_DAYS * 24 * 60 * 60 * 1000)
  console.log(`\n── PASS 2: finalize genuinely-stuck trades older than ${OLDER_THAN_DAYS}d (before ${cutoff.toISOString()}) ──`)

  // AuditLog.actorId is an FK to User — use a real admin id so the force-complete
  // audit rows actually persist (a fake "system:…" id silently fails that insert).
  const admin = await db.user.findFirst({
    where: { role: { in: ['super_admin', 'admin'] } },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  })
  const actorId = admin?.id ?? 'system:reconcile'

  // ── USDT ──────────────────────────────────────────────────────────────────
  const usdtStuck = await db.trade.findMany({
    where: { status: USDT_STUCK_STATUS, updatedAt: { lt: cutoff } },
    select: { id: true, orderRef: true, sellerTxHash: true, sellerDeliveryProofUrl: true, dispute: { select: { status: true } } },
    orderBy: { updatedAt: 'asc' },
  })
  console.log(`\n  USDT: ${usdtStuck.length} trade(s) in ${USDT_STUCK_STATUS} older than cutoff.`)
  let usdtDone = 0
  for (const t of usdtStuck) {
    const hasProof = !!t.sellerTxHash || !!t.sellerDeliveryProofUrl
    const disputeOpen = t.dispute && t.dispute.status !== 'resolved'
    if (disputeOpen) { console.log(`  [review]  usdt ${t.orderRef} — has an open dispute, skipping`); continue }
    if (!hasProof)   { console.log(`  [review]  usdt ${t.orderRef} — NO delivery proof, skipping`); continue }
    if (!APPLY)      { console.log(`  [would]   usdt ${t.orderRef} — finalizeUsdtTrade`); usdtDone++; continue }
    try {
      await finalizeUsdtTrade(t.id)
      console.log(`  [done]    usdt ${t.orderRef} — finalized`)
      usdtDone++
    } catch (err) {
      console.log(`  [error]   usdt ${t.orderRef} — ${(err as Error).message}`)
    }
  }

  // ── CTM ───────────────────────────────────────────────────────────────────
  const ctmStuck = await db.ctmTrade.findMany({
    where: { status: { in: CTM_STUCK_STATUSES }, updatedAt: { lt: cutoff } },
    select: { tradeRef: true, displayRef: true, status: true, dispute: { select: { status: true } } },
    orderBy: { updatedAt: 'asc' },
  })
  console.log(`\n  CTM: ${ctmStuck.length} trade(s) in ${CTM_STUCK_STATUSES.join('/')} older than cutoff.`)
  let ctmDone = 0
  for (const t of ctmStuck) {
    const ref = t.displayRef ?? t.tradeRef
    const disputeOpen = t.dispute && t.dispute.status !== 'resolved'
    if (disputeOpen) { console.log(`  [review]  ctm ${ref} — has an open dispute, skipping`); continue }
    if (!APPLY)      { console.log(`  [would]   ctm ${ref} (${t.status}) — force-complete`); ctmDone++; continue }
    try {
      await adminForceCompleteCtmTrade({ tradeRef: t.tradeRef, adminId: actorId, reason: `Auto-finalized: stuck in ${t.status} > ${OLDER_THAN_DAYS}d, no open dispute.` })
      console.log(`  [done]    ctm ${ref} — force-completed`)
      ctmDone++
    } catch (err) {
      console.log(`  [error]   ctm ${ref} — ${(err as Error).message}`)
    }
  }

  console.log(`\n  ${APPLY ? 'finalized' : 'would finalize'}: ${usdtDone} USDT + ${ctmDone} CTM`)
}

async function main() {
  console.log(`reconcileTradeEpisodes — ${APPLY ? 'APPLY (writing)' : 'DRY RUN (no writes)'}`)
  await pass1()
  if (FINALIZE_STUCK) await pass2()
  else console.log(`\n(pass 2 skipped — add --finalize-stuck to complete genuinely-stuck trades)`)
  console.log(`\nDone.${APPLY ? '' : '  Re-run with --apply to write.'}`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
