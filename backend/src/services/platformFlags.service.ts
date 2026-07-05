import { db } from '../lib/prisma'

/**
 * Centralized boolean feature flags backed by the PlatformConfig key/value store.
 *
 * Every flag defaults to the SAFE / current-production behavior, so a missing
 * key NEVER changes how production behaves. A flag only takes effect once a
 * super-admin explicitly sets it via `PATCH /admin/config { key, value:"true" }`.
 *
 * This is how the non-custodial P2P rebuild ships incrementally: each phase
 * lands behind a flag that is OFF by default, so pushing to main / auto-deploy
 * does not alter live trading until the flag is flipped.
 */
export const FLAGS = {
  /**
   * Non-custodial P2P mode. When ON, the platform stops requiring/locking
   * on-platform USDT for sell ads and relies on KYC + identity + reputation +
   * dispute for protection instead. OFF (default) = current custodial escrow.
   */
  NONCUSTODIAL_P2P: 'noncustodial_p2p_enabled',
  /**
   * Maker collateral bond (non-custodial Phase 5). When ON, opening a trade
   * locks a USDT bond (default 10% of trade size) from the maker's deposited
   * balance; it is released on a clean close and seized to the victim if the
   * maker loses a dispute. OFF (default) = no bond, current behavior.
   */
  MAKER_BOND: 'maker_bond_enabled',
  /**
   * Gas-Payment promo/referral system master switch. When ON, promo codes and
   * referral rewards may be applied to gas orders — but ONLY ever drawing from
   * the platform margin, never the base gas cost. OFF (default) = no promo/
   * referral logic runs; gas orders behave exactly as they do today.
   */
  GAS_PROMO: 'gas_promo_enabled',
  /**
   * Admin-issued free-gas deliveries. When ON, a super-admin can issue a fully
   * platform-funded gas delivery to a specific user (paymentAmount 0, base+margin
   * covered). OFF (default) = the free-deliver endpoint is rejected, so no free gas
   * can be sent even by an admin until this is deliberately enabled.
   */
  GAS_FREE_GRANT: 'gas_free_grant_enabled',
  /**
   * Gas referral program. When ON, a user can get a referral code, a referred user
   * is bound first-touch, and each delivered paid gas order by a referred user
   * accrues referralPct × the realized platform margin to the referrer's balance
   * (paid FROM margin, never base cost; free-grant orders never accrue). OFF
   * (default) = no binding, no accrual; gas orders behave exactly as today.
   */
  GAS_REFERRAL: 'gas_referral_enabled',
  /**
   * Gas giveaway campaigns (KOL draws). When ON, users can enter a KOL campaign
   * with their receiving address and an admin can draw winners — free gas is then
   * delivered to the selected addresses (platform-funded, like a Phase 3 grant).
   * OFF (default) = entry + draw endpoints are rejected; nothing is sent.
   */
  GAS_GIVEAWAY: 'gas_giveaway_enabled',
  /**
   * Self-service affiliate program (Phase 5, extends gas referrals). When ON, a user
   * can apply to become an affiliate (submitting social profiles); a super-admin
   * approves and sets margin caps. Approved affiliates' referral links BOTH auto-
   * discount the bound buyer AND pay the affiliate a commission — both drawn from the
   * platform margin only, never below base gas cost. OFF (default) = no application,
   * approval, or buyer auto-discount runs; referral codes behave exactly as today.
   */
  GAS_AFFILIATE: 'gas_affiliate_enabled',
  /**
   * Airdrop / points loyalty system master switch. When ON, platform activity
   * (USDT/CTM trades, Gas orders, referrals, streak) accrues non-transferable
   * points into the append-only AirdropLedger, and the Airdrop tab unlocks. OFF
   * (default) = no points are ever awarded and the tab shows a "Coming soon"
   * locked state, even though it is visible in the account dropdown.
   */
  AIRDROP: 'airdrop_enabled',
  /**
   * SILENT point accrual. Deliberately DECOUPLED from `airdrop_enabled` (which
   * gates the user-facing UI): when this is ON, platform activity keeps writing
   * points into the append-only AirdropLedger in the background even while the
   * Airdrop is hidden from users — so that when the airdrop is later revealed,
   * balances already reflect real history. Unlike every other flag this defaults
   * ON, because accrual ONLY writes ledger rows and never touches funds, fees, or
   * UI (level fee-discounts stay separately gated by `airdrop_levels_enabled`).
   * Set `airdrop_accrual_enabled=false` to stop background counting.
   */
  AIRDROP_ACCRUAL: 'airdrop_accrual_enabled',
  /**
   * Airdrop LEVEL fee discounts. When ON (and airdrop_enabled is ON), a user's
   * airdrop level grants a margin-only discount on gas orders (capped, floored at
   * the base cost — never a subsidy). OFF (default) = levels are display-only and
   * fees are exactly as today. Separate from AIRDROP so points can accrue for
   * weeks before any discount goes live.
   */
  AIRDROP_LEVELS: 'airdrop_levels_enabled',
  /**
   * Community / influencer giveaways (task-gated address collection, off-platform
   * reward). When ON, affiliates and admins can create PromoGiveaway campaigns
   * from the Referral page and users can enter them. No platform funds are ever
   * moved — the creator distributes the reward and exports entrant addresses as
   * CSV. OFF (default) = create + entry endpoints are rejected.
   */
  PROMO_GIVEAWAY: 'promo_giveaway_enabled',
  /**
   * Taker-sends-first settlement order. When ON, the party RESPONDING to an ad
   * (the taker) always transfers their leg FIRST and the ad owner (the merchant)
   * always moves second — in BOTH directions:
   *   - SELL ad (merchant sells USDT/CTM): taker sends fiat first → merchant releases.
   *     This is already the flow today, so the flag doesn't change it.
   *   - BUY ad (merchant buys USDT/CTM): taker (the crypto seller) sends crypto
   *     FIRST, then the merchant pays fiat. This FLIPS the current buy-ad order
   *     (where the merchant/buyer pays fiat first).
   * Rationale: merchants are KYC'd + known; takers may be unknown/no-KYC, so the
   * unknown party locks their leg first and the trusted party moves second.
   * OFF (default) = current per-side order, so pushing to main is a no-op until
   * a super-admin flips it. Applies to both USDT and CTM. See settlementMode.service.
   */
  TAKER_FIRST_SETTLEMENT: 'taker_first_settlement_enabled',
  /**
   * No-KYC taker access. When ON, an un-verified user may TAKE trades (respond to
   * someone else's ad) without KYC, subject to hard PKR limits (per-trade, daily,
   * and a rolling lifetime ceiling that forces KYC once crossed) and a single
   * open-trade cap. Creating an ad ALWAYS still requires approved KYC — this only
   * relaxes the taker-side gate. OFF (default) = KYC required to trade, exactly as
   * today. Applies to both USDT and CTM. Limits are read from PlatformConfig:
   *   - nokyc_max_per_trade_pkr        (default 20000)
   *   - nokyc_max_daily_pkr            (default 60000)
   *   - nokyc_rolling_ceiling_pkr      (default 150000; lifetime no-KYC volume)
   *   - nokyc_max_open_trades          (default 1)
   */
  NOKYC_TAKER: 'nokyc_taker_enabled',
  /**
   * Persistent counterparty messaging inbox (Phase 4). When ON, trade lifecycle
   * events accrue a per-pair ChatThread + TradeEpisode history and the "Messaging"
   * inbox (dropdown + pages) is revealed. OFF (default) = no thread/episode writes
   * happen and the inbox is hidden, so deploying is a no-op. Trade-gated regardless:
   * threads only ever form between users who have actually traded.
   */
  MESSAGING_INBOX: 'messaging_inbox_enabled',
  /**
   * Admin notification EMAIL channel. When ON, critical admin notifications
   * (email-eligible ones — withdrawal failures, reverted txs, unattributed
   * deposits) are ALSO emailed to ADMIN_ALERT_EMAIL, on top of the in-app bell,
   * web push, and Telegram DM. OFF (default) = no admin notification emails are
   * sent, so the feature costs nothing on Resend until deliberately enabled.
   * Kept minimal on purpose — only payloads marked `email: true` ever email.
   */
  ADMIN_EMAIL_NOTIFS: 'admin_email_notifs_enabled',
  /**
   * USDT as an alternative payment currency in the Community Token Market. When
   * ON (AND the CTM_USDT_PAYMENT_READY code gate is true — see
   * ctm/ctm.usdtPayment.ts), a CTM listing may be priced/settled in USDT instead
   * of PKR, with the buyer paying the seller via the same delivery methods as the
   * USDT market: on-chain (BEP20 / Aptos) or an exchange internal transfer
   * (Binance/OKX/…). OFF (default) = CTM is PKR-only exactly as today; the new
   * schema columns stay at their defaults and no USDT-payment code path runs, so
   * pushing to main / auto-deploy changes nothing until deliberately flipped.
   */
  CTM_USDT_PAYMENT: 'ctm_usdt_payment_enabled',
} as const

export type FlagKey = (typeof FLAGS)[keyof typeof FLAGS]

// Small in-memory TTL cache so hot paths don't hit the DB on every check.
// 15s is short enough that an admin flag flip propagates almost immediately.
const TTL_MS = 15_000
const cache = new Map<string, { value: boolean; expires: number }>()

/** A config value counts as "true" when it is exactly "true" or "1". */
function parseFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  return value === 'true' || value === '1'
}

export async function isFlagEnabled(key: FlagKey, fallback = false): Promise<boolean> {
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && hit.expires > now) return hit.value

  const row = await db.platformConfig.findUnique({ where: { key } })
  const value = parseFlag(row?.value, fallback)
  cache.set(key, { value, expires: now + TTL_MS })
  return value
}

/** Drop the in-memory cache (call after an admin flag flip, or in tests). */
export function clearFlagCache(): void {
  cache.clear()
}

/** Read a numeric PlatformConfig value, falling back when missing/invalid. */
export async function getNumberConfig(key: string, fallback: number): Promise<number> {
  const row = await db.platformConfig.findUnique({ where: { key } })
  if (!row) return fallback
  const n = parseFloat(row.value)
  return Number.isFinite(n) ? n : fallback
}

/**
 * Read a boolean PlatformConfig value by ARBITRARY key (not one of the typed
 * FLAGS), falling back when the key is missing. Uncached — use for cold-path
 * config like `airdrop_require_kyc`, not hot per-request checks.
 */
export async function getBoolConfig(key: string, fallback: boolean): Promise<boolean> {
  const row = await db.platformConfig.findUnique({ where: { key } })
  return parseFlag(row?.value, fallback)
}
