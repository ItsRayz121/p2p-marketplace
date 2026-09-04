/**
 * CTM settlement flow resolver (Phase 1) — the pure, side-effect-free core of the
 * taker-first BUY-listing reorder for the Community Token Market.
 *
 * This is the CTM twin of `settlementFlow.ts`. The USDT flow has FOUR actions over
 * a five-rung ladder; CTM has FIVE actions over a six-rung ladder because the
 * crypto-send leg is split into two on-chain steps (the seller marks the transfer
 * started, then uploads the transfer proof with on-chain verification). So CTM
 * cannot reuse the USDT resolver — it needs its own action set and ladder.
 *
 * SAME KEY INSIGHT as the USDT flow: the ACTOR and ARTIFACT of each action are
 * INVARIANT — the buyer always pays fiat and receives crypto; the seller always
 * sends crypto (in two steps) and receives fiat. Only the ORDER of the five actions
 * flips between classic (fiat-first) and taker-first (crypto-first). So the
 * transition endpoints keep their existing actor checks unchanged; only the status
 * a given action transitions FROM/TO, and which action is terminal, depend on
 * `takerFirst`.
 *
 * The six trade statuses are a fixed ladder; each step climbs one rung:
 *   awaiting_payment → payment_uploaded → payment_confirmed
 *     → seller_transferring → proof_submitted → completed
 *
 * Deliberately dependency-free and fully unit-tested (ctmSettlementFlow.test.ts).
 */

export type CtmFlowAction = 'send_fiat' | 'confirm_fiat' | 'start_crypto' | 'prove_crypto' | 'confirm_crypto'
export type CtmFlowActor = 'buyer' | 'seller'

export const CTM_STATUS_LADDER = [
  'awaiting_payment',
  'payment_uploaded',
  'payment_confirmed',
  'seller_transferring',
  'proof_submitted',
  'completed',
] as const
export type CtmLadderStatus = (typeof CTM_STATUS_LADDER)[number]

export interface CtmFlowStep {
  index: number // 0..4
  action: CtmFlowAction
  actor: CtmFlowActor
  from: CtmLadderStatus
  to: CtmLadderStatus
  terminal: boolean // true when this step completes the trade (to === 'completed')
}

/**
 * The actor for each action is INVARIANT across both flows:
 *   - fiat is always paid by the buyer and confirmed (received) by the seller
 *   - crypto is always sent by the seller (start + prove) and confirmed by the buyer
 */
const ACTOR: Record<CtmFlowAction, CtmFlowActor> = {
  send_fiat: 'buyer',
  confirm_fiat: 'seller',
  start_crypto: 'seller',
  prove_crypto: 'seller',
  confirm_crypto: 'buyer',
}

/** Action order for each flow. */
const CLASSIC_ORDER: CtmFlowAction[] = ['send_fiat', 'confirm_fiat', 'start_crypto', 'prove_crypto', 'confirm_crypto']
const TAKER_FIRST_ORDER: CtmFlowAction[] = ['start_crypto', 'prove_crypto', 'confirm_crypto', 'send_fiat', 'confirm_fiat']

/** The ordered five steps for a trade, given whether it uses taker-first ordering. */
export function ctmFlowSteps(takerFirst: boolean): CtmFlowStep[] {
  const order = takerFirst ? TAKER_FIRST_ORDER : CLASSIC_ORDER
  return order.map((action, index) => ({
    index,
    action,
    actor: ACTOR[action],
    from: CTM_STATUS_LADDER[index]!,
    to: CTM_STATUS_LADDER[index + 1]!,
    terminal: index === order.length - 1,
  }))
}

/** The step performing a given action in this flow (throws if not found). */
export function ctmStepForAction(takerFirst: boolean, action: CtmFlowAction): CtmFlowStep {
  const step = ctmFlowSteps(takerFirst).find((s) => s.action === action)
  if (!step) throw new Error(`No CTM step for action ${action}`)
  return step
}

/** The step that transitions OUT of a given status (undefined for terminal/unknown). */
export function ctmStepFromStatus(takerFirst: boolean, from: string): CtmFlowStep | undefined {
  return ctmFlowSteps(takerFirst).find((s) => s.from === from)
}

/** The actor role that performs an action (flow-independent). */
export function ctmActorForAction(action: CtmFlowAction): CtmFlowActor {
  return ACTOR[action]
}

/** True when performing `action` in this flow completes the trade. */
export function ctmIsTerminalAction(takerFirst: boolean, action: CtmFlowAction): boolean {
  return ctmStepForAction(takerFirst, action).terminal
}

/**
 * Dispute-lock rule. Once a party has CONFIRMED receipt of the counterparty's leg,
 * their only remaining obligation is to deliver their own — letting them "dispute
 * instead of delivering" is a pure stall/grief lever, so they're barred from
 * self-disputing from that point on (recourse = human support).
 *
 * The locked party is the actor of the NON-terminal confirm action (there is
 * exactly one per flow: the other confirm action IS the terminal step and has no
 * obligation after it). They are locked for every status at or after that confirm's
 * landing status, up to but excluding `completed`.
 *
 *   - classic:      seller confirmed the fiat → locked from `payment_confirmed`
 *                   (seller still owes the two crypto-send steps)
 *   - taker-first:  buyer confirmed the crypto → locked from `seller_transferring`
 *                   (buyer/maker still owes the fiat payment)
 */
export function ctmDisputeLock(takerFirst: boolean): { actor: CtmFlowActor; lockedStatuses: CtmLadderStatus[] } {
  const confirm = ctmFlowSteps(takerFirst).find(
    (s) => (s.action === 'confirm_fiat' || s.action === 'confirm_crypto') && !s.terminal,
  )!
  const fromIdx = CTM_STATUS_LADDER.indexOf(confirm.to)
  // From the confirm's landing status up to (but not including) `completed`.
  const lockedStatuses = CTM_STATUS_LADDER.slice(fromIdx, CTM_STATUS_LADDER.length - 1)
  return { actor: confirm.actor, lockedStatuses }
}

/**
 * Human-readable status meaning for a given flow — for UI labels / notifications
 * that must read correctly in a crypto-first flow (where "awaiting_payment" means
 * "waiting for the taker to send crypto", not "waiting for fiat").
 */
export function ctmStatusMeaning(takerFirst: boolean, status: string): {
  waitingOn: CtmFlowActor | null
  action: CtmFlowAction | null
} {
  const step = ctmStepFromStatus(takerFirst, status)
  if (!step) return { waitingOn: null, action: null }
  return { waitingOn: step.actor, action: step.action }
}

/**
 * How long the actor pending at a rung has, once ctm.trade.service.ts's own
 * entering-transition stamps their deadline — keyed by the PENDING action (the
 * one `ctmStepFromStatus` returns for that rung), not by the rung name, since the
 * same rung name is reached by a different action depending on the flow. Mirrors
 * the literals hardcoded at each transition (uploadPaymentProof, confirmPayment,
 * markSellerTransferring, uploadTokenProof, confirmReceipt) — kept here as the one
 * place both a fresh entry and a dispute-resume can look the window up from.
 */
const RESUME_DEADLINE_WINDOW: Partial<Record<CtmFlowAction, { field: 'proofDeadlineAt' | 'confirmDeadlineAt'; minutes: number }>> = {
  confirm_fiat:   { field: 'proofDeadlineAt', minutes: 60 },
  start_crypto:   { field: 'proofDeadlineAt', minutes: 60 },
  prove_crypto:   { field: 'proofDeadlineAt', minutes: 120 },
  confirm_crypto: { field: 'confirmDeadlineAt', minutes: 30 },
  send_fiat:      { field: 'proofDeadlineAt', minutes: 60 },
}

/**
 * The deadline patch a rung needs when handed back to the parties after a
 * no-fault dispute dismissal (or any other "resume this rung fresh" call site).
 * `awaiting_payment` and `completed` return `{}` — the first is governed by
 * `expiresAt` (a different mechanism), never proof/confirm deadlines, and is
 * unreachable via dispute-resume anyway (openDispute excludes it); the second is
 * terminal and has none.
 */
export function ctmResumeDeadline(takerFirst: boolean, rung: string): { proofDeadlineAt?: Date; confirmDeadlineAt?: Date } {
  // Explicit, not incidental: awaiting_payment's pending action (send_fiat or
  // start_crypto, depending on flow) DOES have a RESUME_DEADLINE_WINDOW entry, so
  // without this guard the lookup below would arm a proof deadline on a rung that
  // must only ever be governed by `expiresAt`.
  if (rung === 'awaiting_payment' || rung === 'completed') return {}
  const step = ctmStepFromStatus(takerFirst, rung)
  if (!step) return {}
  const window = RESUME_DEADLINE_WINDOW[step.action]
  if (!window) return {}
  return { [window.field]: new Date(Date.now() + window.minutes * 60 * 1000) }
}
