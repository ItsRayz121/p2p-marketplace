/**
 * Settlement flow resolver (Phase 1) — the pure, side-effect-free core of the
 * taker-first BUY-ad reorder. It answers, for a given trade: what are the four
 * steps, in what order, who acts, and which step is terminal.
 *
 * KEY INSIGHT that makes the reorder tractable: the ACTOR and ARTIFACT of each
 * action are INVARIANT — the USDT buyer always pays fiat and receives crypto; the
 * seller always sends crypto and receives fiat. Only the ORDER of the four actions
 * flips. So the transition endpoints keep their existing actor checks unchanged;
 * only the status a given action transitions FROM/TO, and which action is terminal,
 * depend on `takerFirst`.
 *
 * The five trade statuses are a fixed ladder; each step climbs one rung:
 *   payment_pending → payment_uploaded → payment_confirmed → crypto_sent → crypto_released
 *
 * This module is deliberately dependency-free and fully unit-tested
 * (settlementFlow.test.ts). Wiring it into the transition functions is mechanical
 * and documented in docs/TAKER_FIRST_PHASE1_SPEC.md.
 */

export type FlowAction = 'send_fiat' | 'confirm_fiat' | 'send_crypto' | 'confirm_crypto'
export type FlowActor = 'buyer' | 'seller'

export const STATUS_LADDER = [
  'payment_pending',
  'payment_uploaded',
  'payment_confirmed',
  'crypto_sent',
  'crypto_released',
] as const
export type LadderStatus = (typeof STATUS_LADDER)[number]

export interface FlowStep {
  index: number // 0..3
  action: FlowAction
  actor: FlowActor
  from: LadderStatus
  to: LadderStatus
  terminal: boolean // true when this step completes the trade (to === crypto_released)
}

/**
 * The actor for each action is INVARIANT across both flows (this is the property
 * the whole reorder rests on):
 *   - fiat is always paid by the buyer and received by the seller
 *   - crypto is always sent by the seller and received (confirmed) by the buyer
 */
const ACTOR: Record<FlowAction, FlowActor> = {
  send_fiat: 'buyer',
  confirm_fiat: 'seller',
  send_crypto: 'seller',
  confirm_crypto: 'buyer',
}

/** Action order for each flow. */
const CLASSIC_ORDER: FlowAction[] = ['send_fiat', 'confirm_fiat', 'send_crypto', 'confirm_crypto']
const TAKER_FIRST_ORDER: FlowAction[] = ['send_crypto', 'confirm_crypto', 'send_fiat', 'confirm_fiat']

/** The ordered four steps for a trade, given whether it uses taker-first ordering. */
export function flowSteps(takerFirst: boolean): FlowStep[] {
  const order = takerFirst ? TAKER_FIRST_ORDER : CLASSIC_ORDER
  return order.map((action, index) => ({
    index,
    action,
    actor: ACTOR[action],
    from: STATUS_LADDER[index]!,
    to: STATUS_LADDER[index + 1]!,
    terminal: index === order.length - 1,
  }))
}

/** The step performing a given action in this flow (throws if not found). */
export function stepForAction(takerFirst: boolean, action: FlowAction): FlowStep {
  const step = flowSteps(takerFirst).find((s) => s.action === action)
  if (!step) throw new Error(`No step for action ${action}`)
  return step
}

/** The step that transitions OUT of a given status (undefined for terminal/unknown). */
export function stepFromStatus(takerFirst: boolean, from: string): FlowStep | undefined {
  return flowSteps(takerFirst).find((s) => s.from === from)
}

/** The actor role that performs an action (flow-independent). */
export function actorForAction(action: FlowAction): FlowActor {
  return ACTOR[action]
}

/** True when performing `action` in this flow completes the trade. */
export function isTerminalAction(takerFirst: boolean, action: FlowAction): boolean {
  return stepForAction(takerFirst, action).terminal
}

/**
 * Human-readable status meaning for a given flow — for UI labels / notifications
 * that must read correctly in a crypto-first flow (where "payment_pending" means
 * "waiting for the taker to send crypto", not "waiting for fiat").
 */
export function statusMeaning(takerFirst: boolean, status: string): {
  waitingOn: FlowActor | null
  action: FlowAction | null
} {
  const step = stepFromStatus(takerFirst, status)
  if (!step) return { waitingOn: null, action: null }
  return { waitingOn: step.actor, action: step.action }
}
