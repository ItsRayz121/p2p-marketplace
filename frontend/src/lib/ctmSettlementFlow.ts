// Frontend mirror of the backend CTM settlement flow resolver (keep in sync with
// backend/src/services/ctmSettlementFlow.ts). Pure; used to render the right action
// for the right party at each status in both the classic and taker-first CTM flows.
//
// CTM has FIVE actions over a SIX-rung ladder (the crypto-send leg is two steps:
// the seller marks the transfer started, then submits proof). The ACTOR + ARTIFACT
// of each action are invariant (buyer pays fiat & confirms crypto; seller sends
// crypto in two steps & confirms fiat) — only the ORDER flips between flows.

export type CtmFlowAction = 'send_fiat' | 'confirm_fiat' | 'start_crypto' | 'prove_crypto' | 'confirm_crypto'
export type CtmFlowActor = 'buyer' | 'seller'

const LADDER = [
  'awaiting_payment', 'payment_uploaded', 'payment_confirmed', 'seller_transferring', 'proof_submitted', 'completed',
] as const

const ACTOR: Record<CtmFlowAction, CtmFlowActor> = {
  send_fiat: 'buyer',
  confirm_fiat: 'seller',
  start_crypto: 'seller',
  prove_crypto: 'seller',
  confirm_crypto: 'buyer',
}

const CLASSIC: CtmFlowAction[] = ['send_fiat', 'confirm_fiat', 'start_crypto', 'prove_crypto', 'confirm_crypto']
const TAKER_FIRST: CtmFlowAction[] = ['start_crypto', 'prove_crypto', 'confirm_crypto', 'send_fiat', 'confirm_fiat']

export interface CtmCurrentStep {
  action: CtmFlowAction
  actor: CtmFlowActor
  index: number
  terminal: boolean
}

/** Ordered list of actions for the flow — index === the ladder rung each action
 *  lands on. Lets the trade room order/state its step cards by the real flow. */
export function ctmFlowOrder(takerFirst: boolean): CtmFlowAction[] {
  return [...(takerFirst ? TAKER_FIRST : CLASSIC)]
}

/** Dispute lock (mirror of backend ctmDisputeLock): once a party CONFIRMS the
 *  counterparty's leg, their only job left is to deliver their own — so they can't
 *  "dispute instead of delivering". Returns the locked actor + the statuses they're
 *  barred from at. Classic locks the SELLER from payment_confirmed; taker-first
 *  locks the BUYER/maker from seller_transferring. */
export function ctmDisputeLock(takerFirst: boolean): { actor: CtmFlowActor; lockedStatuses: string[] } {
  const orderArr = takerFirst ? TAKER_FIRST : CLASSIC
  // First NON-terminal confirm action (terminal = last rung, index 4).
  const confirmIdx = orderArr.findIndex((a, i) => (a === 'confirm_fiat' || a === 'confirm_crypto') && i < orderArr.length - 1)
  // Its landing status is the next rung; lock from there up to (excl.) 'completed'.
  const lockedStatuses = [...LADDER.slice(confirmIdx + 1, LADDER.length - 1)]
  return { actor: ACTOR[orderArr[confirmIdx]!], lockedStatuses }
}

/** The pending step for an in-progress trade, or null if terminal/unknown status. */
export function ctmCurrentStep(takerFirst: boolean, status: string): CtmCurrentStep | null {
  const idx = LADDER.indexOf(status as (typeof LADDER)[number])
  if (idx < 0 || idx > 4) return null // completed/cancelled/disputed/expired/etc.
  const action = (takerFirst ? TAKER_FIRST : CLASSIC)[idx]!
  return { action, actor: ACTOR[action], index: idx, terminal: idx === 4 }
}

/** Short human label for what a party is (or the counterparty is) about to do. */
export const CTM_ACTION_VERB: Record<CtmFlowAction, string> = {
  send_fiat: 'send the PKR payment and upload proof',
  confirm_fiat: 'confirm the PKR payment arrived',
  start_crypto: 'start sending the tokens',
  prove_crypto: 'submit the token transfer proof',
  confirm_crypto: 'confirm the tokens arrived',
}

/** Concise step title (for the stepwise action header, e.g. "Step 3 of 6 · …"). */
export const CTM_ACTION_TITLE: Record<CtmFlowAction, string> = {
  send_fiat: 'Send Payment',
  confirm_fiat: 'Confirm Payment Received',
  start_crypto: 'Send Tokens',
  prove_crypto: 'Submit Transfer Proof',
  confirm_crypto: 'Confirm Tokens Received',
}
