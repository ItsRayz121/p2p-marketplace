// Frontend mirror of the backend settlementFlow resolver (keep in sync with
// backend/src/services/settlementFlow.ts). Pure, used to render the right action
// for the right party at each status in both the classic and taker-first flows.
//
// The five-status ladder is climbed one rung per step. The ACTOR + ARTIFACT of
// each action are invariant (buyer pays fiat & confirms crypto; seller sends
// crypto & confirms fiat) — only the ORDER flips between flows.

export type FlowAction = 'send_fiat' | 'confirm_fiat' | 'send_crypto' | 'confirm_crypto'
export type FlowActor = 'buyer' | 'seller'

const LADDER = ['payment_pending', 'payment_uploaded', 'payment_confirmed', 'crypto_sent', 'crypto_released'] as const

const ACTOR: Record<FlowAction, FlowActor> = {
  send_fiat: 'buyer',
  confirm_fiat: 'seller',
  send_crypto: 'seller',
  confirm_crypto: 'buyer',
}

const CLASSIC: FlowAction[] = ['send_fiat', 'confirm_fiat', 'send_crypto', 'confirm_crypto']
const TAKER_FIRST: FlowAction[] = ['send_crypto', 'confirm_crypto', 'send_fiat', 'confirm_fiat']

export interface CurrentStep {
  action: FlowAction
  actor: FlowActor
  index: number
  terminal: boolean
}

/** The pending step for an in-progress trade, or null if terminal/unknown status. */
export function currentStep(takerFirst: boolean, status: string): CurrentStep | null {
  const idx = LADDER.indexOf(status as (typeof LADDER)[number])
  if (idx < 0 || idx > 3) return null // completed/cancelled/disputed/etc.
  const action = (takerFirst ? TAKER_FIRST : CLASSIC)[idx]!
  return { action, actor: ACTOR[action], index: idx, terminal: idx === 3 }
}

/** Short human label for what a party is (or the counterparty is) about to do. */
export const ACTION_VERB: Record<FlowAction, string> = {
  send_fiat: 'send the PKR payment and upload proof',
  confirm_fiat: 'confirm the PKR payment arrived',
  send_crypto: 'send the crypto and submit proof',
  confirm_crypto: 'confirm the crypto arrived',
}
