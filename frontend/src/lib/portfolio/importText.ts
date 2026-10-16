import type { AttentionReason } from './types'

/** Plain-language reasons a RupChain trade was not added automatically. */
export const ATTENTION_TEXT: Record<AttentionReason, string> = {
  in_progress: 'still in progress (it will be added once it is completed and confirmed)',
  disputed: 'in or after a dispute',
  admin_completed: 'completed by an administrator rather than confirmed by the buyer',
  auto_completed: 'closed automatically because the buyer never confirmed receipt',
  unverified_transfer: 'on-chain settlement without a verified token transfer',
  invalid_amounts: 'amounts that could not be read safely',
}

/** Why an imported entry is shown but not counted. */
export const VOID_TEXT: Record<string, string> = {
  ...ATTENTION_TEXT,
  trade_missing: 'the trade could no longer be found',
}