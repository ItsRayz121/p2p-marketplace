import { db } from '../lib/prisma'
import { AppError } from '../lib/errors'
import { getNumberConfig } from './platformFlags.service'
import type { TradeStatus, CtmTradeStatus } from '@prisma/client'

/**
 * Per-user concurrent-trade limit — anti-scam control. A user who can hold many
 * in-progress trades at once can collect payment from several counterparties and
 * never deliver. We cap the number of simultaneously active trades a user is a
 * party to (buyer OR seller), counting USDT + CTM together, and drop the cap
 * while they have an unresolved dispute against them.
 *
 * Always on (not flag-gated). Admin-tunable via PlatformConfig:
 *   - max_concurrent_trades                (default 3; 0 = unlimited)
 *   - max_concurrent_trades_with_dispute   (default 1; 0 = unlimited)
 */

// In-progress statuses (a trade still needs action from someone).
const USDT_ACTIVE = ['payment_pending', 'payment_uploaded', 'payment_confirmed', 'crypto_sent'] as unknown as TradeStatus[]
const CTM_ACTIVE = ['awaiting_payment', 'payment_uploaded', 'payment_confirmed', 'seller_transferring', 'proof_submitted', 'buyer_confirming'] as unknown as CtmTradeStatus[]

/** Count the user's in-progress trades across both marketplaces. */
export async function countActiveTrades(userId: string): Promise<number> {
  const [usdt, ctm] = await Promise.all([
    db.trade.count({ where: { OR: [{ buyerId: userId }, { sellerId: userId }], status: { in: USDT_ACTIVE } } }),
    db.ctmTrade.count({ where: { OR: [{ buyerId: userId }, { sellerId: userId }], status: { in: CTM_ACTIVE } } }),
  ])
  return usdt + ctm
}

/** True if the user is a party to any currently-disputed trade (USDT or CTM). */
export async function hasOpenDispute(userId: string): Promise<boolean> {
  const [usdt, ctm] = await Promise.all([
    db.trade.count({ where: { OR: [{ buyerId: userId }, { sellerId: userId }], status: 'disputed' } }),
    db.ctmTrade.count({ where: { OR: [{ buyerId: userId }, { sellerId: userId }], status: 'disputed' } }),
  ])
  return usdt + ctm > 0
}

/**
 * Test/staff accounts that bypass the concurrency cap entirely. Admin-managed via
 * the PlatformConfig key `trade_limit_bypass_user_ids` (comma-separated). Accepts
 * either user IDs or usernames for convenience. Read live (no cache) so adding /
 * removing an account takes effect immediately. Empty list = nobody bypasses, so
 * the cap behaves exactly as before for real users.
 */
async function isTradeLimitBypassed(userId: string): Promise<boolean> {
  const row = await db.platformConfig.findUnique({ where: { key: 'trade_limit_bypass_user_ids' } })
  if (!row?.value) return false
  const tokens = row.value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  if (tokens.length === 0) return false
  if (tokens.includes(userId.toLowerCase())) return true
  // Fall back to matching by username so an admin can type "awazedil223" instead of a cuid.
  const user = await db.user.findUnique({ where: { id: userId }, select: { username: true } })
  return !!user?.username && tokens.includes(user.username.toLowerCase())
}

/** The user's effective cap right now (lower while they have an open dispute). */
export async function effectiveTradeCap(userId: string): Promise<number> {
  const [normal, withDispute, disputed] = await Promise.all([
    getNumberConfig('max_concurrent_trades', 3),
    getNumberConfig('max_concurrent_trades_with_dispute', 1),
    hasOpenDispute(userId),
  ])
  return disputed ? withDispute : normal
}

/**
 * Throw if opening a new trade would put `userId` over their concurrency cap.
 * `subject` tailors the message: 'self' = the user starting the trade,
 * 'counterparty' = the other party (e.g. the ad owner is too busy).
 */
export async function assertCanOpenTrade(userId: string, subject: 'self' | 'counterparty' = 'self'): Promise<void> {
  if (await isTradeLimitBypassed(userId)) return // test/staff account — exempt from the cap
  const cap = await effectiveTradeCap(userId)
  if (cap <= 0) return // 0 = unlimited
  const active = await countActiveTrades(userId)
  if (active < cap) return

  if (subject === 'counterparty') {
    throw new AppError(
      'COUNTERPARTY_TOO_MANY_TRADES',
      'This trader already has the maximum number of active trades right now. Please try again shortly or pick another offer.',
      429,
    )
  }
  const disputeNote = (await hasOpenDispute(userId))
    ? ' Your limit is reduced while you have an open dispute — resolve it to lift the limit.'
    : ''
  throw new AppError(
    'TOO_MANY_OPEN_TRADES',
    `You can have ${cap} active trade${cap === 1 ? '' : 's'} at a time.${disputeNote} Finish a current trade first.`,
    429,
  )
}
